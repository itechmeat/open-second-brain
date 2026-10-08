import { test, expect } from "bun:test";

import { rrfFuse, isFusionMode, DEFAULT_RRF_K } from "../../../src/core/search/fusion.ts";

test("DEFAULT_RRF_K is the canonical 60", () => {
  expect(DEFAULT_RRF_K).toBe(60);
});

test("isFusionMode accepts the two modes and rejects others", () => {
  expect(isFusionMode("linear")).toBe(true);
  expect(isFusionMode("rrf")).toBe(true);
  expect(isFusionMode("weighted")).toBe(false);
  expect(isFusionMode("")).toBe(false);
});

test("empty lanes produce an empty fusion map", () => {
  expect(rrfFuse({ keywordRankedChunkIds: [], semanticRankedChunkIds: [], k: 60 }).size).toBe(0);
});

test("a chunk ranked top in both lanes scores highest", () => {
  // chunk 1: rank 1 in both lanes. chunk 2: rank 2 keyword, absent semantic.
  // chunk 3: absent keyword, rank 1 semantic... order them.
  const fused = rrfFuse({
    keywordRankedChunkIds: [1, 2],
    semanticRankedChunkIds: [1, 3],
    k: 60,
  });
  expect(fused.get(1)!).toBeGreaterThan(fused.get(2)!);
  expect(fused.get(1)!).toBeGreaterThan(fused.get(3)!);
});

test("normalised scores span [0,1] with the best at 1 and worst at 0", () => {
  const fused = rrfFuse({
    keywordRankedChunkIds: [1, 2, 3],
    semanticRankedChunkIds: [1, 2, 3],
    k: 60,
  });
  const values = [...fused.values()];
  expect(Math.max(...values)).toBeCloseTo(1, 9);
  expect(Math.min(...values)).toBeCloseTo(0, 9);
});

test("reciprocal-rank ordering matches rank sums", () => {
  // keyword: A(1) B(2) C(3); semantic: C(1) B(2) A(3).
  // RRF sums: A = 1/61 + 1/63; B = 1/62 + 1/62; C = 1/63 + 1/61.
  // A and C tie; B sits between by raw sum (2/62 vs 1/61+1/63).
  const fused = rrfFuse({
    keywordRankedChunkIds: [10, 20, 30],
    semanticRankedChunkIds: [30, 20, 10],
    k: 60,
  });
  expect(fused.get(10)!).toBeCloseTo(fused.get(30)!, 9);
  // A/C raw = 1/61 + 1/63 ≈ 0.032277; B raw = 2/62 ≈ 0.032258 -> B is lowest.
  expect(fused.get(20)!).toBeLessThan(fused.get(10)!);
});

test("a single populated lane still ranks by position", () => {
  const fused = rrfFuse({
    keywordRankedChunkIds: [5, 6, 7],
    semanticRankedChunkIds: [],
    k: 60,
  });
  expect(fused.get(5)!).toBeGreaterThan(fused.get(6)!);
  expect(fused.get(6)!).toBeGreaterThan(fused.get(7)!);
});

// ─── structural direct-hit precedence (truth-correctable-time-aware) ─────────

import { rankResults } from "../../../src/core/search/ranker.ts";
import { applyRelationalRerankPin } from "../../../src/core/search/pipeline/relational-arm.ts";
import type { KeywordHit, SemanticHit, HydratedChunk } from "../../../src/core/search/store.ts";
import type { BrainSearchResult } from "../../../src/core/search/search-result.ts";

const NOW = 1_750_000_000_000;
const OLD = NOW / 1000 - 365 * 24 * 3600; // no recency boost

function hyd(chunkId: number, docId: number): HydratedChunk {
  return Object.freeze({
    chunkId,
    documentId: docId,
    path: `doc${docId}.md`,
    title: `Doc ${docId}`,
    content: `chunk ${chunkId}`,
    startLine: 1,
    endLine: 1,
    mtime: OLD,
  });
}

/**
 * keyword: 1 (rank 1) and 9 (a DEEP direct hit, rank 2); semantic: 2;
 * relational lane: 3 alone. On raw RRF the relational-only rank 1 ties the
 * keyword rank 1 and clears the deep direct hit - exactly the float the
 * structural admission exists to prevent.
 */
function precedenceInputs() {
  const keyword: KeywordHit[] = [
    { chunkId: 1, documentId: 10, bm25: -10 },
    { chunkId: 9, documentId: 90, bm25: -0.5 },
  ];
  const semantic: SemanticHit[] = [{ chunkId: 2, documentId: 20, distance: 0.1 }];
  const hydrated = new Map<number, HydratedChunk>([
    [1, hyd(1, 10)],
    [2, hyd(2, 20)],
    [9, hyd(9, 90)],
    [3, hyd(3, 30)],
  ]);
  return {
    keyword,
    semantic,
    hydrated,
    inboundLinkSources: new Map(),
    tagsByDoc: new Map(),
    relationalRankedChunkIds: [3],
  };
}

