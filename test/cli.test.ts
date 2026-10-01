import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as commands from "../src/commands";
import { idWords } from "../src/id";
import { cleanupHomes, create, shu, shuJson, tempHome } from "./helpers";

// Every test here starts bun subprocesses; the 5s default is too tight on a loaded machine
setDefaultTimeout(30_000);

afterEach(cleanupHomes);

const TASK_KEYS = ["id", "title", "kind", "status", "refs", "created", "updated"];
const DETAIL_KEYS = [...TASK_KEYS, "body"];

describe("--json output shape (the contract)", () => {
  test("save", async () => {
    const home = tempHome();
    const { exitCode, stderr, json } = await shuJson(
      home,
      ["save"],
      JSON.stringify({ title: "Investigate", kind: "bug-investigation", refs: ["abc-123"], body: "Summary" }),
    );
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(Object.keys(json)).toEqual(["result", "task"]);
    expect(json.result).toBe("created");
    expect(Object.keys(json.task)).toEqual(DETAIL_KEYS);
    expect(json.task).toMatchObject({
      title: "Investigate",
      kind: "bug-investigation",
      status: "open",
      refs: ["linear:ABC-123"],
      body: "Summary",
    });
  });

  test("list", async () => {
    const home = tempHome();
    const id = await create(home, { title: "t", kind: "ticket" });
    const { exitCode, json } = await shuJson(home, ["list"]);
    expect(exitCode).toBe(0);
    expect(Object.keys(json)).toEqual(["tasks"]);
    expect(Object.keys(json.tasks[0])).toEqual(TASK_KEYS);
    expect(json.tasks[0]).toMatchObject({ id, title: "t", kind: "ticket", status: "open", refs: [] });
  });

  test("list returns a tasks array even when empty", async () => {
    const { exitCode, json } = await shuJson(tempHome(), ["list"]);
    expect(exitCode).toBe(0);
    expect(json).toEqual({ tasks: [] });
  });

  test("show", async () => {
    const home = tempHome();
    const id = await create(home, { title: "t", kind: "ticket", body: "Summary" });
    await shu(home, ["log", id, "looked into it", "--author", "claude"]);
    await shu(home, ["artifact", id, "-", "--name", "brief.md"], "# brief\n");

    const { exitCode, json } = await shuJson(home, ["show", id]);

    expect(exitCode).toBe(0);
    expect(Object.keys(json)).toEqual(["task", "log", "artifacts"]);
    expect(Object.keys(json.task)).toEqual(DETAIL_KEYS);
    expect(json.log).toEqual([{ at: expect.any(String), author: "claude", message: "looked into it" }]);
    expect(json.artifacts).toEqual(["brief.md"]);
  });

  test("find", async () => {
    const home = tempHome();
    const id = await create(home, { title: "t", kind: "ticket", refs: ["abc-123"] });
    const { exitCode, json } = await shuJson(home, ["find", "--ref", "ABC-123"]);
    expect(exitCode).toBe(0);
    expect(Object.keys(json)).toEqual(["task"]);
    expect(Object.keys(json.task)).toEqual(DETAIL_KEYS);
    expect(json.task.id).toBe(id);
  });

  test("log", async () => {
    const home = tempHome();
    const id = await create(home, { title: "t", kind: "ticket" });
    const { exitCode, json } = await shuJson(home, ["log", id, "looked into it"]);
    expect(exitCode).toBe(0);
    expect(json).toEqual({ id, entry: { at: expect.any(String), author: "unknown", message: "looked into it" } });
  });

  test("artifact", async () => {
    const home = tempHome();
    const id = await create(home, { title: "t", kind: "ticket" });
    const { exitCode, json } = await shuJson(home, ["artifact", id, "-", "--name", "brief.md"], "# brief\n");
    expect(exitCode).toBe(0);
    expect(json).toEqual({ id, name: "brief.md", path: join(home, "tasks", id, "artifacts", "brief.md") });
  });

  test("path", async () => {
    const home = tempHome();
    const id = await create(home, { title: "t", kind: "ticket" });
    const { exitCode, json } = await shuJson(home, ["path", id]);
    expect(exitCode).toBe(0);
    expect(json).toEqual({ id, path: join(home, "tasks", id) });
  });
});

  test("--help and --version", async () => {
    const home = tempHome();
    const help = await shuJson(home, ["--help"]);
    expect(help.exitCode).toBe(0);
    expect(Object.keys(help.json)).toEqual(["help"]);
    expect(help.json.help).toContain("shu save");
    expect((await shuJson(home, [])).json).toEqual(help.json);

    const version = await shuJson(home, ["--version"]);
    expect(version.exitCode).toBe(0);
    expect(version.json).toEqual({ version: expect.stringMatching(/^\d+\.\d+\.\d+$/) });
  });

