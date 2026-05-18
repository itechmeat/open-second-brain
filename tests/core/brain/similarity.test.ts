/**
 * Tests for the lifted similarity helpers (`tokenise`, `jaccard`).
 * The implementations are byte-for-byte the ones that lived inside
 * `doctor.ts` until v0.10.5 — these cases are the regression coverage
 * for the lift-out, plus a few sanity checks on multi-byte input that
 * the doctor lint already relies on implicitly.
 */

import { describe, expect, test } from "bun:test";

import { jaccard, tokenise } from "../../../src/core/brain/similarity.ts";

describe("tokenise", () => {
  test("lowercases and splits on punctuation", () => {
    const tokens = tokenise(
      "Use imperative voice; describe what the commit DOES",
    );
    expect(tokens.has("use")).toBe(true);
    expect(tokens.has("imperative")).toBe(true);
    expect(tokens.has("does")).toBe(true);
    expect(tokens.has(";")).toBe(false);
  });

  test("keeps multi-byte (Cyrillic) tokens", () => {
    const tokens = tokenise("Используй императив");
    expect(tokens.has("используй")).toBe(true);
    expect(tokens.has("императив")).toBe(true);
  });

  test("filters single-character tokens", () => {
    const tokens = tokenise("a b cd");
    expect(tokens.has("a")).toBe(false);
    expect(tokens.has("b")).toBe(false);
    expect(tokens.has("cd")).toBe(true);
  });

  test("retains digits as tokens", () => {
    const tokens = tokenise("commit-42 ships v10");
    expect(tokens.has("commit-42")).toBe(true);
    expect(tokens.has("ships")).toBe(true);
    expect(tokens.has("v10")).toBe(true);
  });
});

describe("jaccard", () => {
  test("identical sets → 1", () => {
    expect(jaccard(new Set(["a", "b"]), new Set(["a", "b"]))).toBe(1);
  });

  test("disjoint sets → 0", () => {
    expect(jaccard(new Set(["a"]), new Set(["b"]))).toBe(0);
  });

  test("both empty → 0", () => {
    expect(jaccard(new Set(), new Set())).toBe(0);
  });

  test("partial overlap → |intersection| / |union|", () => {
    expect(
      jaccard(new Set(["a", "b", "c"]), new Set(["b", "c", "d"])),
    ).toBeCloseTo(2 / 4, 5);
  });
});