const RRF_OPTS = {
  keywordWeight: 0.6,
  semanticWeight: 0.6,
  limit: 10,
  nowMs: NOW,
  fusionMode: "rrf" as const,
  rrfK: 60,
};

test("a relational-only row is admitted after the last organic row", () => {
  const ranked = rankResults(precedenceInputs(), RRF_OPTS);
  const ids = ranked.map((r) => r.chunkId);
  expect(ids).toEqual([1, 2, 9, 3]);
  expect(ranked[ranked.length - 1]!.searchType).toBe("link");
});

test("a relational-only row at relational-rank 1 never outranks a keyword direct hit", () => {
  const ranked = rankResults(precedenceInputs(), RRF_OPTS);
  const ids = ranked.map((r) => r.chunkId);
  // Chunk 9 is a keyword direct hit two ranks deep; chunk 3 leads the
  // relational lane. The direct hit stays above it.
  expect(ids.indexOf(9)).toBeLessThan(ids.indexOf(3));
});

test("with the arm absent or empty the fused order is byte-identical", () => {
  const { relationalRankedChunkIds, ...organic } = precedenceInputs();
  const without = rankResults(organic, RRF_OPTS);
  expect(without.map((r) => r.chunkId)).toEqual([1, 2, 9]);
  const emptyLane = rankResults({ ...organic, relationalRankedChunkIds: [] }, RRF_OPTS);
  expect(JSON.stringify(emptyLane)).toBe(JSON.stringify(without));
});

/** A result row with controllable direct-hit and origin markers. */
function pinRow(
  chunkId: number,
  opts: { keywordScore?: number; relational?: boolean } = {},
): BrainSearchResult {
  return Object.freeze({
    documentId: chunkId * 10,
    chunkId,
    path: `doc${chunkId}.md`,
    title: null,
    content: `chunk ${chunkId}`,
    startLine: 1,
    endLine: 1,
    score: 1,
    keywordScore: opts.keywordScore ?? 0,
    semanticScore: 0,
    linkBoost: 0,
    recencyBoost: 0,
    searchType: (opts.keywordScore ?? 0) > 0 ? "keyword" : "link",
    ...(opts.relational ? { relationalOrigin: true } : {}),
    reasons: Object.freeze([]),
  });
}

test("the rerank pin holds a relational-origin row below the organic direct hits", () => {
  // Pre-rerank: direct hit, semantic row, then the relational block.
  // The cross-encoder lifts relational row 3 above the direct hit.
  const pre = [
    pinRow(1, { keywordScore: 0.9 }),
    pinRow(2),
    pinRow(3, { relational: true }),
    pinRow(4, { relational: true }),
  ];
  const post = [
    pinRow(3, { relational: true }),
    pinRow(1, { keywordScore: 0.9 }),
    pinRow(2),
    pinRow(4, { relational: true }),
  ];
  const pinned = applyRelationalRerankPin(pre, post);
  // Row 3 lands just below the deepest direct hit - the only organic row it
  // may not cross is the hit; the semantic row between is crossed freely,
  // and the move never sinks it past its pre-rerank floor (index 2).
  expect(pinned.map((r) => r.chunkId)).toEqual([1, 2, 3, 4]);
  expect(pinned[2]!.reasons).toContain("relational_pin: held below the organic direct hits");
  // The peer that stayed put keeps its relative line: 3 before 4.
  expect(pinned.map((r) => r.chunkId).indexOf(3)).toBeLessThan(
    pinned.map((r) => r.chunkId).indexOf(4),
  );
});

test("the direct-hit ceiling wins over the pre-rerank floor when they conflict", () => {
  // Pre-rerank floor of row 3 is 2, but two direct hits now sit above the
  // ceiling line; the structural admission wins and the row is held below
  // both, named by the receipt.
  const pre = [pinRow(1, { keywordScore: 0.9 }), pinRow(2), pinRow(3, { relational: true })];
  const post = [
    pinRow(3, { relational: true }),
    pinRow(1, { keywordScore: 0.9 }),
    pinRow(5, { keywordScore: 0.8 }),
  ];
  const pinned = applyRelationalRerankPin(pre, post);
  expect(pinned.map((r) => r.chunkId)).toEqual([1, 5, 3]);
  expect(pinned[2]!.reasons).toContain("relational_pin: held below the organic direct hits");
});

test("a pool already below the direct hits is returned untouched by the ceiling", () => {
  const pre = [pinRow(1, { keywordScore: 0.9 }), pinRow(2), pinRow(3, { relational: true })];
  const post = [pinRow(1, { keywordScore: 0.9 }), pinRow(3, { relational: true }), pinRow(2)];
  const pinned = applyRelationalRerankPin(pre, post);
  expect(pinned.map((r) => r.chunkId)).toEqual([1, 3, 2]);
  expect(pinned.every((r) => !r.reasons.some((x) => x.startsWith("relational_pin:")))).toBe(true);
});
