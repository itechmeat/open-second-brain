/**
 * The shared exactly-one decision (`resolveUniqueMatch`). Two features in
 * this wave bind a term to a target only when exactly one candidate
 * carries it - the repair lane binding a mention term to a corpus page,
 * pre-extract binding a relative import specifier to an ingested file.
 * Both must answer ambiguity the same way, so the discipline lives in one
 * typed resolver instead of two call sites that can drift.
 */

import { describe, expect, test } from "bun:test";

import { resolveUniqueMatch } from "../../../src/core/graph/unique-match.ts";

describe("resolveUniqueMatch", () => {
  test("an empty candidate list resolves to none", () => {
    expect(resolveUniqueMatch([])).toEqual({ status: "none" });
  });

  test("a single candidate resolves to unique with that target", () => {
    expect(resolveUniqueMatch(["Notes/only.md"])).toEqual({
      status: "unique",
      target: "Notes/only.md",
    });
  });

  test.each([
    ["two", ["Notes/b.md", "Notes/a.md", "Notes/b.md"], ["Notes/b.md", "Notes/a.md"]],
    ["three", ["a", "b", "a", "c", "b", "a"], ["a", "b", "c"]],
  ])(
    "%s distinct candidates resolve to ambiguous, each once in first-occurrence order",
    (_count, candidates, matches) => {
      expect(resolveUniqueMatch(candidates)).toEqual({ status: "ambiguous", matches });
    },
  );

  test("a repeated identical candidate is deduped before the decision", () => {
    // One page naming a term twice must never read as two pages naming it.
    expect(resolveUniqueMatch(["Notes/same.md", "Notes/same.md"])).toEqual({
      status: "unique",
      target: "Notes/same.md",
    });
  });
});
