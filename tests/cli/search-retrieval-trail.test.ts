/**
 * `o2b search` renders the retrieval trail (evidence-at-the-boundary, C2).
 *
 * The property most likely to break is the one asserted first: a healthy
 * non-empty outcome renders exactly the bytes it rendered before the trail
 * existed. It is proved against a FROZEN outcome literal rendered twice -
 * once carrying a trail, once not - so the comparison measures the trail
 * and nothing else: no second search, no clock, no tolerance.
 *
 * The second property is the point of the unit: an empty answer names its
 * cause, either the degradation that produced it or the corpus statement
 * behind it, instead of a bare `(no results)`.
 */

import { describe, expect, test } from "bun:test";

import { jsonForOutcome, renderOutcomeHuman } from "../../src/cli/search/outcome-render.ts";
import {
  RETRIEVAL_DEGRADATION,
  RETRIEVAL_TRAIL_KEY,
  describeRetrievalDegradation,
} from "../../src/core/search/retrieval-trail.ts";
import type { RetrievalTrail } from "../../src/core/search/retrieval-trail.ts";
import type { BrainSearchResult, SearchOutcome } from "../../src/core/search/types.ts";

const QUERY = "widget calibration";

const RESULT: BrainSearchResult = Object.freeze({
  documentId: 1,
  chunkId: 1,
  path: "notes/clean.md",
  title: "Clean",
  content: "The widget calibration routine runs daily.",
  startLine: 1,
  endLine: 9,
  score: 1.5,
  keywordScore: 1.5,
  semanticScore: 0,
  linkBoost: 0,
  recencyBoost: 0,
  searchType: "keyword" as const,
  reasons: Object.freeze(["keyword: 1.50"]),
});

/** A degraded but non-empty answer: the lane narrowed, rows still came back. */
const DEGRADED_TRAIL: RetrievalTrail = Object.freeze({
  retrieved: 1,
  pool: 2,
  degraded: Object.freeze([
    Object.freeze({
      code: RETRIEVAL_DEGRADATION.keywordTrigramLaneFault,
      detail: Object.freeze({ fault: "shadow_incomplete" }),
    }),
  ]),
});

/** A zero-result answer a degradation accounts for. */
const EMPTY_DEGRADED_TRAIL: RetrievalTrail = Object.freeze({
  retrieved: 0,
  pool: 0,
  degraded: Object.freeze([Object.freeze({ code: RETRIEVAL_DEGRADATION.hybridDegraded })]),
});

/** A zero-result answer over an index that was searched and held nothing. */
const EMPTY_CORPUS_TRAIL: RetrievalTrail = Object.freeze({
  retrieved: 0,
  pool: 0,
  degraded: Object.freeze([]),
  empty: Object.freeze({
    state: "not_found" as const,
    reason: "no match across 12 document(s) and 40 chunk(s) indexed at 2026-08-01T00:00:00.000Z",
  }),
});

/** A zero-result answer nothing could be claimed about. */
const EMPTY_UNKNOWN_TRAIL: RetrievalTrail = Object.freeze({
  retrieved: 0,
  pool: 0,
  degraded: Object.freeze([]),
  empty: Object.freeze({
    state: "unknown" as const,
    reason: "no index exists at the configured path, so nothing was searched",
    unknownReason: "index-absent" as const,
  }),
});

function outcome(trail?: RetrievalTrail): SearchOutcome {
  return Object.freeze({
    results: Object.freeze([RESULT]),
    warnings: Object.freeze([]),
    total: 2,
    // Neutral match quality: the trail assertions never read it, and 1 is
    // what the coverage report yields when there is no term mass to weigh.
    idfWeightedCoverage: 1,
    ...(trail !== undefined ? { retrievalTrail: trail } : {}),
  });
}

function emptyOutcomeWith(trail?: RetrievalTrail): SearchOutcome {
  return Object.freeze({
    results: Object.freeze([]),
    warnings: Object.freeze([]),
    total: 0,
    // A zero-result answer covers none of the query's IDF mass.
    idfWeightedCoverage: 0,
    ...(trail !== undefined ? { retrievalTrail: trail } : {}),
  });
}

describe("the non-empty path is byte-identical to before", () => {
  test("json: a healthy outcome carries no trail key", () => {
    const payload = JSON.stringify(jsonForOutcome(outcome()));
    expect(payload).not.toContain(RETRIEVAL_TRAIL_KEY);
  });

  test("human: a degraded outcome renders exactly the healthy transcript", () => {
    // A degradation is reported on the machine surface only: the human
    // transcript already carries the lane's warning sentence, and adding a
    // second line for the same fact is what would change these bytes.
    expect(renderOutcomeHuman(outcome(DEGRADED_TRAIL), false, QUERY)).toBe(
      renderOutcomeHuman(outcome(), false, QUERY),
    );
    expect(renderOutcomeHuman(outcome(DEGRADED_TRAIL), true, QUERY)).toBe(
      renderOutcomeHuman(outcome(), true, QUERY),
    );
  });

  test("json: a degraded outcome appends the trail and touches nothing else", () => {
    const payload = jsonForOutcome(outcome(DEGRADED_TRAIL)) as Record<string, unknown>;
    expect(payload[RETRIEVAL_TRAIL_KEY]).toEqual({
      retrieved: 1,
      pool: 2,
      degraded: [
        {
          code: RETRIEVAL_DEGRADATION.keywordTrigramLaneFault,
          detail: { fault: "shadow_incomplete" },
        },
      ],
    });
    const healthy = JSON.stringify(jsonForOutcome(outcome()));
    delete payload[RETRIEVAL_TRAIL_KEY];
    expect(JSON.stringify(payload)).toBe(healthy);
  });
});

describe("an empty result names its cause", () => {
  test("a degradation renders the first code's sentence", () => {
    const rendered = renderOutcomeHuman(emptyOutcomeWith(EMPTY_DEGRADED_TRAIL), false, QUERY);
    expect(rendered).toContain(describeRetrievalDegradation(RETRIEVAL_DEGRADATION.hybridDegraded));
    expect(rendered).not.toBe(renderOutcomeHuman(emptyOutcomeWith(), false, QUERY));
  });

  test("a healthy index states not_found with a reason", () => {
    const rendered = renderOutcomeHuman(emptyOutcomeWith(EMPTY_CORPUS_TRAIL), false, QUERY);
    expect(rendered).toContain("not_found");
    expect(rendered).toContain("no match across 12 document(s)");
  });

  test("an unreadable corpus states unknown and names the reason", () => {
    const rendered = renderOutcomeHuman(emptyOutcomeWith(EMPTY_UNKNOWN_TRAIL), false, QUERY);
    expect(rendered).toContain("unknown");
    expect(rendered).toContain("index-absent");
  });

  test("with no trail at all the bare line is unchanged", () => {
    expect(renderOutcomeHuman(emptyOutcomeWith(), false, QUERY)).toContain("(no results)");
  });

  test("json: the corpus statement crosses in snake_case", () => {
    const payload = jsonForOutcome(emptyOutcomeWith(EMPTY_UNKNOWN_TRAIL)) as Record<
      string,
      Record<string, unknown>
    >;
    expect(payload[RETRIEVAL_TRAIL_KEY]!["empty"]).toEqual({
      state: "unknown",
      reason: "no index exists at the configured path, so nothing was searched",
      unknown_reason: "index-absent",
    });
  });
});
