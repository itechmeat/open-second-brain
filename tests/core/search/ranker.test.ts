import { test, expect } from "bun:test";
import { rankResults } from "../../../src/core/search/ranker.ts";
import type { KeywordHit, SemanticHit, HydratedChunk } from "../../../src/core/search/store.ts";

function hyd(chunkId: number, docId: number, mtime: number): HydratedChunk {
  return Object.freeze({
    chunkId,
    documentId: docId,
    path: `doc${docId}.md`,
    title: `Doc ${docId}`,
    content: `chunk ${chunkId}`,
    startLine: 1,
    endLine: 1,
    mtime,
  });
}

const NOW = 1_750_000_000_000; // ms
const RECENT_MTIME = NOW / 1000 - 3 * 24 * 3600; // 3 days ago in unix seconds → 0.05 recency
const OLD_MTIME = NOW / 1000 - 365 * 24 * 3600;  // >90d → 0 recency

test("union of keyword + semantic produces hybrid scoring", () => {
  const kw: KeywordHit[] = [
    { chunkId: 1, documentId: 10, bm25: -5 },
    { chunkId: 2, documentId: 11, bm25: -2 },
  ];
  const sem: SemanticHit[] = [
    { chunkId: 2, documentId: 11, distance: 0.5 },
    { chunkId: 3, documentId: 12, distance: 0.1 },
  ];
  const hydrated = new Map<number, HydratedChunk>([
    [1, hyd(1, 10, OLD_MTIME)],
    [2, hyd(2, 11, OLD_MTIME)],
    [3, hyd(3, 12, OLD_MTIME)],
  ]);
  const ranked = rankResults(
    {
      keyword: kw,
      semantic: sem,
      hydrated,
      inboundLinkSources: new Map(),
      tagsByDoc: new Map(),
    },
    { keywordWeight: 0.6, semanticWeight: 0.4, limit: 10, nowMs: NOW },
  );
  const map = new Map(ranked.map((r) => [r.chunkId, r]));
  expect(map.get(1)?.searchType).toBe("keyword");
  expect(map.get(2)?.searchType).toBe("hybrid");
  expect(map.get(3)?.searchType).toBe("semantic");
});

test("score is clamped to [0,1] even with boosts", () => {
  const ranked = rankResults(
    {
      keyword: [{ chunkId: 1, documentId: 10, bm25: -10 }],
      semantic: [{ chunkId: 1, documentId: 10, distance: 0 }],
      hydrated: new Map([[1, hyd(1, 10, RECENT_MTIME)]]),
      inboundLinkSources: new Map(),
      tagsByDoc: new Map(),
    },
    { keywordWeight: 0.6, semanticWeight: 0.4, limit: 10, nowMs: NOW },
  );
  expect(ranked[0]?.score).toBeGreaterThan(0);
  expect(ranked[0]?.score).toBeLessThanOrEqual(1);
});

test("keyword-only fallback ignores semantic when semanticEnabled=false", () => {
  const ranked = rankResults(
    {
      keyword: [{ chunkId: 1, documentId: 10, bm25: -5 }],
      semantic: [{ chunkId: 2, documentId: 11, distance: 0.0 }],
      hydrated: new Map([
        [1, hyd(1, 10, OLD_MTIME)],
        [2, hyd(2, 11, OLD_MTIME)],
      ]),
      inboundLinkSources: new Map(),
      tagsByDoc: new Map(),
    },
    {
      keywordWeight: 1.0,
      semanticWeight: 0,
      limit: 10,
      nowMs: NOW,
      semanticEnabled: false,
    },
  );
  expect(ranked.length).toBe(1);
  expect(ranked[0]?.chunkId).toBe(1);
  expect(ranked[0]?.searchType).toBe("keyword");
});

test("min-max normalisation: best BM25 hit gets 1.0, worst 0.0", () => {
  const ranked = rankResults(
    {
      keyword: [
        { chunkId: 1, documentId: 10, bm25: -10 },
        { chunkId: 2, documentId: 11, bm25: -1 },
      ],
      semantic: [],
      hydrated: new Map([
        [1, hyd(1, 10, OLD_MTIME)],
        [2, hyd(2, 11, OLD_MTIME)],
      ]),
      inboundLinkSources: new Map(),
      tagsByDoc: new Map(),
    },
    { keywordWeight: 1.0, semanticWeight: 0, limit: 10, nowMs: NOW },
  );
  const c1 = ranked.find((r) => r.chunkId === 1)!;
  const c2 = ranked.find((r) => r.chunkId === 2)!;
  expect(c1.keywordScore).toBe(1);
  expect(c2.keywordScore).toBe(0);
});

