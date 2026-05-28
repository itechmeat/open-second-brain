import { describe, expect, test } from "bun:test";

import { deriveRecallHint } from "../../../src/core/search/recall-hint.ts";

describe("deriveRecallHint", () => {
  test("returns null when there are no results", () => {
    expect(deriveRecallHint([], 0)).toBeNull();
  });

  test("summarises count, type breakdown, and the top hit", () => {
    const hint = deriveRecallHint(
      [
        { searchType: "semantic", score: 0.91, title: "Pref A" },
        { searchType: "semantic", score: 0.71, title: "Pref B" },
        { searchType: "keyword", score: 0.4, title: "Pref C" },
      ],
      12,
    )!;
    expect(hint).toContain("3 of 12");
    expect(hint).toContain("2 semantic");
    expect(hint).toContain("1 keyword");
    expect(hint).toContain("Pref A");
    expect(hint).toContain("0.91");
    expect(hint).toContain("reasons");
  });

  test("is deterministic for the same input", () => {
    const input = [{ searchType: "keyword", score: 0.5, title: "X" }];
    expect(deriveRecallHint(input, 1)).toBe(deriveRecallHint(input, 1));
  });

  test("trims an overlong title rather than dumping it whole", () => {
    const long = "Z".repeat(500);
    const hint = deriveRecallHint([{ searchType: "keyword", score: 0.5, title: long }], 1)!;
    expect(hint.length).toBeLessThan(300);
    expect(hint).toContain("…");
  });

  test("orders the breakdown by descending count", () => {
    const hint = deriveRecallHint(
      [
        { searchType: "keyword", score: 0.4, title: "a" },
        { searchType: "semantic", score: 0.9, title: "b" },
        { searchType: "semantic", score: 0.8, title: "c" },
        { searchType: "semantic", score: 0.7, title: "d" },
      ],
      4,
    )!;
    expect(hint.indexOf("3 semantic")).toBeLessThan(hint.indexOf("1 keyword"));
  });
});
