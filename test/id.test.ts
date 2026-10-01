import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as commands from "../src/commands";
import { ShuError } from "../src/errors";
import { generateId, ID_PATTERN } from "../src/id";
import { createTaskDir, resolveId, taskDir, tasksDir } from "../src/store";
import { ADJECTIVES, NOUNS } from "../src/words";
import { cleanupHomes, tempHome, testCtx } from "./helpers";

afterEach(cleanupHomes);

const NOW = new Date(2026, 9, 1, 12, 0, 0);

function sequence(values: number[]): () => number {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)];
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return (e as ShuError).code;
  }
  return undefined;
}

describe("word lists", () => {
  test.each([
    ["adjectives", ADJECTIVES],
    ["nouns", NOUNS],
  ])("%s: at least 100 words, no duplicates, lowercase letters only", (_, words) => {
    expect(words.length).toBeGreaterThanOrEqual(100);
    expect(new Set(words).size).toBe(words.length);
    for (const word of words) expect(word).toMatch(/^[a-z]+$/);
  });
});

describe("ID allocation", () => {
  test("is the local creation date plus an adjective and a noun", () => {
    const id = generateId(NOW, () => 0);
    expect(id).toBe(`20261001-${ADJECTIVES[0]}-${NOUNS[0]}`);
    expect(id).toMatch(ID_PATTERN);
  });

  test("stays inside the lists even at the top of the random range", () => {
    const id = generateId(NOW, () => 0.999999);
    expect(id).toBe(`20261001-${ADJECTIVES.at(-1)}-${NOUNS.at(-1)}`);
  });

  test("draws new words when the directory already exists", () => {
    const home = tempHome();
    const first = createTaskDir(home, NOW, () => 0);
    // first attempt draws the same words as `first`, second attempt draws different ones
    const second = createTaskDir(home, NOW, sequence([0, 0, 0.5, 0.5]));
    expect(second).not.toBe(first);
    expect(readdirSync(tasksDir(home)).sort()).toEqual([first, second].sort());
  });

  test("gives up after 20 attempts without touching the existing task", () => {
    const home = tempHome();
    const first = createTaskDir(home, NOW, () => 0);
    writeFileSync(join(taskDir(home, first), "marker"), "keep");
    let draws = 0;
    const random = () => {
      draws++;
      return 0;
    };
    expect(codeOf(() => createTaskDir(home, NOW, random))).toBe("id_exhausted");
    expect(draws).toBe(20 * 2);
    expect(readdirSync(taskDir(home, first))).toEqual(["marker"]);
  });

  test("save does not let the input choose the ID of a new task", () => {
    const ctx = testCtx();
    expect(
      codeOf(() => commands.save(ctx, JSON.stringify({ id: "20261001-aoi-kitsune", title: "t", kind: "ticket" }))),
    ).toBe("not_found");
    expect(readdirSync(ctx.home)).toEqual([]);
  });
});

describe("ID lookup", () => {
  function setup() {
    const ctx = testCtx({ now: () => NOW });
    const create = (title: string) => commands.save(ctx, JSON.stringify({ title, kind: "ticket" })).task.id;
    return { ctx, create };
  }

  test("accepts the full ID or just its words", () => {
    const { ctx, create } = setup();
    const id = create("a");
    expect(resolveId(ctx.home, id)).toBe(id);
    expect(resolveId(ctx.home, id.slice("20261001-".length))).toBe(id);
  });

  test("words matching several tasks are an error that lists the candidates", () => {
    const { ctx, create } = setup();
    const id = create("a");
    const words = id.slice("20261001-".length);
    const other = `20250101-${words}`;
    mkdirSync(taskDir(ctx.home, other));
    writeFileSync(
      join(taskDir(ctx.home, other), "task.md"),
      `---\nid: ${other}\ntitle: b\nkind: ticket\nstatus: open\ncreated: 2025-01-01T00:00:00+09:00\nupdated: 2025-01-01T00:00:00+09:00\n---\n`,
    );
    try {
      resolveId(ctx.home, words);
      throw new Error("expected an error");
    } catch (e) {
      expect((e as ShuError).code).toBe("ambiguous_id");
      expect((e as ShuError).details.candidates).toEqual([other, id]);
    }
    expect(resolveId(ctx.home, other)).toBe(other);
  });

  test("an unknown ID is not_found", () => {
    const { ctx } = setup();
    expect(codeOf(() => resolveId(ctx.home, "20261001-aoi-kitsune"))).toBe("not_found");
    expect(codeOf(() => resolveId(ctx.home, "aoi-kitsune"))).toBe("not_found");
  });

  test.each(["../etc", "20261001-aoi-kitsune/..", "AOI-KITSUNE", "", "aoi"])(
    "input that is not shaped like an ID is rejected, never used as a path: %p",
    (input) => {
      const { ctx } = setup();
      expect(codeOf(() => resolveId(ctx.home, input))).toBe("invalid_input");
    },
  );
});
