import { expect, test } from "bun:test";

import {
  charSpanToLineSpan,
  extractLineRange,
  formatLinePointer,
  parseLinePointer,
  renderWithLineNumbers,
} from "../../../src/core/search/line-numbering.ts";

test("renderWithLineNumbers prefixes [N] from line 1 by default", () => {
  expect(renderWithLineNumbers("a\nb\nc")).toBe("[1] a\n[2] b\n[3] c");
});

test("renderWithLineNumbers honours a custom start line", () => {
  expect(renderWithLineNumbers("a\nb", 10)).toBe("[10] a\n[11] b");
});

test("renderWithLineNumbers preserves blank lines", () => {
  expect(renderWithLineNumbers("a\n\nc")).toBe("[1] a\n[2] \n[3] c");
});

test("renderWithLineNumbers clamps a sub-1 start line to 1", () => {
  expect(renderWithLineNumbers("a", 0)).toBe("[1] a");
  expect(renderWithLineNumbers("a", -5)).toBe("[1] a");
});

test("renderWithLineNumbers treats empty text as zero lines", () => {
  expect(renderWithLineNumbers("")).toBe("");
});

test("extractLineRange slices an inclusive 1-based range", () => {
  expect(extractLineRange("a\nb\nc\nd", 2, 3)).toBe("b\nc");
});

test("extractLineRange returns a single line when start equals end", () => {
  expect(extractLineRange("a\nb\nc", 2, 2)).toBe("b");
});

test("extractLineRange clamps an over-long end to the last line", () => {
  expect(extractLineRange("a\nb", 1, 99)).toBe("a\nb");
});

test("extractLineRange clamps a sub-1 start to line 1", () => {
  expect(extractLineRange("a\nb", 0, 1)).toBe("a");
});

test("extractLineRange returns empty for an inverted range", () => {
  expect(extractLineRange("a\nb\nc", 3, 1)).toBe("");
});

test("extractLineRange returns empty when the start is past the last line", () => {
  expect(extractLineRange("a\nb", 5, 9)).toBe("");
});

test("extractLineRange returns empty for empty text", () => {
  expect(extractLineRange("", 1, 1)).toBe("");
});

test("extractLineRange yields verbatim bytes with no markers (idempotent)", () => {
  const text = "alpha\nbeta\ngamma\ndelta";
  const once = extractLineRange(text, 2, 3);
  expect(once).toBe("beta\ngamma");
  // Re-extracting the full slice from itself is a no-op on the bytes.
  expect(extractLineRange(once, 1, 2)).toBe(once);
});

test("formatLinePointer renders a range pointer", () => {
  expect(formatLinePointer("Brain/foo.md", 5, 12)).toBe("Brain/foo.md:L5-L12");
});

test("formatLinePointer collapses a single line", () => {
  expect(formatLinePointer("a.md", 7, 7)).toBe("a.md:L7");
});

test("formatLinePointer normalizes an inverted or sub-1 range", () => {
  expect(formatLinePointer("a.md", 9, 3)).toBe("a.md:L9");
  expect(formatLinePointer("a.md", 0, 2)).toBe("a.md:L1-L2");
});

test("parseLinePointer parses a range pointer", () => {
  expect(parseLinePointer("Brain/foo.md:L5-L12")).toEqual({
    path: "Brain/foo.md",
    lineStart: 5,
    lineEnd: 12,
  });
});

test("parseLinePointer parses a single-line pointer", () => {
  expect(parseLinePointer("a.md:L7")).toEqual({ path: "a.md", lineStart: 7, lineEnd: 7 });
});

test("parseLinePointer keeps colons that belong to the path", () => {
  expect(parseLinePointer("a:b:L1-L2")).toEqual({ path: "a:b", lineStart: 1, lineEnd: 2 });
});

test("parseLinePointer round-trips formatLinePointer", () => {
  for (const [path, s, e] of [
    ["Brain/foo.md", 5, 12],
    ["a.md", 7, 7],
  ] as const) {
    const pointer = formatLinePointer(path, s, e);
    expect(parseLinePointer(pointer)).toEqual({ path, lineStart: s, lineEnd: e });
  }
});

test("parseLinePointer rejects malformed input", () => {
  expect(parseLinePointer("nope")).toBeNull();
  expect(parseLinePointer("")).toBeNull();
  expect(parseLinePointer("a.md:L0")).toBeNull();
  expect(parseLinePointer("a.md:L3-L1")).toBeNull();
  expect(parseLinePointer(":L1")).toBeNull();
});

test("charSpanToLineSpan maps an in-line match to its line", () => {
  const text = "a\nbb\nccc";
  expect(charSpanToLineSpan(text, text.indexOf("bb"), 2)).toEqual({ lineStart: 2, lineEnd: 2 });
});

test("charSpanToLineSpan spans multiple lines", () => {
  const text = "a\nbb\nccc";
  expect(charSpanToLineSpan(text, 0, 5)).toEqual({ lineStart: 1, lineEnd: 2 });
});

test("charSpanToLineSpan defaults length to a zero-width point", () => {
  const text = "a\nbb\nccc";
  expect(charSpanToLineSpan(text, text.indexOf("ccc"))).toEqual({ lineStart: 3, lineEnd: 3 });
});

test("charSpanToLineSpan clamps out-of-range indices", () => {
  const text = "a\nbb\nccc";
  expect(charSpanToLineSpan(text, -10, 0)).toEqual({ lineStart: 1, lineEnd: 1 });
  expect(charSpanToLineSpan(text, 999, 5)).toEqual({ lineStart: 3, lineEnd: 3 });
});
