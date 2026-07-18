import { test, expect } from "bun:test";
import { rankResults } from "../../../src/core/search/ranker.ts";
import { weibullDecay, DEFAULT_RECENCY } from "../../../src/core/search/recency.ts";
import { NEUTRAL_PROFILE } from "../../../src/core/search/query-plan.ts";
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
const OLD_MTIME = NOW / 1000 - 365 * 24 * 3600; // >90d → 0 recency

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

test("observed-reuse boost lifts an equally-relevant chunk (t_65588d8b)", () => {
  const kw: KeywordHit[] = [
    { chunkId: 1, documentId: 10, bm25: -3 },
    { chunkId: 2, documentId: 11, bm25: -3 },
  ];
  const hydrated = new Map<number, HydratedChunk>([
    [1, hyd(1, 10, OLD_MTIME)],
    [2, hyd(2, 11, OLD_MTIME)],
  ]);
  const base = {
    keyword: kw,
    semantic: [] as SemanticHit[],
    hydrated,
    inboundLinkSources: new Map<number, ReadonlySet<number>>(),
    tagsByDoc: new Map<number, ReadonlySet<string>>(),
  };
  const opts = { keywordWeight: 0.6, semanticWeight: 0.4, limit: 10, nowMs: NOW };

  // Without a reuse signal, the two chunks are tied.
  const neutral = rankResults(base, opts);
  expect(neutral[0]!.score).toBeCloseTo(neutral[1]!.score, 6);

  // With chunk 2 carrying a high observed-reuse score, it must lead.
  const boosted = rankResults({ ...base, reuseRateByChunk: new Map([[2, 1]]) }, opts);
  expect(boosted[0]!.chunkId).toBe(2);
  const c1 = boosted.find((r) => r.chunkId === 1)!;
  const c2 = boosted.find((r) => r.chunkId === 2)!;
  expect(c2.score).toBeGreaterThan(c1.score);
  // Explainability: the boost surfaces in reasons and the breakdown.
  expect(c2.reasons.some((r) => r.startsWith("observed_reuse:"))).toBe(true);
  expect(c2.breakdown!.reuse).toBeGreaterThan(0);
  expect(c1.breakdown!.reuse).toBe(0);
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

test("recency_boost follows the default Weibull curve (smooth, monotonic)", () => {
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
  // The age the ranker derives from mtime is exact, so the boost equals
  // the pure curve evaluated at that age in days.
  for (const days of [3, 20, 60, 90]) {
    expect(make(baseSec - days * 86400)).toBeCloseTo(weibullDecay(days, DEFAULT_RECENCY), 6);
  }
  // Monotonic non-increasing with age.
  expect(make(baseSec - 3 * 86400)).toBeGreaterThan(make(baseSec - 60 * 86400));
  // Effectively stale content floors to exactly 0 (no recency layer).
  expect(make(baseSec - 365 * 86400)).toBe(0);
});

test("ranker honours a custom recency curve passed via options", () => {
  const custom = { shape: 0.8, scale: 120, amplitude: 0.05 };
  const boost = rankResults(
    {
      keyword: [{ chunkId: 1, documentId: 10, bm25: -5 }],
      semantic: [],
      hydrated: new Map([[1, hyd(1, 10, NOW / 1000 - 60 * 86400)]]),
      inboundLinkSources: new Map(),
      tagsByDoc: new Map(),
    },
    { keywordWeight: 1, semanticWeight: 0, limit: 10, nowMs: NOW, recency: custom },
  )[0]!.recencyBoost;
  // A larger scale than the default decays slower, so a 60-day-old hit
  // keeps a higher boost than it would under the default curve.
  expect(boost).toBeCloseTo(weibullDecay(60, custom), 6);
  expect(boost).toBeGreaterThan(weibullDecay(60, DEFAULT_RECENCY));
});

test("an absent weightProfile ranks identically to the neutral profile", () => {
  const inputs = {
    keyword: [{ chunkId: 1, documentId: 10, bm25: -5 }],
    semantic: [{ chunkId: 1, documentId: 10, distance: 0.3 }],
    hydrated: new Map([[1, hyd(1, 10, RECENT_MTIME)]]),
    inboundLinkSources: new Map(),
    tagsByDoc: new Map(),
  };
  const opts = { keywordWeight: 0.6, semanticWeight: 0.4, limit: 10, nowMs: NOW };
  const without = rankResults(inputs, opts)[0]!;
  const neutral = rankResults(inputs, { ...opts, weightProfile: NEUTRAL_PROFILE })[0]!;
  expect(neutral.score).toBe(without.score);
});

test("a keyword-leaning weightProfile raises a keyword hit's score", () => {
  const inputs = {
    keyword: [{ chunkId: 1, documentId: 10, bm25: -5 }],
    semantic: [],
    hydrated: new Map([[1, hyd(1, 10, OLD_MTIME)]]),
    inboundLinkSources: new Map(),
    tagsByDoc: new Map(),
  };
  const opts = { keywordWeight: 0.6, semanticWeight: 0.4, limit: 10, nowMs: NOW };
  const base = rankResults(inputs, opts)[0]!.score;
  const boosted = rankResults(inputs, {
    ...opts,
    weightProfile: { keywordMul: 1.3, semanticMul: 0.7, entityMul: 1, recencyMul: 1 },
  })[0]!.score;
  expect(boosted).toBeGreaterThan(base);
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

// ── conversation chronology: exact-score recency tie-break (S1 / t_347e8224) ──

/** Like `hyd`, but with an explicit `authored_at` (unix seconds) or null. */
function hydAuthored(
  chunkId: number,
  docId: number,
  mtime: number,
  authoredAt: number | null,
): HydratedChunk {
  return Object.freeze({
    chunkId,
    documentId: docId,
    path: `doc${docId}.md`,
    title: `Doc ${docId}`,
    content: `chunk ${chunkId}`,
    startLine: 1,
    endLine: 1,
    mtime,
    authoredAt,
  });
}

const T_OLD = 1_700_000_000; // unix seconds
const T_NEW = 1_700_100_000;

test("exact hybrid-score tie orders the more recent authored_at first (S1)", () => {
  // Equal bm25 + no boosts → an EXACT score tie between the two chunks.
  const kw: KeywordHit[] = [
    { chunkId: 1, documentId: 10, bm25: -3 },
    { chunkId: 2, documentId: 11, bm25: -3 },
  ];
  const hydrated = new Map<number, HydratedChunk>([
    // chunk 1 is OLDER, chunk 2 is NEWER; identical mtime so only authored_at differs.
    [1, hydAuthored(1, 10, OLD_MTIME, T_OLD)],
    [2, hydAuthored(2, 11, OLD_MTIME, T_NEW)],
  ]);
  const ranked = rankResults(
    { keyword: kw, semantic: [], hydrated, inboundLinkSources: new Map(), tagsByDoc: new Map() },
    { keywordWeight: 1, semanticWeight: 0, limit: 10, nowMs: NOW },
  );
  expect(ranked[0]!.score).toBeCloseTo(ranked[1]!.score, 6);
  expect(ranked[0]!.chunkId).toBe(2); // newer first
  expect(ranked[0]!.authoredAt).toBe(T_NEW);
  expect(ranked[1]!.authoredAt).toBe(T_OLD);
});

test("a non-tied pair keeps today's order regardless of authored_at (S1 regression)", () => {
  // chunk 1 has the STRONGER bm25 (higher score) but the OLDER authored_at;
  // chunk 2 is weaker but newer. Different scores → recency must NOT reorder.
  const kw: KeywordHit[] = [
    { chunkId: 1, documentId: 10, bm25: -10 },
    { chunkId: 2, documentId: 11, bm25: -1 },
  ];
  const hydrated = new Map<number, HydratedChunk>([
    [1, hydAuthored(1, 10, OLD_MTIME, T_OLD)],
    [2, hydAuthored(2, 11, OLD_MTIME, T_NEW)],
  ]);
  const ranked = rankResults(
    { keyword: kw, semantic: [], hydrated, inboundLinkSources: new Map(), tagsByDoc: new Map() },
    { keywordWeight: 1, semanticWeight: 0, limit: 10, nowMs: NOW },
  );
  expect(ranked[0]!.score).toBeGreaterThan(ranked[1]!.score);
  expect(ranked[0]!.chunkId).toBe(1); // stronger score wins despite older authored_at
});

test("an exact tie where neither side carries authored_at keeps the historical order (S1)", () => {
  const kw: KeywordHit[] = [
    { chunkId: 1, documentId: 10, bm25: -3 },
    { chunkId: 2, documentId: 11, bm25: -3 },
  ];
  const hydrated = new Map<number, HydratedChunk>([
    [1, hydAuthored(1, 10, OLD_MTIME, null)],
    [2, hydAuthored(2, 11, OLD_MTIME, null)],
  ]);
  const ranked = rankResults(
    { keyword: kw, semantic: [], hydrated, inboundLinkSources: new Map(), tagsByDoc: new Map() },
    { keywordWeight: 1, semanticWeight: 0, limit: 10, nowMs: NOW },
  );
  // Equal keywordScore + mtime → chunkId asc (the historical final tie-break).
  expect(ranked.map((r) => r.chunkId)).toEqual([1, 2]);
  expect(ranked[0]!.authoredAt).toBeUndefined();
});

test("an exact tie with only one authored_at falls through to the historical tie-break (S1)", () => {
  const kw: KeywordHit[] = [
    { chunkId: 1, documentId: 10, bm25: -3 },
    { chunkId: 2, documentId: 11, bm25: -3 },
  ];
  const hydrated = new Map<number, HydratedChunk>([
    // Only chunk 2 has an instant; a mixed pair must not be reordered by it.
    [1, hydAuthored(1, 10, OLD_MTIME, null)],
    [2, hydAuthored(2, 11, OLD_MTIME, T_NEW)],
  ]);
  const ranked = rankResults(
    { keyword: kw, semantic: [], hydrated, inboundLinkSources: new Map(), tagsByDoc: new Map() },
    { keywordWeight: 1, semanticWeight: 0, limit: 10, nowMs: NOW },
  );
  expect(ranked.map((r) => r.chunkId)).toEqual([1, 2]); // chunkId asc, unchanged
});
