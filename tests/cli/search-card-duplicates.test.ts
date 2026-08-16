/**
 * `o2b search --cards` surfaces the merged-away duplicate locations
 * (what-the-index-already-knew, task D follow-up).
 *
 * The full-disclosure transcript and `--json` payload both name every
 * location a byte-identical passage was folded from. The cards projection
 * named none: the value was computed end-to-end and dropped at the card
 * boundary, so the token-cheap layer said "one hit here" about a passage
 * that lives at three paths.
 *
 * Absent, not null, when nothing was merged - in both projections.
 */

import { describe, expect, test } from "bun:test";

import { jsonForOutcome, renderOutcomeHuman } from "../../src/cli/search/outcome-render.ts";
import { toSearchCard } from "../../src/core/search/cards.ts";
import type { DuplicatePassageLocation } from "../../src/core/search/search-result.ts";
import type { BrainSearchResult, SearchOutcome } from "../../src/core/search/types.ts";

const QUERY = "quantum entanglement";

const FOLDED: ReadonlyArray<DuplicatePassageLocation> = Object.freeze([
  Object.freeze({
    documentId: 7,
    chunkId: 42,
    path: "archive/entanglement-copy.md",
    title: "Entanglement (copy)",
    startLine: 3,
    endLine: 9,
  }),
  Object.freeze({
    documentId: 8,
    chunkId: 43,
    path: "inbox/entanglement-again.md",
    title: null,
    startLine: 1,
    endLine: 1,
  }),
]);

const EXPECTED_POINTERS = ["archive/entanglement-copy.md:L3-L9", "inbox/entanglement-again.md:L1"];

function resultWith(duplicates?: ReadonlyArray<DuplicatePassageLocation>): BrainSearchResult {
  return Object.freeze({
    documentId: 1,
    chunkId: 1,
    path: "physics/entanglement.md",
    title: "Entanglement",
    content: "Quantum entanglement links two particles at a distance.",
    startLine: 1,
    endLine: 9,
    score: 1.5,
    keywordScore: 1.5,
    semanticScore: 0,
    linkBoost: 0,
    recencyBoost: 0,
    searchType: "keyword" as const,
    reasons: Object.freeze(["keyword: 1.50"]),
    ...(duplicates !== undefined ? { duplicates: Object.freeze(duplicates) } : {}),
  });
}

function cardsOutcome(duplicates?: ReadonlyArray<DuplicatePassageLocation>): SearchOutcome {
  return Object.freeze({
    results: Object.freeze([]),
    cards: Object.freeze([toSearchCard(resultWith(duplicates), QUERY)]),
    warnings: Object.freeze([]),
    total: 1,
    // Neutral match quality: the folding assertions never read it, and 1 is
    // what the coverage report yields when there is no term mass to weigh.
    idfWeightedCoverage: 1,
  });
}

function jsonCards(outcome: SearchOutcome): Array<Record<string, unknown>> {
  return (jsonForOutcome(outcome) as { cards: Array<Record<string, unknown>> }).cards;
}

describe("search card duplicates on the CLI", () => {
  test("--json names every folded location on the surviving card", () => {
    expect(jsonCards(cardsOutcome(FOLDED))[0]!["duplicate_pointers"]).toEqual(EXPECTED_POINTERS);
  });

  test("--json omits the key entirely when nothing was merged", () => {
    const card = jsonCards(cardsOutcome())[0]!;
    expect("duplicate_pointers" in card).toBe(false);
    expect(JSON.stringify(card)).not.toContain("duplicate");
  });

  test("the cards transcript names the folded locations", () => {
    const rendered = renderOutcomeHuman(cardsOutcome(FOLDED), false, QUERY);
    expect(rendered.split("\n")).toContain(`    duplicates: ${EXPECTED_POINTERS.join(", ")}`);
  });

  test("the cards transcript renders no duplicates line when nothing was merged", () => {
    expect(renderOutcomeHuman(cardsOutcome(), false, QUERY)).not.toContain("duplicates:");
  });
});
