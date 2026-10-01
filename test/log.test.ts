import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as commands from "../src/commands";
import type { ShuError } from "../src/errors";
import { parseLog } from "../src/log";
import { logFile, taskFile } from "../src/store";
import { cleanupHomes, testCtx } from "./helpers";

afterEach(cleanupHomes);

const T0 = new Date(2026, 9, 1, 12, 0, 0);
const T1 = new Date(2026, 9, 1, 12, 34, 56);

function setup() {
  let now = T0;
  const ctx = testCtx({ now: () => now });
  const { id } = commands.save(ctx, JSON.stringify({ title: "t", kind: "ticket" })).task;
  const read = () => readFileSync(logFile(ctx.home, id), "utf8");
  return { ctx, id, read, advance: () => (now = T1) };
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return (e as ShuError).code;
  }
  return undefined;
}

describe("appending to the log", () => {
  test("the heading line is ## <ISO 8601> <author>", () => {
    const { ctx, id, read } = setup();
    const { entry } = commands.log(ctx, id, "Reviewed the PR changes.", "claude");
    expect(read()).toBe(`## ${entry.at} claude\nReviewed the PR changes.\n\n`);
    expect(Date.parse(entry.at)).toBe(T0.getTime());
    expect(entry.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
  });

  test("author defaults to unknown", () => {
    const { ctx, id } = setup();
    expect(commands.log(ctx, id, "note").entry.author).toBe("unknown");
  });

  test("appending does not change a single byte of what was already there", () => {
    const { ctx, id, read, advance } = setup();
    commands.log(ctx, id, "first entry\nsecond line", "claude");
    const before = read();
    advance();
    commands.log(ctx, id, "second entry", "human");

    expect(read().startsWith(before)).toBe(true);
    expect(commands.show(ctx, id).log).toEqual([
      { at: expect.any(String), author: "claude", message: "first entry\nsecond line" },
      { at: expect.any(String), author: "human", message: "second entry" },
    ]);
  });

  test("does not touch task.md", () => {
    const { ctx, id } = setup();
    const before = readFileSync(taskFile(ctx.home, id), "utf8");
    commands.log(ctx, id, "note");
    expect(readFileSync(taskFile(ctx.home, id), "utf8")).toBe(before);
  });

  test("a Markdown heading inside a message does not split the entry", () => {
    const { ctx, id } = setup();
    const message = "## Findings\n- the idempotency key is not set\n\n## Next\n- reproduce it";
    commands.log(ctx, id, message, "claude");
    expect(commands.show(ctx, id).log).toEqual([{ at: expect.any(String), author: "claude", message }]);
  });

  test("a line shaped like an entry heading is rejected, so past entries cannot be forged", () => {
    const { ctx, id } = setup();
    commands.log(ctx, id, "genuine");
    const forged = "summary\n## 2020-01-01T00:00:00+09:00 someone\nfake history";
    expect(codeOf(() => commands.log(ctx, id, forged))).toBe("invalid_input");
    expect(commands.show(ctx, id).log).toHaveLength(1);
  });

  test.each([
    ["an empty message", "", "claude"],
    ["a whitespace-only message", " \n\t\n", "claude"],
    ["a blank author", "note", " "],
    ["a multi-line author", "note", "a\n## 2020-01-01T00:00:00+09:00 b"],
  ])("%s is rejected and nothing is written", (_, message, author) => {
    const { ctx, id } = setup();
    expect(codeOf(() => commands.log(ctx, id, message, author))).toBe("invalid_input");
    expect(commands.show(ctx, id).log).toEqual([]);
  });

  test("cannot write to a task that does not exist", () => {
    const { ctx } = setup();
    expect(codeOf(() => commands.log(ctx, "20261001-aoi-kitsune", "note"))).toBe("not_found");
  });
});

describe("reading the log", () => {
  test("reads the example from the spec", () => {
    const text =
      "## 2026-10-01T12:34:56+09:00 claude\nReviewed the PR changes.\n\n## 2026-10-01T13:00:00+09:00\nno author\n";
    expect(parseLog(text)).toEqual([
      { at: "2026-10-01T12:34:56+09:00", author: "claude", message: "Reviewed the PR changes." },
      { at: "2026-10-01T13:00:00+09:00", author: "unknown", message: "no author" },
    ]);
  });

  test("an empty log has no entries", () => {
    expect(parseLog("")).toEqual([]);
  });
});
