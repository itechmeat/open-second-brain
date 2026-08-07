/**
 * `o2b search` surfaces the merged-away duplicate locations
 * (what-the-index-already-knew, task D landed the merge, task E landed
 * the boundary).
 *
 * The exact-duplicate merge records every location a byte-identical
 * passage was folded from on `BrainSearchResult.duplicates`. Neither CLI
 * projection read it: the `--json` payload is an explicit field list and
 * the human transcript rendered nothing, so a value computed end-to-end
 * was dropped at the boundary.
 *
 * Absent, not null, when nothing was merged - in both projections.
 */

import { describe, expect, test } from "bun:test";

import { jsonForOutcome, renderOutcomeHuman } from "../../src/cli/search/outcome-render.ts";
import type { DuplicatePassageLocation } from "../../src/core/search/search-result.ts";
import type { BrainSearchResult, SearchOutcome } from "../../src/core/search/types.ts";

const QUERY = "quantum entanglement";

const FOLDED: DuplicatePassageLocation = Object.freeze({
  documentId: 7,
  chunkId: 42,
  path: "archive/entanglement-copy.md",
  title: "Entanglement (copy)",
  startLine: 3,
  endLine: 9,
});

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

function outcomeWith(duplicates?: ReadonlyArray<DuplicatePassageLocation>): SearchOutcome {
  return Object.freeze({
    results: Object.freeze([resultWith(duplicates)]),
    warnings: Object.freeze([]),
    total: 1,
  });
}

function jsonRows(outcome: SearchOutcome): Array<Record<string, unknown>> {
  return (jsonForOutcome(outcome) as { results: Array<Record<string, unknown>> }).results;
}

describe("search duplicate locations on the CLI", () => {
  test("--json names every folded location on the surviving row", () => {
    const row = jsonRows(outcomeWith([FOLDED]))[0]!;
    expect(row["duplicates"]).toEqual([
      {
        path: FOLDED.path,
        title: FOLDED.title,
        start_line: FOLDED.startLine,
        end_line: FOLDED.endLine,
        document_id: FOLDED.documentId,
        chunk_id: FOLDED.chunkId,
      },
    ]);
  });

  test("--json omits the key entirely when nothing was merged", () => {
    const row = jsonRows(outcomeWith())[0]!;
    expect("duplicates" in row).toBe(false);
  });

  test("the human transcript names the folded locations as line pointers", () => {
    const rendered = renderOutcomeHuman(outcomeWith([FOLDED]), false, QUERY);
    expect(rendered.split("\n")).toContain(
      `    duplicates: ${FOLDED.path}:L${FOLDED.startLine}-L${FOLDED.endLine}`,
    );
  });

  test("the human transcript renders no duplicates line when nothing was merged", () => {
    const rendered = renderOutcomeHuman(outcomeWith(), false, QUERY);
    expect(rendered).not.toContain("duplicates:");
  });
});
