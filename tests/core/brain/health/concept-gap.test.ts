/**
 * Concept-gap detector (F2).
 *
 * A concept gap is a recurring *entity* (a proper-noun-ish anchor, per
 * the shared language-agnostic entity extractor) whose document
 * frequency reaches a threshold yet is not covered by any preference
 * topic. Using entities rather than raw tokens keeps lowercase function
 * words ("the", "use") out of the result without any stopword list -
 * the filter is structural (codepoint case / shape), not lexical.
 */

import { describe, expect, test } from "bun:test";

import { detectConceptGaps } from "../../../../src/core/brain/health/concept-gap.ts";

describe("detectConceptGaps", () => {
  test("flags an entity recurring across enough distinct principles", () => {
    const gaps = detectConceptGaps(
      [
        "Kanban board needs grooming",
        "the Kanban workflow is slow",
        "review Kanban tasks weekly",
        "unrelated note about Coffee",
      ],
      ["coffee-habits"],
      { minFrequency: 3 },
    );
    expect(gaps).toEqual([{ term: "kanban", frequency: 3 }]);
  });

  test("an entity covered by a preference topic is not a gap", () => {
    const gaps = detectConceptGaps(
      [
        "Kanban board needs grooming",
        "the Kanban workflow is slow",
        "review Kanban tasks weekly",
      ],
      ["kanban-grooming"],
      { minFrequency: 3 },
    );
    expect(gaps).toEqual([]);
  });

  test("a multi-word entity covered by a hyphenated topic is not a gap", () => {
    const gaps = detectConceptGaps(
      [
        "Open Second Brain stores notes",
        "Open Second Brain syncs peers",
        "Open Second Brain ranks results",
      ],
      ["open-second-brain"],
      { minFrequency: 3 },
    );
    expect(gaps).toEqual([]);
  });

  test("lowercase function words are never entities", () => {
    const gaps = detectConceptGaps(
      ["use the tool", "use the result", "use the output"],
      [],
      { minFrequency: 3 },
    );
    expect(gaps).toEqual([]);
  });

  test("an entity below the frequency threshold is not a gap", () => {
    const gaps = detectConceptGaps(
      ["Kanban once", "Kanban twice"],
      [],
      { minFrequency: 3 },
    );
    expect(gaps).toEqual([]);
  });

  test("repeats within one principle count once (document frequency)", () => {
    const gaps = detectConceptGaps(
      ["Kanban Kanban Kanban Kanban"],
      [],
      { minFrequency: 2 },
    );
    expect(gaps).toEqual([]);
  });

  test("findings are ordered by frequency desc then term asc", () => {
    const gaps = detectConceptGaps(
      ["Alpha", "Alpha", "Alpha", "Beta", "Beta", "Beta", "Beta"],
      [],
      { minFrequency: 3 },
    );
    expect(gaps).toEqual([
      { term: "beta", frequency: 4 },
      { term: "alpha", frequency: 3 },
    ]);
  });

  test("is language-agnostic", () => {
    const gaps = detectConceptGaps(
      ["Бэклог растёт", "Бэклог завис", "разгрести Бэклог"],
      [],
      { minFrequency: 3 },
    );
    expect(gaps).toEqual([{ term: "бэклог", frequency: 3 }]);
  });
});
