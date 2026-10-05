import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import * as commands from "../src/commands";
import { parseLog } from "../src/log";
import { globalLock, taskFile, withLock } from "../src/store";
import { parseTaskFile } from "../src/task";
import { cleanupHomes, codeOf, create, logMessage, run, shu, shuJson, tempHome, testCtx } from "./helpers";

// These tests start many bun subprocesses; the 5s default is too tight on a loaded machine
setDefaultTimeout(30_000);

afterEach(cleanupHomes);

const CREATE_WORKER = join(import.meta.dir, "fixtures/create-worker.ts");
const LOOP_WORKER = join(import.meta.dir, "fixtures/loop-worker.ts");
const LOCK_WORKER = join(import.meta.dir, "fixtures/lock-worker.ts");

const times = <T>(n: number, fn: (i: number) => Promise<T>) => Promise.all(Array.from({ length: n }, (_, i) => fn(i)));

function makeStale(path: string): void {
  const old = new Date(Date.now() - 60_000);
  utimesSync(path, old, old);
}

describe("several processes at once", () => {
  test("simultaneous saves with the same ref create only one task", async () => {
    const home = tempHome();
    const input = JSON.stringify({
      title: "Investigate",
      kind: "bug-investigation",
      refs: ["https://github.com/example-org/example-repo/pull/482"],
    });

    const results = await times(12, () => shuJson(home, ["save"], input));

    expect(results.map((r) => r.exitCode)).toEqual(Array(12).fill(0));
    expect(results.filter((r) => r.json.result === "created")).toHaveLength(1);
    expect(results.filter((r) => r.json.result === "matched")).toHaveLength(11);
    expect(new Set(results.map((r) => r.json.task.id)).size).toBe(1);
    expect(readdirSync(join(home, "tasks"))).toHaveLength(1);
  });

  test("simultaneous saves with overlapping refs never leave a ref on two tasks", async () => {
    const home = tempHome();
    // A chain where neighbours share one ref. Whatever the order, each ref must end up on one task
    const results = await times(10, (i) =>
      shuJson(
        home,
        ["save"],
        JSON.stringify({ title: `t${i}`, kind: "ticket", refs: [`abc-${i + 1}`, `abc-${i + 2}`] }),
      ),
    );

    for (const r of results) {
      if (r.exitCode !== 0) expect(r.json.error.code).toBe("ref_conflict");
    }
    const { json } = await shuJson(home, ["list", "--all"]);
    const refs = json.tasks.flatMap((task: { refs: string[] }) => task.refs);
    expect(new Set(refs).size).toBe(refs.length);
  });

  test("adding a ref by id and creating a task with the same ref never leave the ref on two tasks", async () => {
    const home = tempHome();
    const id = await create(home, { title: "t", kind: "ticket" });

    const results = await Promise.all([
      ...Array.from({ length: 4 }, () => shuJson(home, ["save"], JSON.stringify({ id, refs: ["abc-1"] }))),
      ...Array.from({ length: 4 }, (_, i) =>
        shuJson(home, ["save"], JSON.stringify({ title: `n${i}`, kind: "ticket", refs: ["abc-1"] })),
      ),
    ]);

    for (const r of results) {
      if (r.exitCode !== 0) expect(r.json.error.code).toBe("ref_conflict");
    }
    const { json } = await shuJson(home, ["list", "--all"]);
    const owners = json.tasks.filter((task: { refs: string[] }) => task.refs.includes("linear:ABC-1"));
    expect(owners).toHaveLength(1);
    for (const r of results.slice(4)) {
      if (r.exitCode === 0) expect(r.json.task.id).toBe(owners[0].id);
    }
  });

  test("simultaneous creations get distinct IDs", async () => {
    const home = tempHome();
    const results = await times(20, (i) =>
      shuJson(home, ["save"], JSON.stringify({ title: `t${i}`, kind: "ticket" })),
    );

    expect(results.map((r) => r.json.result)).toEqual(Array(20).fill("created"));
    expect(new Set(results.map((r) => r.json.task.id)).size).toBe(20);
    const { json } = await shuJson(home, ["list"]);
    expect(json.tasks.map((task: { title: string }) => task.title).sort()).toEqual(
      Array.from({ length: 20 }, (_, i) => `t${i}`).sort(),
    );
  });

  test("processes that draw the same words still get separate directories", async () => {
    const home = tempHome();
    const results = await times(10, () => run(home, CREATE_WORKER, []));

    expect(results.map((r) => r.exitCode)).toEqual(Array(10).fill(0));
    const ids = results.map((r) => r.stdout.trim());
    expect(new Set(ids).size).toBe(10);
    expect(readdirSync(join(home, "tasks")).sort()).toEqual([...ids].sort());
  });

  test("simultaneous updates to one task lose none of the updates", async () => {
    const home = tempHome();
    const id = await create(home, { title: "t", kind: "ticket" });

    const results = await times(10, (i) => shuJson(home, ["save"], JSON.stringify({ id, refs: [`abc-${i + 1}`] })));

    expect(results.map((r) => r.exitCode)).toEqual(Array(10).fill(0));
    const { json } = await shuJson(home, ["show", id]);
    expect([...json.task.refs].sort()).toEqual(Array.from({ length: 10 }, (_, i) => `linear:ABC-${i + 1}`).sort());
  });

  test("updates without refs (no global lock) and ref additions do not lose each other", async () => {
    const home = tempHome();
    const id = await create(home, { title: "t", kind: "ticket" });

    const results = await Promise.all([
      ...Array.from({ length: 6 }, (_, i) => shuJson(home, ["save"], JSON.stringify({ id, refs: [`abc-${i + 1}`] }))),
      shuJson(home, ["save"], JSON.stringify({ id, status: "waiting" })),
      shuJson(home, ["save"], JSON.stringify({ id, title: "updated" })),
      shuJson(home, ["save"], JSON.stringify({ id, body: "body" })),
    ]);

    expect(results.map((r) => r.exitCode)).toEqual(Array(9).fill(0));
    const { task } = (await shuJson(home, ["show", id])).json;
    expect(task).toMatchObject({ status: "waiting", title: "updated", body: "body" });
    expect(task.refs).toHaveLength(6);
  });

  test("simultaneous status changes and saves to the same tasks lose none of the updates", async () => {
    const home = tempHome();
    const ids = await Promise.all(Array.from({ length: 4 }, (_, i) => create(home, { title: `t${i}`, kind: "review" })));

    const results = await Promise.all([
      shuJson(home, ["status", "done", ...ids]),
      ...ids.map((id, i) => shuJson(home, ["save"], JSON.stringify({ id, title: `updated ${i}` }))),
      ...ids.map((id, i) => shuJson(home, ["save"], JSON.stringify({ id, refs: [`abc-${i + 1}`] }))),
    ]);

    expect(results.map((r) => r.exitCode)).toEqual(Array(9).fill(0));
    const { tasks } = (await shuJson(home, ["list", "--all"])).json;
    expect(tasks).toHaveLength(4);
    for (const task of tasks) {
      const i = ids.indexOf(task.id);
      expect(task).toMatchObject({ status: "done", title: `updated ${i}`, refs: [`linear:ABC-${i + 1}`] });
    }
  });

  test("readers running alongside writers always get a valid task", async () => {
    const home = tempHome();
    const id = await create(home, { title: "t", kind: "ticket" });

    const results = await Promise.all([
      run(home, LOOP_WORKER, ["save", id, "40"]),
      run(home, LOOP_WORKER, ["save", id, "40"]),
      run(home, LOOP_WORKER, ["show", id, "400"]),
      run(home, LOOP_WORKER, ["show", id, "400"]),
      run(home, LOOP_WORKER, ["list", id, "400"]),
    ]);

    expect(results.map((r) => r.stderr)).toEqual(Array(5).fill(""));
    expect(results.map((r) => r.exitCode)).toEqual(Array(5).fill(0));
    const file = join(home, "tasks", id, "task.md");
    expect(parseTaskFile(readFileSync(file, "utf8"), id).title).toBe("t39");
    expect(readdirSync(join(home, "tasks", id))).toEqual(["task.md"]);
  });

  test("appends from several processes in tight loops lose and mix nothing", async () => {
    const home = tempHome();
    const id = await create(home, { title: "t", kind: "ticket" });
    const authors = ["agent-a", "agent-b", "agent-c", "agent-d"];

    const results = await Promise.all(authors.map((author) => run(home, LOOP_WORKER, ["log", id, "50", author])));

    expect(results.map((r) => r.stderr)).toEqual(Array(4).fill(""));
    const entries = parseLog(readFileSync(join(home, "tasks", id, "log.md"), "utf8"));
    expect(entries).toHaveLength(200);
    for (const author of authors) {
      const messages = entries.filter((entry) => entry.author === author).map((entry) => entry.message);
      expect(messages).toEqual(Array.from({ length: 50 }, (_, i) => logMessage(author, i)));
    }
  });

  test("simultaneous shu log commands leave every entry whole", async () => {
    const home = tempHome();
    const id = await create(home, { title: "t", kind: "ticket" });
    const message = (i: number) => `entry ${i} ☕\n${`${i}`.repeat(2000)}\nend ${i}`;

    const results = await times(20, (i) => shu(home, ["log", id, "--author", `agent-${i}`], message(i)));

    expect(results.map((r) => r.exitCode)).toEqual(Array(20).fill(0));
    const entries = parseLog(readFileSync(join(home, "tasks", id, "log.md"), "utf8"));
    expect(entries).toHaveLength(20);
    for (const entry of entries) {
      const i = Number(entry.author.replace("agent-", ""));
      expect(entry.message).toBe(message(i));
    }
    expect(new Set(entries.map((entry) => entry.author)).size).toBe(20);
  });

  test("simultaneous artifacts with the same name: exactly one wins and its content is intact", async () => {
    const home = tempHome();
    const id = await create(home, { title: "t", kind: "ticket" });
    const content = (i: number) => `${i}\n`.repeat(20000);

    const results = await times(8, (i) =>
      shuJson(home, ["artifact", id, "-", "--name", "brief.md"], content(i)),
    );

    const winners = results.flatMap((r, i) => (r.exitCode === 0 ? [i] : []));
    expect(winners).toHaveLength(1);
    for (const r of results) {
      if (r.exitCode !== 0) expect(r.json.error.code).toBe("artifact_exists");
    }
    expect(readFileSync(join(home, "tasks", id, "artifacts", "brief.md"), "utf8")).toBe(content(winners[0]));
  });
});