test("single-result keyword gets keywordScore=1 (max==min branch)", () => {
  const ranked = rankResults(
    {
      keyword: [{ chunkId: 1, documentId: 10, bm25: -5 }],
      semantic: [],
      hydrated: new Map([[1, hyd(1, 10, OLD_MTIME)]]),
      inboundLinkSources: new Map(),
      tagsByDoc: new Map(),
    },
    { keywordWeight: 1, semanticWeight: 0, limit: 10, nowMs: NOW },
  );
  expect(ranked[0]?.keywordScore).toBe(1);
});

test("link_boost adds +0.02 when another candidate doc points to this chunk's doc", () => {
  const inbound = new Map<number, ReadonlySet<number>>([
    // chunk 1 (doc 10) is pointed to by doc 11
    [1, new Set([11])],
  ]);
  const ranked = rankResults(
    {
      keyword: [
        { chunkId: 1, documentId: 10, bm25: -5 },
        { chunkId: 2, documentId: 11, bm25: -5 },
      ],
      semantic: [],
      hydrated: new Map([
        [1, hyd(1, 10, OLD_MTIME)],
        [2, hyd(2, 11, OLD_MTIME)],
      ]),
      inboundLinkSources: inbound,
      tagsByDoc: new Map(),
    },
    { keywordWeight: 1, semanticWeight: 0, limit: 10, nowMs: NOW },
  );
  const c1 = ranked.find((r) => r.chunkId === 1)!;
  expect(c1.linkBoost).toBeCloseTo(0.02, 6);
});

test("tag_boost adds +0.01 when candidates share a tag", () => {
  const tags = new Map<number, ReadonlySet<string>>([
    [1, new Set(["shared"])],
    [2, new Set(["shared", "extra"])],
  ]);
  const ranked = rankResults(
    {
      keyword: [
        { chunkId: 1, documentId: 10, bm25: -5 },
        { chunkId: 2, documentId: 11, bm25: -5 },
      ],
      semantic: [],
      hydrated: new Map([
        [1, hyd(1, 10, OLD_MTIME)],
        [2, hyd(2, 11, OLD_MTIME)],
      ]),
      inboundLinkSources: new Map(),
      tagsByDoc: tags,
    },
    { keywordWeight: 1, semanticWeight: 0, limit: 10, nowMs: NOW },
  );
  expect(ranked[0]?.linkBoost).toBeCloseTo(0.01, 6);
});

test("recency_boost is 0.05 for ≤7d, 0.025 for ≤30d, 0.01 for ≤90d, 0 older", () => {
  const make = (mt: number) =>
    rankResults(
      {
        keyword: [{ chunkId: 1, documentId: 10, bm25: -5 }],
        semantic: [],
        hydrated: new Map([[1, hyd(1, 10, mt)]]),
        inboundLinkSources: new Map(),
        tagsByDoc: new Map(),
      },
      { keywordWeight: 1, semanticWeight: 0, limit: 10, nowMs: NOW },
    )[0]!.recencyBoost;

  const baseSec = NOW / 1000;
  expect(make(baseSec - 3 * 86400)).toBe(0.05);
  expect(make(baseSec - 20 * 86400)).toBe(0.025);
  expect(make(baseSec - 60 * 86400)).toBe(0.01);
  expect(make(baseSec - 200 * 86400)).toBe(0);
});

test("tie-break: equal final_score → higher keywordScore wins; then mtime; then chunkId", () => {
  // Two chunks with identical score after combination: same kw=1, no semantic, no boosts.
  const ranked = rankResults(
    {
      keyword: [
        { chunkId: 2, documentId: 11, bm25: -5 },
        { chunkId: 1, documentId: 10, bm25: -5 },
      ],
      semantic: [],
      hydrated: new Map([
        [1, hyd(1, 10, OLD_MTIME)],
        [2, hyd(2, 11, OLD_MTIME)],
      ]),
      inboundLinkSources: new Map(),
      tagsByDoc: new Map(),
    },
    { keywordWeight: 1, semanticWeight: 0, limit: 10, nowMs: NOW },
  );
  // Same score, same kw, same mtime, lower chunkId first → [1, 2]
  expect(ranked.map((r) => r.chunkId)).toEqual([1, 2]);
});

test("limit truncates after ranking", () => {
  const kw: KeywordHit[] = [];
  const hydrated = new Map<number, HydratedChunk>();
  for (let i = 0; i < 30; i++) {
    kw.push({ chunkId: i + 1, documentId: 100 + i, bm25: -(i + 1) });
    hydrated.set(i + 1, hyd(i + 1, 100 + i, OLD_MTIME));
  }
  const ranked = rankResults(
    {
      keyword: kw,
      semantic: [],
      hydrated,
      inboundLinkSources: new Map(),
      tagsByDoc: new Map(),
    },
    { keywordWeight: 1, semanticWeight: 0, limit: 5, nowMs: NOW },
  );
  expect(ranked.length).toBe(5);
});
