import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ShuError } from "../src/errors";
import { parseLog } from "../src/log";
import { globalLock, withLock } from "../src/store";
import { parseTaskFile } from "../src/task";
import { cleanupHomes, run, shu, shuJson, tempHome } from "./helpers";

afterEach(cleanupHomes);

const CREATE_WORKER = join(import.meta.dir, "fixtures/create-worker.ts");
const LOOP_WORKER = join(import.meta.dir, "fixtures/loop-worker.ts");

const times = <T>(n: number, fn: (i: number) => Promise<T>) => Promise.all(Array.from({ length: n }, (_, i) => fn(i)));

async function create(home: string, input: Record<string, unknown>): Promise<string> {
  return (await shuJson(home, ["save"], JSON.stringify(input))).json.task.id;
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

  test("readers never see a half-written task.md", async () => {
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

  test("simultaneous appends leave every log entry whole and unmixed", async () => {
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

describe("locks", () => {
  const options = { retryMs: 5, timeoutMs: 200, staleMs: 10_000 };

  function codeOf(fn: () => unknown): string | undefined {
    try {
      fn();
    } catch (e) {
      return (e as ShuError).code;
    }
    return undefined;
  }

  test("is released when the work finishes, even if it throws", () => {
    const lock = join(tempHome(), ".lock");
    expect(withLock(lock, () => existsSync(lock), options)).toBe(true);
    expect(existsSync(lock)).toBe(false);
    expect(() =>
      withLock(
        lock,
        () => {
          throw new Error("failed");
        },
        options,
      ),
    ).toThrow("failed");
    expect(existsSync(lock)).toBe(false);
  });

  test("cannot be taken while another process holds it, and gives up after the timeout", () => {
    const lock = join(tempHome(), ".lock");
    writeFileSync(lock, "someone-else");
    let ran = false;
    expect(codeOf(() => withLock(lock, () => (ran = true), options))).toBe("lock_timeout");
    expect(ran).toBe(false);
    expect(readFileSync(lock, "utf8")).toBe("someone-else");
  });

  test("a stale lock can be stolen", () => {
    const lock = join(tempHome(), ".lock");
    writeFileSync(lock, "crashed-process");
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    expect(withLock(lock, () => readFileSync(lock, "utf8"), options)).not.toBe("crashed-process");
    expect(existsSync(lock)).toBe(false);
  });

  test("a holder whose lock was stolen does not remove the thief's lock", () => {
    const lock = join(tempHome(), ".lock");
    withLock(lock, () => writeFileSync(lock, "thief"), options);
    expect(readFileSync(lock, "utf8")).toBe("thief");
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
    const old = new Date(Date.now() - 60_000);
    utimesSync(globalLock(home), old, old);

    const { exitCode } = await shuJson(home, ["save"], '{"title":"t","kind":"ticket","refs":["abc-1"]}');

    expect(exitCode).toBe(0);
    expect(readdirSync(home)).toEqual(["tasks"]);
  });
});
