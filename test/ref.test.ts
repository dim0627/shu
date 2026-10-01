import { describe, expect, test } from "bun:test";
import { ShuError } from "../src/errors";
import { normalizeRef } from "../src/ref";

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
  ])("%s → %s", (input, expected) => {
    expect(normalizeRef(input)).toBe(expected);
  });

  test("a Slack reply inside a thread is normalized to the thread parent's permalink", () => {
    const reply =
      "https://example.slack.com/archives/C000/p1700000123000100?thread_ts=1700000000.000000&cid=C000";
    expect(normalizeRef(reply)).toBe("slack:https://example.slack.com/archives/C000/p1700000000000000");
  });

  test("normalizing a normal form again does not change it", () => {
    const inputs = [
      "https://github.com/Example-Org/example-repo/pull/482",
      "abc-123",
      "https://example.slack.com/archives/C000/p1700000123000100?thread_ts=1700000000.000000",
      "https://example.com/a?b=c#d",
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
    "github:abc-123",
    "linear:example-org/example-repo#482",
    "url:https://github.com/example-org/example-repo/pull/482",
    "slack:https://example.com/not-slack",
  ])("input that cannot be normalized is an error: %p", (input) => {
    expect(() => normalizeRef(input)).toThrow(ShuError);
    try {
      normalizeRef(input);
    } catch (e) {
      expect((e as ShuError).code).toBe("invalid_ref");
    }
  });
});