describe("errors", () => {
  test("with --json, only the error goes to stdout and the exit code is non-zero", async () => {
    const { exitCode, stdout, stderr } = await shu(tempHome(), ["show", "aoi-kitsune", "--json"]);
    expect(exitCode).toBe(1);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toEqual({ error: { code: "not_found", message: expect.any(String) } });
  });

  test("without --json, the error goes to stderr and stdout stays empty", async () => {
    const { exitCode, stdout, stderr } = await shu(tempHome(), ["show", "aoi-kitsune"]);
    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toStartWith("shu: ");
  });

  test("invalid_task names the broken task in error.id", async () => {
    const home = tempHome();
    const id = await create(home, { title: "t", kind: "ticket" });
    writeFileSync(join(home, "tasks", id, "task.md"), "broken\n");
    const { exitCode, json } = await shuJson(home, ["list"]);
    expect(exitCode).toBe(1);
    expect(json).toEqual({ error: { code: "invalid_task", message: expect.any(String), id } });
  });

  test("ambiguous_id and ref_conflict list the tasks in error.candidates", async () => {
    const home = tempHome();
    const a = await create(home, { title: "a", kind: "ticket", refs: ["abc-1"] });
    const b = await create(home, { title: "b", kind: "ticket", refs: ["abc-2"] });
    const { exitCode, json } = await shuJson(home, ["save"], '{"refs":["abc-1","abc-2"]}');
    expect(exitCode).toBe(1);
    expect(json).toEqual({
      error: { code: "ref_conflict", message: expect.any(String), candidates: [a, b].sort() },
    });
  });

  test("find exits non-zero with not_found when nothing matches", async () => {
    const home = tempHome();
    await create(home, { title: "t", kind: "ticket", refs: ["abc-123"] });
    const { exitCode, json } = await shuJson(home, ["find", "--ref", "abc-124"]);
    expect(exitCode).toBe(1);
    expect(json.error.code).toBe("not_found");
  });

  test.each([
    ["unknown command", ["frobnicate"], undefined, "invalid_input"],
    ["a command named like an Object.prototype key", ["constructor", "aoi-kitsune"], undefined, "invalid_input"],
    ["another Object.prototype key", ["__proto__", "aoi-kitsune"], undefined, "invalid_input"],
    ["--remove-ref with no task to remove from", ["save", "--remove-ref", "abc-1"], '{"title":"t","kind":"ticket"}', "invalid_input"],
    ["unknown option", ["list", "--frobnicate"], undefined, "invalid_input"],
    ["an option of another command", ["list", "--force"], undefined, "invalid_input"],
    ["too few arguments", ["show"], undefined, "invalid_input"],
    ["too many arguments", ["path", "aoi-kitsune", "extra"], undefined, "invalid_input"],
    ["find without --ref", ["find"], undefined, "invalid_input"],
    ["filtering by an invalid status", ["list", "--status", "active"], undefined, "invalid_input"],
    ["--all together with --status", ["list", "--all", "--status", "open"], undefined, "invalid_input"],
    ["save input that is not JSON", ["save"], "hello", "invalid_input"],
    ["save with an invalid ref", ["save"], '{"title":"t","kind":"ticket","refs":["???"]}', "invalid_ref"],
  ])("%s", async (_, args, stdin, code) => {
    const { exitCode, json } = await shuJson(tempHome(), args, stdin);
    expect(exitCode).toBe(1);
    expect(json.error.code).toBe(code);
  });
});

describe("argument parsing", () => {
  test("options may come before the command, with or without a value", async () => {
    const home = tempHome();
    const id = await create(home, { title: "t", kind: "ticket", status: "done", refs: ["abc-1"] });
    expect((await shuJson(home, ["--status", "done", "list"])).json.tasks.map((t: { id: string }) => t.id)).toEqual([id]);
    expect((await shu(home, ["--json", "--ref", "abc-1", "find"])).exitCode).toBe(0);
    expect((await shu(home, ["--author", "claude", "log", id, "note"])).exitCode).toBe(0);
    expect((await shuJson(home, ["show", id])).json.log[0].author).toBe("claude");
  });

  test("--json after -- is a positional, not the option", async () => {
    const home = tempHome();
    const id = await create(home, { title: "t", kind: "ticket" });
    const { exitCode, stdout } = await shu(home, ["log", id, "--", "--json"]);
    expect(exitCode).toBe(0);
    expect(stdout).toBe(`logged ${id}\n`);
    expect((await shuJson(home, ["show", id])).json.log[0].message).toBe("--json");
  });

  test("a message that starts with - goes after --", async () => {
    const home = tempHome();
    const id = await create(home, { title: "t", kind: "ticket" });
    expect((await shuJson(home, ["log", id, "- a bullet"])).json.error.code).toBe("invalid_input");
    expect((await shu(home, ["log", id, "--author", "claude", "--", "- a bullet"])).exitCode).toBe(0);
    expect((await shuJson(home, ["show", id])).json.log).toEqual([
      { at: expect.any(String), author: "claude", message: "- a bullet" },
    ]);
  });
});

