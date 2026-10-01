import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import * as commands from "../src/commands";
import { idWords } from "../src/id";
import { taskFile, taskLock, tasksDir } from "../src/store";
import { cleanupHomes, errorOf, testCtx } from "./helpers";

afterEach(cleanupHomes);

const T0 = new Date(2026, 9, 1, 12, 0, 0);
const T1 = new Date(2026, 9, 1, 12, 34, 56);

function setup() {
  let now = T0;
  const ctx = testCtx({ now: () => now });
  const save = (input: Record<string, unknown>, removeRefs: string[] = []) =>
    commands.save(ctx, JSON.stringify(input), removeRefs);
  const taskCount = () => readdirSync(tasksDir(ctx.home)).length;
  return { ctx, save, taskCount, advance: () => (now = T1) };
}

const PR = "https://github.com/example-org/example-repo/pull/482";
const PR_REF = "github:example-org/example-repo#482";

describe("creating a task", () => {
  test("status defaults to open; SHU sets created and updated", () => {
    const { save } = setup();
    const { result, task } = save({ title: "Investigate", kind: "bug-investigation", refs: [PR], body: "Summary\n" });
    expect(result).toBe("created");
    expect(task).toEqual({
      id: task.id,
      title: "Investigate",
      kind: "bug-investigation",
      status: "open",
      refs: [PR_REF],
      created: task.created,
      updated: task.created,
      body: "Summary",
    });
    expect(task.id).toMatch(/^20261001-[a-z]+-[a-z]+$/);
    expect(Date.parse(task.created)).toBe(T0.getTime());
  });

  test("requires title and kind", () => {
    const { save } = setup();
    expect(errorOf(() => save({ title: "t" })).code).toBe("invalid_input");
    expect(errorOf(() => save({ kind: "ticket" })).code).toBe("invalid_input");
  });

  test("refs repeated in the input collapse to one", () => {
    const { save } = setup();
    const { task } = save({ title: "t", kind: "ticket", refs: [PR, "example-org/example-repo#482", PR_REF] });
    expect(task.refs).toEqual([PR_REF]);
  });

  test("non-ASCII text round-trips", () => {
    const { ctx, save } = setup();
    const { task } = save({ title: "café ☕ — naïve", kind: "ticket", body: "línea uno\nligne deux ✓" });
    expect(commands.show(ctx, task.id).task).toEqual(task);
    expect(task.title).toBe("café ☕ — naïve");
    expect(task.body).toBe("línea uno\nligne deux ✓");
  });
});

describe("updating by id", () => {
  test("changes only the given fields; id and created stay the same", () => {
    const { ctx, save, advance } = setup();
    const created = save({ title: "Investigate", kind: "bug-investigation", refs: [PR], body: "Summary" }).task;
    advance();

    const { result, task } = save({ id: created.id, status: "waiting" });

    expect(result).toBe("updated");
    expect(task).toEqual({ ...created, status: "waiting", updated: task.updated });
    expect(Date.parse(task.updated)).toBe(T1.getTime());
    expect(commands.show(ctx, created.id).task).toEqual(task);
  });

  test("the clock is read while the task lock is held, so a save that waited does not write an older updated", () => {
    const { ctx, save } = setup();
    const created = save({ title: "t", kind: "ticket" }).task;
    const lockedWhenRead: boolean[] = [];
    const watching = {
      ...ctx,
      now: () => {
        lockedWhenRead.push(existsSync(taskLock(ctx.home, created.id)));
        return T1;
      },
    };

    const { task } = commands.save(watching, JSON.stringify({ id: created.id, refs: ["abc-1"] }));

    expect(lockedWhenRead).toEqual([true]);
    expect(Date.parse(task.updated)).toBe(T1.getTime());
  });

  test("accepts just the words of the id", () => {
    const { save } = setup();
    const created = save({ title: "t", kind: "ticket" }).task;
    const { result, task } = save({ id: idWords(created.id), title: "u" });
    expect(result).toBe("updated");
    expect(task.id).toBe(created.id);
    expect(task.title).toBe("u");
  });

  test("an unknown id is an error and creates nothing", () => {
    const { save, taskCount } = setup();
    save({ title: "t", kind: "ticket" });
    expect(errorOf(() => save({ id: "20261001-aoi-kitsune", title: "u", kind: "ticket" })).code).toBe(
      "not_found",
    );
    expect(taskCount()).toBe(1);
  });

  test("an empty body clears the body", () => {
    const { save } = setup();
    const created = save({ title: "t", kind: "ticket", body: "Summary" }).task;
    expect(save({ id: created.id, body: "" }).task.body).toBe("");
  });
});