describe("writing task.md", () => {
  test("replaces the file instead of rewriting it, so an open reader keeps the complete old version", () => {
    const ctx = testCtx();
    const { task } = commands.save(ctx, JSON.stringify({ title: "before", kind: "ticket", body: "body\n".repeat(5000) }));
    const file = taskFile(ctx.home, task.id);
    const before = readFileSync(file, "utf8");
    const inode = statSync(file).ino;
    const reader = openSync(file, "r");
    try {
      commands.save(ctx, JSON.stringify({ id: task.id, title: "after", body: "" }));

      expect(readFileSync(reader, "utf8")).toBe(before);
      expect(statSync(file).ino).not.toBe(inode);
      expect(parseTaskFile(readFileSync(file, "utf8"), task.id)).toMatchObject({ title: "after", body: "" });
    } finally {
      closeSync(reader);
    }
  });
});

describe("locks", () => {
  const options = { retryMs: 5, timeoutMs: 200, staleMs: 10_000 };

  test("is released when the work finishes, even if it throws", () => {
    const dir = tempHome();
    const lock = join(dir, ".lock");
    expect(withLock(lock, () => existsSync(lock), options)).toBe(true);
    expect(() =>
      withLock(
        lock,
        () => {
          throw new Error("failed");
        },
        options,
      ),
    ).toThrow("failed");
    expect(readdirSync(dir)).toEqual([]);
  });

  test("cannot be taken while another process holds it, and gives up after the timeout", () => {
    const lock = join(tempHome(), ".lock");
    writeFileSync(lock, "someone-else");
    let ran = false;
    expect(codeOf(() => withLock(lock, () => (ran = true), options))).toBe("lock_timeout");
    expect(ran).toBe(false);
    expect(readFileSync(lock, "utf8")).toBe("someone-else");
  });

  test("a stale lock is taken over", () => {
    const dir = tempHome();
    const lock = join(dir, ".lock");
    writeFileSync(lock, "crashed-process");
    makeStale(lock);
    expect(withLock(lock, () => readFileSync(lock, "utf8"), options)).not.toBe("crashed-process");
    expect(readdirSync(dir)).toEqual([]);
  });

  test("a guard left behind by a crashed takeover does not block the lock forever", () => {
    const dir = tempHome();
    const lock = join(dir, ".lock");
    writeFileSync(lock, "crashed-process");
    writeFileSync(`${lock}.steal`, "crashed-takeover");
    makeStale(lock);
    makeStale(`${lock}.steal`);
    expect(withLock(lock, () => "done", options)).toBe("done");
    expect(readdirSync(dir)).toEqual([]);
  });

  test("a holder whose lock was taken over does not remove the new holder's lock", () => {
    const lock = join(tempHome(), ".lock");
    withLock(lock, () => writeFileSync(lock, "new-holder"), options);
    expect(readFileSync(lock, "utf8")).toBe("new-holder");
  });

  test("when several processes find the same stale lock, only one of them is inside at a time", async () => {
    const dir = tempHome();
    const rounds = 150;
    for (let i = 0; i < rounds; i++) {
      writeFileSync(join(dir, `lock-${i}`), "crashed-process");
      makeStale(join(dir, `lock-${i}`));
    }
    const startAt = Date.now() + 500;

    const results = await times(8, () => run(dir, LOCK_WORKER, ["contend", dir, String(rounds), String(startAt), "20"]));

    expect(results.map((r) => r.stderr)).toEqual(Array(8).fill(""));
    expect(results.map((r) => r.exitCode)).toEqual(Array(8).fill(0));
    expect(readdirSync(dir)).toEqual([]);
  });

  test("a holder that waits for another lock keeps its own lock from going stale", async () => {
    const dir = tempHome();
    const outer = join(dir, "outer");
    const marker = join(dir, "inside");
    const busy = join(dir, "busy");
    mkdirSync(join(dir, "free"));
    // Someone else holds the inner lock and stays alive for longer than the stale threshold
    writeFileSync(busy, "someone-else");
    const keepAlive = setInterval(() => utimesSync(busy, new Date(), new Date()), 50);
    const staleMs = "300";

    const first = run(dir, LOCK_WORKER, ["nested", outer, busy, marker, staleMs]);
    await Bun.sleep(150);
    const second = run(dir, LOCK_WORKER, ["nested", outer, join(dir, "free", "lock"), marker, staleMs]);
    await Bun.sleep(1000);
    clearInterval(keepAlive);
    rmSync(busy);

    const results = await Promise.all([first, second]);
    expect(results.map((r) => r.stderr)).toEqual(["", ""]);
    expect(results.map((r) => r.exitCode)).toEqual([0, 0]);
  });

  test("save waits for the global lock to be released, then proceeds", async () => {
    const home = tempHome();
    writeFileSync(globalLock(home), "someone-else");
    const pending = shuJson(home, ["save"], '{"title":"t","kind":"ticket","refs":["abc-1"]}');
    await Bun.sleep(300);
    expect(readdirSync(home)).toEqual([".lock"]);
    rmSync(globalLock(home));

    const { exitCode, json } = await pending;
    expect(exitCode).toBe(0);
    expect(json.result).toBe("created");
    expect(readdirSync(home)).toEqual(["tasks"]);
  });

  test("save works even if a crashed process left a stale global lock", async () => {
    const home = tempHome();
    writeFileSync(globalLock(home), "crashed-process");
    makeStale(globalLock(home));

    const { exitCode } = await shuJson(home, ["save"], '{"title":"t","kind":"ticket","refs":["abc-1"]}');

    expect(exitCode).toBe(0);
    expect(readdirSync(home)).toEqual(["tasks"]);
  });
});