describe("list", () => {
  async function setup() {
    const home = tempHome();
    let minute = 0;
    const ctx = { home, now: () => new Date(2026, 9, 1, 12, minute++, 0), random: Math.random };
    const save = (input: Record<string, unknown>) => commands.save(ctx, JSON.stringify(input)).task.id;
    const ids = {
      review: save({ title: "A review", kind: "review" }),
      waiting: save({ title: "Waiting for a reply", kind: "pr-followup", status: "waiting" }),
      done: save({ title: "Finished", kind: "review", status: "done" }),
      dropped: save({ title: "Abandoned", kind: "ticket", status: "dropped" }),
      ticket: save({ title: "A ticket", kind: "ticket" }),
    };
    const listed = async (...args: string[]) =>
      (await shuJson(home, ["list", ...args])).json.tasks.map((task: { id: string }) => task.id);
    return { home, ids, save, listed };
  }

  test("shows only open / waiting by default, most recently updated first", async () => {
    const { ids, listed } = await setup();
    expect(await listed()).toEqual([ids.ticket, ids.waiting, ids.review]);
  });

  test("an updated task moves to the top", async () => {
    const { ids, save, listed } = await setup();
    save({ id: ids.review, title: "A review (updated)" });
    expect(await listed()).toEqual([ids.review, ids.ticket, ids.waiting]);
  });

  test("--status can be repeated", async () => {
    const { ids, listed } = await setup();
    expect(await listed("--status", "done")).toEqual([ids.done]);
    expect(await listed("--status", "done", "--status", "dropped")).toEqual([ids.dropped, ids.done]);
  });

  test("--kind can be repeated and combines with the status filter", async () => {
    const { ids, listed } = await setup();
    expect(await listed("--kind", "review")).toEqual([ids.review]);
    expect(await listed("--kind", "review", "--kind", "ticket")).toEqual([ids.ticket, ids.review]);
    expect(await listed("--kind", "review", "--all")).toEqual([ids.done, ids.review]);
  });

  test("--all includes every status", async () => {
    const { ids, listed } = await setup();
    expect(await listed("--all")).toEqual([ids.ticket, ids.dropped, ids.done, ids.waiting, ids.review]);
  });

  test("the human-readable output is one task per line", async () => {
    const { home, ids } = await setup();
    const { stdout } = await shu(home, ["list"]);
    const lines = stdout.trimEnd().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toStartWith(ids.ticket);
    expect(lines[0]).toEndWith("A ticket");
  });
});

describe("show", () => {
  test("accepts just the words of the ID", async () => {
    const home = tempHome();
    const id = await create(home, { title: "t", kind: "ticket" });
    const { json } = await shuJson(home, ["show", idWords(id)]);
    expect(json.task.id).toBe(id);
    expect(json.log).toEqual([]);
    expect(json.artifacts).toEqual([]);
  });
});

describe("save", () => {
  test("--remove-ref removes a ref", async () => {
    const home = tempHome();
    const id = await create(home, { title: "t", kind: "ticket", refs: ["abc-1", "abc-2"] });
    const { json } = await shuJson(home, ["save", "--remove-ref", "abc-1"], JSON.stringify({ id }));
    expect(json.result).toBe("updated");
    expect(json.task.refs).toEqual(["linear:ABC-2"]);
  });

  test("the human-readable output is the result and the ID", async () => {
    const home = tempHome();
    const { stdout } = await shu(home, ["save"], '{"title":"t","kind":"ticket","refs":["abc-1"]}');
    expect(stdout).toMatch(/^created \d{8}-[a-z]+-[a-z]+\n$/);
    const again = await shu(home, ["save"], '{"refs":["abc-1"]}');
    expect(again.stdout).toStartWith("matched ");
  });
});

describe("log", () => {
  test("reads the message from stdin when it is omitted", async () => {
    const home = tempHome();
    const id = await create(home, { title: "t", kind: "ticket" });
    await shu(home, ["log", id, "--author", "claude"], "line one\nline two\n");
    const { json } = await shuJson(home, ["show", id]);
    expect(json.log).toEqual([{ at: expect.any(String), author: "claude", message: "line one\nline two" }]);
  });
});