describe("dedupe by ref", () => {
  test("without id, a ref owned by an existing task updates that task", () => {
    const { save, taskCount } = setup();
    const created = save({ title: "Investigate", kind: "bug-investigation", refs: [PR] }).task;

    const { result, task } = save({ title: "Another spelling", kind: "review", refs: ["Example-Org/Example-Repo#482"] });

    expect(result).toBe("matched");
    expect(task.id).toBe(created.id);
    expect(task.title).toBe("Another spelling");
    expect(taskCount()).toBe(1);
  });

  test("a matched save needs neither title nor kind", () => {
    const { save } = setup();
    const created = save({ title: "Investigate", kind: "bug-investigation", refs: [PR] }).task;
    const { result, task } = save({ refs: [PR], status: "done" });
    expect(result).toBe("matched");
    expect(task).toEqual({ ...created, status: "done" });
  });

  test("refs are added, not replaced (a Slack thread grows into a ticket, then a PR)", () => {
    const { save, taskCount } = setup();
    const slack = "https://example.slack.com/archives/C000/p1700000000000000";
    save({ title: "Investigate", kind: "bug-investigation", refs: [slack] });
    save({ refs: [slack, "abc-123"] });
    const { result, task } = save({ refs: ["ABC-123", PR] });

    expect(result).toBe("matched");
    expect(task.refs).toEqual([`slack:${slack}`, "linear:ABC-123", PR_REF]);
    expect(taskCount()).toBe(1);
  });

  test("refs owned by two different tasks are an error; tasks are never merged", () => {
    const { ctx, save } = setup();
    const a = save({ title: "a", kind: "ticket", refs: ["abc-1"] }).task;
    const b = save({ title: "b", kind: "ticket", refs: ["abc-2"] }).task;

    const error = errorOf(() => save({ title: "c", kind: "ticket", refs: ["abc-1", "abc-2", "abc-3"] }));

    expect(error.code).toBe("ref_conflict");
    expect(error.details.candidates).toEqual([a.id, b.id].sort());
    expect(commands.show(ctx, a.id).task).toEqual(a);
    expect(commands.show(ctx, b.id).task).toEqual(b);
    expect(commands.list(ctx).tasks).toHaveLength(2);
  });

  test("even with id, a ref owned by another task cannot be attached", () => {
    const { ctx, save } = setup();
    const a = save({ title: "a", kind: "ticket", refs: ["abc-1"] }).task;
    const b = save({ title: "b", kind: "ticket" }).task;

    const error = errorOf(() => save({ id: b.id, title: "must not change", refs: ["abc-1"] }));

    expect(error.code).toBe("ref_conflict");
    expect(error.details.candidates).toEqual([a.id]);
    expect(commands.show(ctx, b.id).task).toEqual(b);
  });

  test("with id, every other task that owns one of the refs is reported", () => {
    const { save } = setup();
    const a = save({ title: "a", kind: "ticket" }).task;
    const b = save({ title: "b", kind: "ticket", refs: ["abc-1"] }).task;
    const c = save({ title: "c", kind: "ticket", refs: ["abc-2"] }).task;

    const error = errorOf(() => save({ id: a.id, refs: ["abc-1", "abc-2"] }));

    expect(error.code).toBe("ref_conflict");
    expect(error.details.candidates).toEqual([b.id, c.id].sort());
  });

  test("id together with that task's own ref is fine", () => {
    const { save } = setup();
    const a = save({ title: "a", kind: "ticket", refs: ["abc-1"] }).task;
    const { result, task } = save({ id: a.id, refs: ["abc-1", "abc-2"] });
    expect(result).toBe("updated");
    expect(task.refs).toEqual(["linear:ABC-1", "linear:ABC-2"]);
  });
});

