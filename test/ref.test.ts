import { describe, expect, test } from "bun:test";
import { normalizeRef } from "../src/ref";
import { codeOf } from "./helpers";

describe("ref normalization", () => {
  test.each([
    ["https://github.com/example-org/example-repo/pull/482", "github:example-org/example-repo#482"],
    ["https://github.com/example-org/example-repo/pull/482/files", "github:example-org/example-repo#482"],
    ["https://github.com/example-org/example-repo/issues/7", "github:example-org/example-repo#7"],
    ["example-org/example-repo#482", "github:example-org/example-repo#482"],
    ["Example-Org/Example-Repo#482", "github:example-org/example-repo#482"],
    ["github:example-org/example-repo#482", "github:example-org/example-repo#482"],
    ["github:https://github.com/example-org/example-repo/pull/482", "github:example-org/example-repo#482"],
    ["abc-123", "linear:ABC-123"],
    ["ABC-123", "linear:ABC-123"],
    ["linear:abc-123", "linear:ABC-123"],
    ["https://linear.app/example-ws/issue/ABC-123/some-title-slug", "linear:ABC-123"],
    ["https://linear.app/example-ws/issue/abc-123", "linear:ABC-123"],
    [
      "https://example.slack.com/archives/C000/p1700000000000000",
      "slack:https://example.slack.com/archives/C000/p1700000000000000",
    ],
    [
      "slack:https://example.slack.com/archives/C000/p1700000000000000",
      "slack:https://example.slack.com/archives/C000/p1700000000000000",
    ],
    ["https://example.com/docs/page?x=1", "url:https://example.com/docs/page?x=1"],
    ["url:https://example.com/docs/page", "url:https://example.com/docs/page"],
    ["https://github.com/example-org/example-repo", "url:https://github.com/example-org/example-repo"],
    ["  abc-123  ", "linear:ABC-123"],
    ["https://app.notion.com/p/0123456789abcdef0123456789abcdef", "notion:0123456789abcdef0123456789abcdef"],
    ["https://www.notion.so/example-ws/Some-page-title-0123456789abcdef0123456789abcdef", "notion:0123456789abcdef0123456789abcdef"],
    ["https://www.notion.so/0123456789abcdef0123456789abcdef?pvs=4", "notion:0123456789abcdef0123456789abcdef"],
    ["https://www.notion.so/example-ws/Some-page-title-0123456789abcdef0123456789abcdef?pvs=4#fedcba9876543210fedcba9876543210", "notion:0123456789abcdef0123456789abcdef"],
    ["https://www.notion.so/0123456789ABCDEF0123456789ABCDEF", "notion:0123456789abcdef0123456789abcdef"],
    ["https://www.notion.so/01234567-89ab-cdef-0123-456789abcdef", "notion:0123456789abcdef0123456789abcdef"],
    ["https://example-ws.notion.site/Some-page-title-0123456789abcdef0123456789abcdef", "notion:0123456789abcdef0123456789abcdef"],
    ["https://www.notion.so/example-ws/Some-page-title-0123456789abcdef0123456789abcdef/", "notion:0123456789abcdef0123456789abcdef"],
    ["notion:0123456789abcdef0123456789abcdef", "notion:0123456789abcdef0123456789abcdef"],
    ["notion:https://app.notion.com/p/0123456789abcdef0123456789abcdef", "notion:0123456789abcdef0123456789abcdef"],
    ["0123456789abcdef0123456789abcdef", "notion:0123456789abcdef0123456789abcdef"],
    ["01234567-89ab-cdef-0123-456789abcdef", "notion:0123456789abcdef0123456789abcdef"],
    ["https://www.notion.so/example-ws", "url:https://www.notion.so/example-ws"],
    ["https://www.notion.so/example-ws/face0123456789abcdef0123456789abcdef", "url:https://www.notion.so/example-ws/face0123456789abcdef0123456789abcdef"],
    ["https://example.com/docs/0123456789abcdef0123456789abcdef", "url:https://example.com/docs/0123456789abcdef0123456789abcdef"],
  ])("%s → %s", (input, expected) => {
    expect(normalizeRef(input)).toBe(expected);
  });

  test("a Slack reply inside a thread is normalized to the thread parent's permalink", () => {
    const reply =
      "https://example.slack.com/archives/C000/p1700000123000100?thread_ts=1700000000.000000&cid=C000";
    expect(normalizeRef(reply)).toBe("slack:https://example.slack.com/archives/C000/p1700000000000000");
  });

  test("a Notion page opened as a peek over a database is normalized to the page, not the database", () => {
    const database = "fedcba9876543210fedcba9876543210";
    const view = "00000000000000000000000000000001";
    const peek = `https://www.notion.so/example-ws/${database}?v=${view}&p=0123456789abcdef0123456789abcdef&pm=s`;
    expect(normalizeRef(peek)).toBe("notion:0123456789abcdef0123456789abcdef");
    expect(normalizeRef(`https://www.notion.so/example-ws/${database}?v=${view}`)).toBe(`notion:${database}`);
  });

  test("normalizing a normal form again does not change it", () => {
    const inputs = [
      "https://github.com/Example-Org/example-repo/pull/482",
      "abc-123",
      "https://example.slack.com/archives/C000/p1700000123000100?thread_ts=1700000000.000000",
      "https://example.com/a?b=c#d",
      "https://www.notion.so/example-ws/Some-page-title-0123456789ABCDEF0123456789ABCDEF?pvs=4",
    ];
    for (const input of inputs) {
      const once = normalizeRef(input);
      expect(normalizeRef(once)).toBe(once);
    }
  });

  test.each([
    "",
    "   ",
    "just some words",
    "example-repo#482",
    "example-org/example-repo#0",
    "abc-0",
    "ftp://example.com/file",
    "mailto:someone@example.com",
    "https://github.com/example-org/example-repo/pull/0",
    "https://github.com/example-org/example-repo/issues/99999999999999999999",
    "https://linear.app/example-ws/issue/ABC-0/some-title",
    "github:abc-123",
    "linear:example-org/example-repo#482",
    "url:https://github.com/example-org/example-repo/pull/482",
    "slack:https://example.com/not-slack",
    "notion:abc-123",
    "notion:https://www.notion.so/example-ws",
    "url:https://app.notion.com/p/0123456789abcdef0123456789abcdef",
    "0123456789abcdef0123456789abcde",
  ])("input that cannot be normalized is an error: %p", (input) => {
    expect(codeOf(() => normalizeRef(input))).toBe("invalid_ref");
  });
});
