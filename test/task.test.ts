import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as commands from "../src/commands";
import { taskDir, taskFile } from "../src/store";
import { parseSaveInput, parseTaskFile, serializeTask } from "../src/task";
import { cleanupHomes, codeOf, testCtx } from "./helpers";

afterEach(cleanupHomes);

const ID = "20261001-aoi-kitsune";

const SPEC_EXAMPLE = `---
id: 20261001-aoi-kitsune
title: Investigate double-charged payments
kind: bug-investigation
status: open
refs:
  - slack:https://example.slack.com/archives/C000/p1700000000000000
  - linear:ABC-123
  - github:example-org/example-repo#482
created: 2026-10-01T12:00:00+09:00
updated: 2026-10-01T12:34:56+09:00
---

Current summary
`;

function frontmatter(overrides: Record<string, string | null>): string {
  const fields: Record<string, string | null> = {
    id: ID,
    title: "t",
    kind: "ticket",
    status: "open",
    created: "2026-10-01T12:00:00+09:00",
    updated: "2026-10-01T12:00:00+09:00",
    ...overrides,
  };
  const lines = Object.entries(fields)
    .filter(([, value]) => value !== null)
    .map(([key, value]) => `${key}: ${value}`);
  return `---\n${lines.join("\n")}\n---\n`;
}

describe("reading and writing task.md", () => {
  test("reads the example from the spec", () => {
    expect(parseTaskFile(SPEC_EXAMPLE, ID)).toMatchObject({
      id: ID,
      title: "Investigate double-charged payments",
      kind: "bug-investigation",
      status: "open",
      refs: [
        "slack:https://example.slack.com/archives/C000/p1700000000000000",
        "linear:ABC-123",
        "github:example-org/example-repo#482",
      ],
      created: "2026-10-01T12:00:00+09:00",
      updated: "2026-10-01T12:34:56+09:00",
      body: "Current summary",
    });
  });

  test("reading and writing back produces the same file", () => {
    expect(serializeTask(parseTaskFile(SPEC_EXAMPLE, ID))).toBe(SPEC_EXAMPLE);
  });

  test.each([
    "a title with a colon: a # and a ---",
    "123",
    "true",
    "'quotes' \"everywhere\"",
    "- looks like a list item",
    `${"long ".repeat(100)}title`,
    "non-ASCII: café ☕ — naïve",
  ])("a title that is special in YAML survives: %p", (title) => {
    const task = { ...parseTaskFile(SPEC_EXAMPLE, ID), title };
    expect(parseTaskFile(serializeTask(task), ID).title).toBe(title);
  });

  test("a --- line in the body is not mistaken for front matter", () => {
    const body = "first half\n\n---\n\nsecond half\n---";
    const task = { ...parseTaskFile(SPEC_EXAMPLE, ID), body };
    expect(parseTaskFile(serializeTask(task), ID).body).toBe(body);
  });

  test("a task without refs reads as an empty array", () => {
    expect(parseTaskFile(frontmatter({}), ID).refs).toEqual([]);
  });

  test.each([
    ["no front matter", "just a body\n"],
    ["broken YAML", "---\nid: [unclosed\n---\n"],
    ["id differs from the directory name", frontmatter({ id: "20261001-akai-tanuki" })],
    ["missing title", frontmatter({ title: null })],
    ["empty title", frontmatter({ title: '""' })],
    ["missing kind", frontmatter({ kind: null })],
    ["invalid status", frontmatter({ status: "active" })],
    ["missing status", frontmatter({ status: null })],
    ["refs is not an array", frontmatter({ refs: "linear:ABC-123" })],
    ["refs is not normalized", frontmatter({ refs: "[abc-123]" })],
    ["duplicate refs", frontmatter({ refs: "[linear:ABC-123, linear:ABC-123]" })],
    ["created is not a timestamp", frontmatter({ created: "yesterday" })],
    ["missing updated", frontmatter({ updated: null })],
  ])("an invalid task.md is rejected: %s", (_, text) => {
    expect(codeOf(() => parseTaskFile(text, ID))).toBe("invalid_task");
  });
});

