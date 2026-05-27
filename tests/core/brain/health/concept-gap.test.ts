/**
 * Concept-gap detector (F2).
 *
 * A concept gap is a token that recurs across the corpus (document
 * frequency at or above a threshold) yet is not covered by any
 * preference topic. Frequency-only and language-agnostic: no notion of
 * importance beyond recurrence, no stopword list.
 */

import { describe, expect, test } from "bun:test";

import { detectConceptGaps } from "../../../../src/core/brain/health/concept-gap.ts";

describe("detectConceptGaps", () => {
  test("flags a term recurring across enough distinct principles", () => {
    const gaps = detectConceptGaps(
      [
        "kanban board needs grooming",
        "the kanban workflow is slow",
        "review kanban tasks weekly",
        "unrelated note about coffee",
      ],
      ["coffee-habits"],
      { minFrequency: 3 },
    );
    expect(gaps).toEqual([{ term: "kanban", frequency: 3 }]);
  });

  test("a term covered by a preference topic is not a gap", () => {
    const gaps = detectConceptGaps(
      [
        "kanban board needs grooming",
        "the kanban workflow is slow",
        "review kanban tasks weekly",
      ],
      ["kanban-grooming"],
      { minFrequency: 3 },
    );
    expect(gaps).toEqual([]);
  });

  test("a term below the frequency threshold is not a gap", () => {
    const gaps = detectConceptGaps(
      ["kanban once", "kanban twice"],
      [],
      { minFrequency: 3 },
    );
    expect(gaps).toEqual([]);
  });

  test("repeats within one principle count once (document frequency)", () => {
    const gaps = detectConceptGaps(
      ["kanban kanban kanban kanban"],
      [],
      { minFrequency: 2 },
    );
    expect(gaps).toEqual([]);
  });

  test("single-codepoint tokens are excluded", () => {
    const gaps = detectConceptGaps(
      ["a x", "a y", "a z"],
      [],
      { minFrequency: 3 },
    );
    expect(gaps).toEqual([]);
  });

  test("findings are ordered by frequency desc then term asc", () => {
    const gaps = detectConceptGaps(
      [
        "alpha beta",
        "alpha beta",
        "alpha beta",
        "alpha",
      ],
      [],
      { minFrequency: 3 },
    );
    expect(gaps).toEqual([
      { term: "alpha", frequency: 4 },
      { term: "beta", frequency: 3 },
    ]);
  });

  test("is language-agnostic", () => {
    const gaps = detectConceptGaps(
      ["бэклог растёт", "бэклог завис", "разгрести бэклог"],
      [],
      { minFrequency: 3 },
    );
    expect(gaps).toEqual([{ term: "бэклог", frequency: 3 }]);
  });
});
