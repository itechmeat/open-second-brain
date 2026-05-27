/**
 * Tests for the shared "sign of record" helper lifted out of
 * `dream.ts` so the contradiction detector and the dream pass agree on
 * one polarity definition. The evidence-based tier-1 derivation is the
 * reusable part; the tie-break (`pos >= neg -> positive`) and the
 * unresolved-as-skip behaviour mirror dream verbatim.
 */

import { describe, expect, test } from "bun:test";

import { BRAIN_SIGNAL_SIGN } from "../../../src/core/brain/types.ts";
import {
  countSigns,
  dominantSignFromCounts,
  dominantSignOf,
} from "../../../src/core/brain/sign.ts";

describe("countSigns", () => {
  test("counts positive and negative signs", () => {
    const c = countSigns([
      BRAIN_SIGNAL_SIGN.positive,
      BRAIN_SIGNAL_SIGN.positive,
      BRAIN_SIGNAL_SIGN.negative,
    ]);
    expect(c).toEqual({ pos: 2, neg: 1 });
  });

  test("empty input yields zero counts", () => {
    expect(countSigns([])).toEqual({ pos: 0, neg: 0 });
  });
});

describe("dominantSignFromCounts", () => {
  test("no signs is unknown", () => {
    expect(dominantSignFromCounts(0, 0)).toBe("unknown");
  });

  test("positive majority is positive", () => {
    expect(dominantSignFromCounts(3, 1)).toBe(BRAIN_SIGNAL_SIGN.positive);
  });

  test("negative majority is negative", () => {
    expect(dominantSignFromCounts(1, 3)).toBe(BRAIN_SIGNAL_SIGN.negative);
  });

  test("tie breaks to positive (matches dream's pos >= neg)", () => {
    expect(dominantSignFromCounts(2, 2)).toBe(BRAIN_SIGNAL_SIGN.positive);
  });
});

describe("dominantSignOf", () => {
  const byId = new Map([
    ["sig-a", BRAIN_SIGNAL_SIGN.positive],
    ["sig-b", BRAIN_SIGNAL_SIGN.positive],
    ["sig-c", BRAIN_SIGNAL_SIGN.negative],
  ]);

  test("resolves wikilinks and returns dominant sign", () => {
    expect(dominantSignOf(["[[sig-a]]", "[[sig-c]]", "[[sig-b]]"], byId)).toBe(
      BRAIN_SIGNAL_SIGN.positive,
    );
  });

  test("ignores wikilinks that do not resolve in the map", () => {
    expect(dominantSignOf(["[[sig-c]]", "[[sig-missing]]"], byId)).toBe(
      BRAIN_SIGNAL_SIGN.negative,
    );
  });

  test("returns unknown when no cited signal resolves", () => {
    expect(dominantSignOf(["[[sig-missing]]", "[[other]]"], byId)).toBe("unknown");
  });

  test("returns unknown for an empty evidence list", () => {
    expect(dominantSignOf([], byId)).toBe("unknown");
  });
});