describe("unknown fields", () => {
  function setup(extraFrontMatter: string) {
    const ctx = testCtx();
    const { task } = commands.save(ctx, JSON.stringify({ title: "t", kind: "ticket" }));
    const file = taskFile(ctx.home, task.id);
    writeFileSync(file, readFileSync(file, "utf8").replace(/---\n$/, `${extraFrontMatter}---\n`));
    const read = () => readFileSync(file, "utf8");
    return { ctx, id: task.id, read };
  }

  test("are kept when save rewrites the task", () => {
    const { ctx, id, read } = setup("priority: high\nowner:\n  team: payments\n");

    commands.save(ctx, JSON.stringify({ id, status: "waiting", refs: ["abc-123"] }));

    expect(read()).toContain("priority: high\nowner:\n  team: payments\n---\n");
    const { status, refs } = parseTaskFile(read(), id);
    expect(status).toBe("waiting");
    expect(refs).toEqual(["linear:ABC-123"]);
  });

  test.each([
    ["an integer beyond 2^53", "ticket: 12345678901234567890"],
    ["a version-like number", "version: 1.10"],
    ["a quoted string", 'note: "quoted"'],
    ["a comment", "# why this is parked"],
    ["an anchor and an alias", "first: &n hello\nagain: *n"],
  ])("%s is written back unchanged", (_, line) => {
    const { ctx, id, read } = setup(`${line}\n`);
    commands.save(ctx, JSON.stringify({ id, status: "waiting" }));
    expect(read()).toContain(`\n${line}\n---\n`);
  });

  test("a new refs field goes after status, ahead of unknown fields", () => {
    const { ctx, id, read } = setup("priority: high\n");
    commands.save(ctx, JSON.stringify({ id, refs: ["abc-123"] }));
    expect(read()).toMatch(/\nstatus: open\nrefs:\n  - linear:ABC-123\ncreated: .*\nupdated: .*\npriority: high\n---\n$/);
  });

  test("removing the last ref removes the refs field", () => {
    const { ctx, id, read } = setup("priority: high\n");
    commands.save(ctx, JSON.stringify({ id, refs: ["abc-123"] }));
    commands.save(ctx, JSON.stringify({ id }), ["abc-123"]);
    expect(read()).not.toContain("refs");
    expect(read()).toContain("priority: high\n---\n");
  });
});

describe("save input validation", () => {
  test.each([
    ["not JSON", "title: t"],
    ["empty", ""],
    ["not an object", '["t"]'],
    ["null", "null"],
    ["unknown field", '{"title":"t","kind":"ticket","titel":"typo"}'],
    ["created cannot be given", '{"title":"t","kind":"ticket","created":"2020-01-01T00:00:00Z"}'],
    ["blank title", '{"title":"  ","kind":"ticket"}'],
    ["multi-line title", '{"title":"a\\nb","kind":"ticket"}'],
    ["title is not a string", '{"title":1,"kind":"ticket"}'],
    ["empty kind", '{"title":"t","kind":""}'],
    ["invalid status", '{"title":"t","kind":"ticket","status":"active"}'],
    ["refs is not an array", '{"title":"t","kind":"ticket","refs":"abc-123"}'],
    ["refs element is not a string", '{"title":"t","kind":"ticket","refs":[1]}'],
    ["body is not a string", '{"title":"t","kind":"ticket","body":null}'],
  ])("%s → invalid_input", (_, text) => {
    expect(codeOf(() => parseSaveInput(text))).toBe("invalid_input");
  });

  test("invalid input creates no task", () => {
    const ctx = testCtx();
    const inputs = [
      ['{"title":"t","kind":"ticket","status":"active"}', "invalid_input"],
      ['{"title":"t","kind":"ticket","refs":["not a ref"]}', "invalid_ref"],
      ['{"title":"t"}', "invalid_input"],
      ['{"kind":"ticket","refs":["abc-123"]}', "invalid_input"],
    ];
    for (const [input, code] of inputs) expect(codeOf(() => commands.save(ctx, input))).toBe(code);
    expect(commands.list(ctx, { all: true }).tasks).toEqual([]);
  });
});

describe("a broken task.md", () => {
  test("is an error for list and for dedupe, never silently skipped", () => {
    const ctx = testCtx();
    commands.save(ctx, JSON.stringify({ title: "t", kind: "ticket" }));
    mkdirSync(taskDir(ctx.home, ID));
    writeFileSync(taskFile(ctx.home, ID), frontmatter({ status: "active" }));

    expect(codeOf(() => commands.list(ctx))).toBe("invalid_task");
    expect(codeOf(() => commands.save(ctx, '{"title":"u","kind":"ticket","refs":["abc-123"]}'))).toBe(
      "invalid_task",
    );
    expect(codeOf(() => commands.save(ctx, JSON.stringify({ id: ID, status: "done" })))).toBe("invalid_task");
  });
});
