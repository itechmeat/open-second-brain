/**
 * `rrf` fusion honours the per-query intent profile (Task B).
 *
 * Reciprocal-rank fusion used to drop the intent multipliers on the floor:
 * the relevance term was the raw fused rank sum, so a caller who quoted a
 * phrase got no lexical preference at all under `search_fusion_mode: rrf`,
 * while the same query in the default `linear` mode did. These tests pin
 * the three properties that fix has to hold at once:
 *
 *   1. the two fusion modes agree about a verbatim keyword hit when the
 *      query plan classified the query as `exact`;
 *   2. a neutral profile reproduces classic, weightless RRF exactly - the
 *      weighting is inert until a query actually declares an intent;
 *   3. the default `linear` path is untouched by the rrf knobs.
 */

import { test, expect } from "bun:test";

import { rankResults } from "../../../src/core/search/ranker.ts";
import { rrfFuse, DEFAULT_RRF_K } from "../../../src/core/search/fusion.ts";
import { buildQueryPlan, NEUTRAL_PROFILE } from "../../../src/core/search/query-plan.ts";
import { SearchError } from "../../../src/core/search/search-error.ts";
import type { KeywordHit, SemanticHit, HydratedChunk } from "../../../src/core/search/store.ts";
import type { BrainSearchResult } from "../../../src/core/search/types.ts";

const NOW = 1_750_000_000_000;
/** A year old: the recency layer contributes the same value to every row. */
const OLD = NOW / 1000 - 365 * 24 * 3600;

const KEYWORD_WEIGHT = 0.6;
const SEMANTIC_WEIGHT = 0.4;
const LIMIT = 10;

/** Chunk ids, named for the role each one plays in the fixture. */
const TOP_KEYWORD = 1;
/** The verbatim hit under test: strong in the keyword lane, absent from semantic. */
const VERBATIM = 2;
const WEAK_KEYWORD = 3;
/** The rival: sole occupant of the semantic lane, so rank 1 there. */
const SEMANTIC_ONLY = 4;

function hyd(chunkId: number): HydratedChunk {
  return Object.freeze({
    chunkId,
    documentId: chunkId * 10,
    path: `doc${chunkId}.md`,
    title: `Doc ${chunkId}`,
    content: `chunk ${chunkId}`,
    startLine: 1,
    endLine: 1,
    mtime: OLD,
  });
}

const KEYWORD: ReadonlyArray<KeywordHit> = [
  { chunkId: TOP_KEYWORD, documentId: TOP_KEYWORD * 10, bm25: -10 },
  { chunkId: VERBATIM, documentId: VERBATIM * 10, bm25: -9.5 },
  { chunkId: WEAK_KEYWORD, documentId: WEAK_KEYWORD * 10, bm25: -1 },
];
const SEMANTIC: ReadonlyArray<SemanticHit> = [
  { chunkId: SEMANTIC_ONLY, documentId: SEMANTIC_ONLY * 10, distance: 0.6 },
];
const HYDRATED: ReadonlyMap<number, HydratedChunk> = new Map(
  [TOP_KEYWORD, VERBATIM, WEAK_KEYWORD, SEMANTIC_ONLY].map((id) => [id, hyd(id)]),
);

function inputs() {
  return {
    keyword: KEYWORD,
    semantic: SEMANTIC,
    hydrated: HYDRATED,
    inboundLinkSources: new Map<number, ReadonlySet<number>>(),
    tagsByDoc: new Map<number, ReadonlySet<string>>(),
  };
}

/** Zero-based position of a chunk in a ranking. */
function positionOf(ranked: ReadonlyArray<BrainSearchResult>, chunkId: number): number {
  return ranked.findIndex((r) => r.chunkId === chunkId);
}

// ── 1. the two modes agree about a verbatim hit under an `exact` plan ───────

/** A quoted phrase: the classifier's own `exact` trigger, not a hand-built profile. */
const QUOTED_QUERY = '"canary rollout runbook"';

test("a quoted phrase classifies as exact, so the profile favours the keyword lane", () => {
  const plan = buildQueryPlan(QUOTED_QUERY);
  expect(plan.intent).toBe("exact");
  expect(plan.weightProfile.keywordMul).toBeGreaterThan(plan.weightProfile.semanticMul);
});

test("rrf mode prefers the verbatim keyword hit over the semantic-only rival, as linear does", () => {
  const plan = buildQueryPlan(QUOTED_QUERY);
  const base = {
    keywordWeight: KEYWORD_WEIGHT,
    semanticWeight: SEMANTIC_WEIGHT,
    limit: LIMIT,
    nowMs: NOW,
    weightProfile: plan.weightProfile,
  } as const;

  const linear = rankResults(inputs(), base);
  expect(positionOf(linear, VERBATIM)).toBeLessThan(positionOf(linear, SEMANTIC_ONLY));

  const fused = rankResults(inputs(), { ...base, fusionMode: "rrf", rrfK: DEFAULT_RRF_K });
  expect(positionOf(fused, VERBATIM)).toBeLessThan(positionOf(fused, SEMANTIC_ONLY));
});