describe("artifact", () => {
  async function setup() {
    const home = tempHome();
    const id = await create(home, { title: "t", kind: "ticket" });
    const source = join(home, "report.md");
    writeFileSync(source, "first version\n");
    const stored = (name: string) => readFileSync(join(home, "tasks", id, "artifacts", name), "utf8");
    return { home, id, source, stored };
  }

  test("copies the file and keeps its name", async () => {
    const { home, id, source, stored } = await setup();
    const { exitCode } = await shu(home, ["artifact", id, source]);
    expect(exitCode).toBe(0);
    expect(stored("report.md")).toBe("first version\n");
    expect(readFileSync(source, "utf8")).toBe("first version\n");
  });

  test("--name changes the stored file name", async () => {
    const { home, id, source, stored } = await setup();
    await shu(home, ["artifact", id, source, "--name", "brief.md"]);
    expect(stored("brief.md")).toBe("first version\n");
  });

  test("an existing name is an error and the existing file is untouched", async () => {
    const { home, id, source, stored } = await setup();
    await shu(home, ["artifact", id, source]);
    writeFileSync(source, "second version\n");
    const { exitCode, json } = await shuJson(home, ["artifact", id, source]);
    expect(exitCode).toBe(1);
    expect(json.error.code).toBe("artifact_exists");
    expect(stored("report.md")).toBe("first version\n");
  });

  test("--force overwrites", async () => {
    const { home, id, source, stored } = await setup();
    await shu(home, ["artifact", id, source]);
    writeFileSync(source, "second version\n");
    const { exitCode } = await shu(home, ["artifact", id, source, "--force"]);
    expect(exitCode).toBe(0);
    expect(stored("report.md")).toBe("second version\n");
  });

  test("a name that differs only in case never leaves the result disagreeing with what is stored", async () => {
    const { home, id, source, stored } = await setup();
    await shu(home, ["artifact", id, source, "--name", "brief.md"]);
    writeFileSync(source, "second version\n");
    const dir = join(home, "tasks", id, "artifacts");
    const caseInsensitive = existsSync(join(dir, "BRIEF.MD"));

    const plain = await shuJson(home, ["artifact", id, source, "--name", "Brief.md"]);
    const forced = await shuJson(home, ["artifact", id, source, "--name", "Brief.md", "--force"]);

    expect(forced.exitCode).toBe(0);
    expect(forced.json.name).toBe("Brief.md");
    expect(stored("Brief.md")).toBe("second version\n");
    if (caseInsensitive) {
      expect(plain.json.error.code).toBe("artifact_exists");
      expect(plain.json.error.message).toContain("brief.md");
      expect(readdirSync(dir)).toEqual(["Brief.md"]);
    } else {
      expect(plain.exitCode).toBe(0);
      expect(readdirSync(dir).sort()).toEqual(["Brief.md", "brief.md"]);
    }
  });

  test("reading from stdin requires --name", async () => {
    const { home, id } = await setup();
    const { exitCode, json } = await shuJson(home, ["artifact", id, "-"], "content");
    expect(exitCode).toBe(1);
    expect(json.error.code).toBe("invalid_input");
  });

  test.each(["../escape.md", "a/b.md", "..", "."])(
    "a name that would leave artifacts/ is rejected: %p",
    async (name) => {
      const { home, id } = await setup();
      const { exitCode, json } = await shuJson(home, ["artifact", id, "-", "--name", name], "content");
      expect(exitCode).toBe(1);
      expect(json.error.code).toBe("invalid_input");
      expect((await shuJson(home, ["show", id])).json.artifacts).toEqual([]);
    },
  );

  test("a missing source file is an error", async () => {
    const { home, id } = await setup();
    const { exitCode, json } = await shuJson(home, ["artifact", id, join(home, "no-such-file")]);
    expect(exitCode).toBe(1);
    expect(json.error.code).toBe("invalid_input");
  });

  test("leaves no temporary files behind", async () => {
    const { home, id, source } = await setup();
    await shu(home, ["artifact", id, source]);
    await shu(home, ["artifact", id, source]);
    const { json } = await shuJson(home, ["path", id]);
    const names = (await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: json.path, dot: true }))).sort();
    expect(names).toEqual(["artifacts/report.md", "task.md"]);
  });
});

describe("help", () => {
  test("no arguments and --help print the usage and exit 0", async () => {
    const home = tempHome();
    for (const args of [[], ["--help"], ["list", "--help"]]) {
      const { exitCode, stdout } = await shu(home, args);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("shu save");
    }
  });

  test("--version", async () => {
    const { exitCode, stdout } = await shu(tempHome(), ["--version"]);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/^\d+\.\d+\.\d+\n$/);
  });
});