describe("--remove-ref", () => {
  test("removes a ref only when asked; the ref can then go to another task", () => {
    const { save } = setup();
    const a = save({ title: "a", kind: "ticket", refs: ["abc-1", "abc-2"] }).task;

    const removed = save({ id: a.id }, ["ABC-2"]).task;
    expect(removed.refs).toEqual(["linear:ABC-1"]);

    const b = save({ title: "b", kind: "ticket", refs: ["abc-2"] });
    expect(b.result).toBe("created");
    expect(b.task.id).not.toBe(a.id);
  });

  test("the same ref in refs and --remove-ref is an error", () => {
    const { save } = setup();
    const a = save({ title: "a", kind: "ticket", refs: ["abc-1"] }).task;
    expect(errorOf(() => save({ id: a.id, refs: ["abc-1"] }, ["abc-1"])).code).toBe("invalid_input");
  });

  test("without a task to remove from, it is an error and nothing is created", () => {
    const { ctx, save } = setup();
    const a = save({ title: "a", kind: "ticket", refs: ["abc-1"] }).task;

    expect(errorOf(() => save({ title: "b", kind: "ticket" }, ["abc-1"])).code).toBe("invalid_input");
    expect(errorOf(() => save({}, ["abc-1"])).code).toBe("invalid_input");

    expect(commands.list(ctx, { all: true }).tasks).toHaveLength(1);
    expect(commands.find(ctx, "abc-1").task.id).toBe(a.id);
  });

  test("removing a ref the task does not have does nothing", () => {
    const { save } = setup();
    const a = save({ title: "a", kind: "ticket", refs: ["abc-1"] }).task;
    expect(save({ id: a.id }, ["abc-9"]).task.refs).toEqual(["linear:ABC-1"]);
  });
});

describe("find", () => {
  test("normalizes the input before matching", () => {
    const { ctx, save } = setup();
    const created = save({ title: "Investigate", kind: "bug-investigation", refs: [PR], body: "Summary" }).task;
    expect(commands.find(ctx, "Example-Org/example-repo#482")).toEqual({ task: created });
    expect(commands.find(ctx, `${PR}/files`)).toEqual({ task: created });
  });

  test("is not_found when no task owns the ref", () => {
    const { ctx, save } = setup();
    save({ title: "Investigate", kind: "bug-investigation", refs: [PR] });
    expect(errorOf(() => commands.find(ctx, "example-org/example-repo#483")).code).toBe("not_found");
  });

  test("is ref_conflict when hand-edited files put the ref on two tasks", () => {
    const { ctx, save } = setup();
    const a = save({ title: "a", kind: "ticket", refs: ["abc-1"] }).task;
    const b = save({ title: "b", kind: "ticket" }).task;
    const file = taskFile(ctx.home, b.id);
    writeFileSync(file, readFileSync(file, "utf8").replace(/---\n$/, "refs:\n  - linear:ABC-1\n---\n"));

    const error = errorOf(() => commands.find(ctx, "abc-1"));

    expect(error.code).toBe("ref_conflict");
    expect(error.details.candidates).toEqual([a.id, b.id].sort());
  });

  test("is invalid_ref when the ref cannot be normalized", () => {
    const { ctx } = setup();
    expect(errorOf(() => commands.find(ctx, "something")).code).toBe("invalid_ref");
  });
});