test("without a declared intent, rrf keeps rewarding the other lane - the profile is the cause", () => {
  // The same fixture with a neutral profile: the semantic-only chunk is
  // rank 1 of its lane and outranks the verbatim hit, which is rank 2 of
  // its own. That is classic RRF and stays true - the previous test
  // changes ONLY because the query declared an intent.
  const fused = rankResults(inputs(), {
    keywordWeight: KEYWORD_WEIGHT,
    semanticWeight: SEMANTIC_WEIGHT,
    limit: LIMIT,
    nowMs: NOW,
    fusionMode: "rrf",
    rrfK: DEFAULT_RRF_K,
  });
  expect(positionOf(fused, SEMANTIC_ONLY)).toBeLessThan(positionOf(fused, VERBATIM));
});

// ── 2. a neutral profile reproduces classic RRF exactly ────────────────────

test("a neutral profile fuses byte-identically to weightless rrf", () => {
  const base = {
    keywordWeight: KEYWORD_WEIGHT,
    semanticWeight: SEMANTIC_WEIGHT,
    limit: LIMIT,
    nowMs: NOW,
    fusionMode: "rrf",
    rrfK: DEFAULT_RRF_K,
  } as const;
  const withoutProfile = JSON.stringify(rankResults(inputs(), base));
  const withNeutral = JSON.stringify(
    rankResults(inputs(), { ...base, weightProfile: NEUTRAL_PROFILE }),
  );
  expect(withNeutral).toBe(withoutProfile);
});

test("rrfFuse with unit lane weights equals rrfFuse without them", () => {
  const lanes = {
    keywordRankedChunkIds: [1, 2, 3],
    semanticRankedChunkIds: [3, 4],
    k: DEFAULT_RRF_K,
  };
  const weightless = [...rrfFuse(lanes).entries()];
  const unit = [...rrfFuse({ ...lanes, laneWeights: { keyword: 1, semantic: 1 } }).entries()];
  expect(unit).toEqual(weightless);
});

test("rrfFuse scales the per-lane contribution, not a post-fusion score", () => {
  // One chunk per lane at rank 1: weightless they tie, weighted they do
  // not, and the ratio of raw contributions is the ratio of the weights.
  // A post-fusion multiplier could not separate them at all.
  const fused = rrfFuse({
    keywordRankedChunkIds: [1],
    semanticRankedChunkIds: [2],
    k: DEFAULT_RRF_K,
    laneWeights: { keyword: 1.3, semantic: 0.7 },
  });
  expect(fused.get(1)!).toBeGreaterThan(fused.get(2)!);
  const tied = rrfFuse({
    keywordRankedChunkIds: [1],
    semanticRankedChunkIds: [2],
    k: DEFAULT_RRF_K,
  });
  expect(tied.get(1)!).toBe(tied.get(2)!);
});

test("a non-positive lane weight is refused, naming the cause and the exit", () => {
  const lanes = { keywordRankedChunkIds: [1], semanticRankedChunkIds: [2], k: DEFAULT_RRF_K };
  expect(() => rrfFuse({ ...lanes, laneWeights: { keyword: 0, semantic: 1 } })).toThrow(
    SearchError,
  );
  expect(() => rrfFuse({ ...lanes, laneWeights: { keyword: -1, semantic: 1 } })).toThrow(
    /o2b search weights --reset/,
  );
  expect(() => rrfFuse({ ...lanes, laneWeights: { keyword: 1, semantic: Number.NaN } })).toThrow(
    /semantic/,
  );
});

// ── 3. the linear path is inert to the rrf knobs ───────────────────────────

test("linear ranking is byte-identical across every intent profile and rrf knob", () => {
  // Flag-off (`fusionMode` omitted) against flag-on (`linear` named, and
  // an rrf damping constant supplied) for each intent the classifier can
  // produce. Full JSON, so scores, reasons and breakdowns are compared,
  // not just the order.
  const queries = [
    "", // neutral
    QUOTED_QUERY, // exact
    "[[Deploy Canary]]", // entity
    "how do we usually roll a release out to production safely", // broad
  ];
  const seen = new Set<string>();
  for (const query of queries) {
    const plan = buildQueryPlan(query);
    seen.add(plan.intent);
    const base = {
      keywordWeight: KEYWORD_WEIGHT,
      semanticWeight: SEMANTIC_WEIGHT,
      limit: LIMIT,
      nowMs: NOW,
      weightProfile: plan.weightProfile,
    } as const;
    const omitted = JSON.stringify(rankResults(inputs(), base));
    const explicit = JSON.stringify(rankResults(inputs(), { ...base, fusionMode: "linear" }));
    const withRrfK = JSON.stringify(
      rankResults(inputs(), { ...base, fusionMode: "linear", rrfK: 1 }),
    );
    expect(explicit).toBe(omitted);
    expect(withRrfK).toBe(omitted);
  }
  // The matrix really did exercise four distinct profiles.
  expect(seen).toEqual(new Set(["neutral", "exact", "entity", "broad"]));
});
