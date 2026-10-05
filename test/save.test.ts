import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import * as commands from "../src/commands";
import { idWords } from "../src/id";
import { taskDir, taskFile, taskLock, tasksDir } from "../src/store";
import { STATUSES } from "../src/task";
import { cleanupHomes, errorOf, tempHome, testCtx } from "./helpers";

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
  test("without id, a ref owned by an existing task matches it and overwrites nothing", () => {
    const { ctx, save, taskCount, advance } = setup();
    const created = save({ title: "Investigate", kind: "bug-investigation", refs: [PR], body: "Summary" }).task;
    advance();

    const { result, task, skipped } = save({
      title: "Written to create a task",
      kind: "review",
      status: "todo",
      body: "Another summary",
      refs: ["Example-Org/Example-Repo#482"],
    });

    expect(result).toBe("matched");
    expect(task).toEqual(created);
    expect(skipped).toEqual(["title", "kind", "status", "body"]);
    expect(commands.show(ctx, created.id).task).toEqual(created);
    expect(taskCount()).toBe(1);
  });

  test("a sync run again with status todo does not move a task back", () => {
    const { ctx, save } = setup();
    const input = { title: "Backlog item", kind: "ticket", status: "todo", refs: ["abc-1"] };
    const created = save(input).task;
    save({ id: created.id, status: "done" });

    const { result, skipped } = save(input);

    expect(result).toBe("matched");
    expect(skipped).toEqual(["status"]);
    expect(commands.show(ctx, created.id).task.status).toBe("done");
  });

  test("skipped names only the fields that differ from the stored ones", () => {
    const { save } = setup();
    save({ title: "Investigate", kind: "bug-investigation", refs: [PR], body: "Summary" });
    expect(save({ title: "Investigate", kind: "review", refs: [PR], body: "\nSummary\n" }).skipped).toEqual(["kind"]);
    expect(save({ refs: [PR] }).skipped).toEqual([]);
  });

  test("a matched save that adds a ref updates the task; one that changes no ref writes nothing", () => {
    const { ctx, save, advance } = setup();
    const created = save({ title: "Investigate", kind: "bug-investigation", refs: [PR] }).task;
    advance();

    expect(save({ refs: [PR] }).task).toEqual(created);
    expect(commands.show(ctx, created.id).task.updated).toBe(created.updated);

    const added = save({ refs: [PR, "abc-123"] }).task;
    expect(added.refs).toEqual([PR_REF, "linear:ABC-123"]);
    expect(Date.parse(added.updated)).toBe(T1.getTime());
  });

  test("created and updated saves skip nothing", () => {
    const { save } = setup();
    const created = save({ title: "t", kind: "ticket", refs: ["abc-1"] });
    expect(created.skipped).toEqual([]);
    expect(save({ id: created.task.id, title: "u", refs: ["abc-1"] }).skipped).toEqual([]);
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

  test("a matched save removes a ref too", () => {
    const { save } = setup();
    save({ title: "a", kind: "ticket", refs: ["abc-1", "abc-2"] });
    const { result, task } = save({ refs: ["abc-1"] }, ["abc-2"]);
    expect(result).toBe("matched");
    expect(task.refs).toEqual(["linear:ABC-1"]);
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

describe("status", () => {
  const statusOf = (ctx: commands.Ctx, id: string) => commands.show(ctx, id).task.status;
  const withoutBody = ({ body, ...task }: commands.TaskDetail) => task;

  test("changes only the status and updated, and leaves the other tasks alone", () => {
    const { ctx, save, advance } = setup();
    const { task } = save({ title: "t", kind: "review", refs: ["abc-123"], body: "Summary" });
    const other = save({ title: "other", kind: "review" }).task;
    advance();

    const { tasks } = commands.setStatus(ctx, "done", [task.id]);

    const after = commands.show(ctx, task.id).task;
    expect(after).toEqual({ ...task, status: "done", updated: after.updated });
    expect(Date.parse(after.updated)).toBe(T1.getTime());
    expect(tasks).toEqual([withoutBody(after)]);
    expect(commands.show(ctx, other.id).task).toEqual(other);
  });

  test("a task that already has the status is not written, so running it again does not reorder the list", () => {
    const { ctx, save, advance } = setup();
    const { task } = save({ title: "t", kind: "review" });
    advance();

    const { tasks } = commands.setStatus(ctx, "open", [task.id]);

    expect(tasks).toEqual([withoutBody(task)]);
    expect(commands.show(ctx, task.id).task).toEqual(task);
  });

  test("a task that breaks after the check stops the command; the tasks before it stay updated and a rerun leaves them alone", () => {
    const home = tempHome();
    const text = () => readFileSync(taskFile(home, second), "utf8");
    let breakSecond = false;
    let now = T0;
    // updateTask reads the clock under the task lock, after the check: the only point where a test can step in
    const ctx = testCtx({
      home,
      now: () => {
        if (breakSecond && commands.show(ctx, first).task.status === "done") {
          writeFileSync(taskFile(home, second), "not a task\n");
        }
        return now;
      },
    });
    const first = commands.save(ctx, JSON.stringify({ title: "first", kind: "review" })).task.id;
    const second = commands.save(ctx, JSON.stringify({ title: "second", kind: "review" })).task.id;
    const intact = text();

    breakSecond = true;
    expect(errorOf(() => commands.setStatus(ctx, "done", [first, second])).code).toBe("invalid_task");
    breakSecond = false;
    const afterFailure = commands.show(ctx, first).task;
    expect(afterFailure.status).toBe("done");

    writeFileSync(taskFile(home, second), intact);
    now = T1;
    commands.setStatus(ctx, "done", [first, second]);
    expect(commands.show(ctx, first).task).toEqual(afterFailure);
    expect(commands.show(ctx, second).task.status).toBe("done");
  });

  test("sets several tasks at once and returns them in the order given", () => {
    const { ctx, save } = setup();
    const ids = ["a", "b", "c"].map((title) => save({ title, kind: "review" }).task.id);

    const { tasks } = commands.setStatus(ctx, "dropped", [ids[2], idWords(ids[0])]);

    expect(tasks.map((task) => task.id)).toEqual([ids[2], ids[0]]);
    expect(ids.map((id) => statusOf(ctx, id))).toEqual(["dropped", "open", "dropped"]);
  });

  test("accepts every status", () => {
    const { ctx, save } = setup();
    const { id } = save({ title: "t", kind: "review" }).task;
    for (const status of STATUSES) {
      commands.setStatus(ctx, status, [id]);
      expect(statusOf(ctx, id)).toBe(status);
    }
  });

  test("the same task named twice is updated once", () => {
    const { ctx, save } = setup();
    const { id } = save({ title: "t", kind: "review" }).task;
    expect(commands.setStatus(ctx, "done", [id, idWords(id), id]).tasks.map((task) => task.id)).toEqual([id]);
  });

  test("an unknown ID is an error and no task is changed, wherever it comes in the arguments", () => {
    const { ctx, save } = setup();
    const { task } = save({ title: "t", kind: "review" });
    const missing = "20261001-nai-mono";
    expect(errorOf(() => commands.setStatus(ctx, "done", [task.id, missing])).code).toBe("not_found");
    expect(errorOf(() => commands.setStatus(ctx, "done", [missing, task.id])).code).toBe("not_found");
    expect(errorOf(() => commands.setStatus(ctx, "done", [task.id, "not an id"])).code).toBe("invalid_input");
    expect(commands.show(ctx, task.id).task).toEqual(task);
  });

  test("an ambiguous ID is an error and no task is changed", () => {
    const { ctx, save } = setup();
    const { task } = save({ title: "t", kind: "review" });
    const twin = save({ title: "twin", kind: "review" }).task.id;
    const other = `20260101-${idWords(twin)}`;
    mkdirSync(taskDir(ctx.home, other));
    writeFileSync(taskFile(ctx.home, other), readFileSync(taskFile(ctx.home, twin), "utf8").replace(twin, other));

    expect(errorOf(() => commands.setStatus(ctx, "done", [task.id, idWords(twin)])).code).toBe("ambiguous_id");
    expect(commands.show(ctx, task.id).task).toEqual(task);
  });

  test("a broken task.md is an error and no task is changed, wherever it comes in the arguments", () => {
    const { ctx, save } = setup();
    const { task } = save({ title: "t", kind: "review" });
    const broken = save({ title: "broken", kind: "review" }).task.id;
    writeFileSync(taskFile(ctx.home, broken), "not a task\n");
    expect(errorOf(() => commands.setStatus(ctx, "done", [task.id, broken])).code).toBe("invalid_task");
    expect(errorOf(() => commands.setStatus(ctx, "done", [broken, task.id])).code).toBe("invalid_task");
    expect(commands.show(ctx, task.id).task).toEqual(task);
  });

  test("an unknown status is an error and no task is changed", () => {
    const { ctx, save } = setup();
    const { task } = save({ title: "t", kind: "review" });
    const error = errorOf(() => commands.setStatus(ctx, "closed", [task.id]));
    expect(error.code).toBe("invalid_input");
    expect(error.message).toContain("closed");
    expect(commands.show(ctx, task.id).task).toEqual(task);
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
