/**
 * Query-side temporal intent in the ranker (t_58fc4720): a detected query
 * window contributes its OWN capped additive layer over temporal
 * proximity and damps the misdirected freshness prior when the window is
 * historical. Absent intent leaves ranking byte-identical.
 */

import { test, expect, describe } from "bun:test";

import {
  rankResults,
  ACTIVATION_BOOST_CAP,
  CO_ACCESS_BOOST_CAP,
  ENTITY_BOOST_CAP,
  LINK_BOOST_CAP,
  REUSE_BOOST_CAP,
  TEMPORAL_INTENT_BOOST_CAP,
} from "../../../src/core/search/ranker.ts";
import { DEFAULT_RECENCY } from "../../../src/core/search/recency.ts";
import { detectTemporalIntent } from "../../../src/core/search/temporal-intent.ts";
import type { KeywordHit, SemanticHit, HydratedChunk } from "../../../src/core/search/store.ts";

const NOW = Date.UTC(2026, 6, 27, 12, 0, 0);
/** Inside the historical window the queries below name. */
const IN_WINDOW_MS = Date.UTC(2024, 5, 15, 9, 0, 0);

function hyd(chunkId: number, docId: number, mtimeMs: number): HydratedChunk {
  return Object.freeze({
    chunkId,
    documentId: docId,
    path: `doc${docId}.md`,
    title: `Doc ${docId}`,
    content: `chunk ${chunkId}`,
    startLine: 1,
    endLine: 1,
    mtime: Math.floor(mtimeMs / 1000),
  });
}

/** Two equally relevant candidates: one recent, one inside the window. */
const EQUAL_RELEVANCE = {
  keyword: [
    { chunkId: 1, documentId: 10, bm25: -5 },
    { chunkId: 2, documentId: 20, bm25: -5 },
  ] as KeywordHit[],
  semantic: [] as SemanticHit[],
  hydrated: new Map([
    [1, hyd(1, 10, NOW)],
    [2, hyd(2, 20, IN_WINDOW_MS)],
  ]),
  inboundLinkSources: new Map(),
  tagsByDoc: new Map(),
};

const BASE_OPTS = {
  keywordWeight: 0.6,
  semanticWeight: 0.4,
  limit: 10,
  nowMs: NOW,
};

const HISTORICAL_INTENT = detectTemporalIntent("since:2024-06-01 until:2024-06-30", NOW)!;

describe("absent temporal intent", () => {
  test("leaves ranking byte-identical and the breakdown key absent", () => {
    const without = rankResults(EQUAL_RELEVANCE, BASE_OPTS);
    const explicitNull = rankResults(EQUAL_RELEVANCE, { ...BASE_OPTS, temporalIntent: null });
    expect(explicitNull).toEqual(without);
    for (const r of without) {
      expect(r.breakdown).toBeDefined();
      expect("temporal" in r.breakdown!).toBe(false);
      expect(r.reasons.some((x) => x.startsWith("temporal_intent"))).toBe(false);
    }
  });

  test("with no intent the fresher document wins", () => {
    const ranked = rankResults(EQUAL_RELEVANCE, BASE_OPTS);
    expect(ranked[0]!.chunkId).toBe(1);
  });
});

describe("an active historical window", () => {
  test("ranks an in-window note above an equally relevant recent one", () => {
    const ranked = rankResults(EQUAL_RELEVANCE, {
      ...BASE_OPTS,
      temporalIntent: HISTORICAL_INTENT,
    });
    expect(ranked[0]!.chunkId).toBe(2);
    expect(ranked[1]!.chunkId).toBe(1);
  });

  test("the freshness prior and the temporal layer are separate reasons entries", () => {
    const ranked = rankResults(EQUAL_RELEVANCE, {
      ...BASE_OPTS,
      temporalIntent: HISTORICAL_INTENT,
    });
    const recent = ranked.find((r) => r.chunkId === 1)!;
    const inWindow = ranked.find((r) => r.chunkId === 2)!;
    // The recent document keeps its (damped) freshness prior AND carries a
    // distinct temporal-intent entry, so the two are separately attributable.
    expect(recent.reasons.filter((x) => x.startsWith("recency: "))).toHaveLength(1);
    expect(recent.reasons.filter((x) => x.startsWith("temporal_intent: "))).toHaveLength(1);
    expect(inWindow.reasons.filter((x) => x.startsWith("temporal_intent: "))).toHaveLength(1);
    expect(recent.breakdown!.recency).toBe(recent.recencyBoost);
    expect(inWindow.breakdown!.temporal).toBeCloseTo(TEMPORAL_INTENT_BOOST_CAP, 10);
    expect(recent.breakdown!.temporal).toBe(0);
  });

  test("damps the freshness prior rather than removing it", () => {
    const undamped = rankResults(EQUAL_RELEVANCE, BASE_OPTS).find((r) => r.chunkId === 1)!;
    const damped = rankResults(EQUAL_RELEVANCE, {
      ...BASE_OPTS,
      temporalIntent: HISTORICAL_INTENT,
    }).find((r) => r.chunkId === 1)!;
    expect(damped.recencyBoost).toBeGreaterThan(0);
    expect(damped.recencyBoost).toBeLessThan(undamped.recencyBoost);
    expect(damped.recencyBoost).toBeCloseTo(
      undamped.recencyBoost * HISTORICAL_INTENT.recencyDamping,
      10,
    );
  });

  test("biases without excluding: the out-of-window candidate still surfaces", () => {
    const ranked = rankResults(EQUAL_RELEVANCE, {
      ...BASE_OPTS,
      temporalIntent: HISTORICAL_INTENT,
    });
    expect(ranked.map((r) => r.chunkId).toSorted()).toEqual([1, 2]);
  });
});

describe("a present-reaching window", () => {
  test("leaves the freshness prior undamped", () => {
    const intent = detectTemporalIntent("since:7d", NOW)!;
    const undamped = rankResults(EQUAL_RELEVANCE, BASE_OPTS).find((r) => r.chunkId === 1)!;
    const withIntent = rankResults(EQUAL_RELEVANCE, {
      ...BASE_OPTS,
      temporalIntent: intent,
    }).find((r) => r.chunkId === 1)!;
    expect(withIntent.recencyBoost).toBe(undamped.recencyBoost);
    // ...and the recent document, being inside the window, gains the layer.
    expect(withIntent.breakdown!.temporal).toBeCloseTo(TEMPORAL_INTENT_BOOST_CAP, 10);
  });
});

describe("event time", () => {
  test("a declared event time overrides mtime for the temporal layer", () => {
    // Chunk 1 was WRITTEN today but declares an event time inside the
    // window: the event time is the authority, mtime the fallback.
    const ranked = rankResults(
      { ...EQUAL_RELEVANCE, eventTimeMsByChunk: new Map([[1, IN_WINDOW_MS]]) },
      { ...BASE_OPTS, temporalIntent: HISTORICAL_INTENT },
    );
    const recent = ranked.find((r) => r.chunkId === 1)!;
    expect(recent.breakdown!.temporal).toBeCloseTo(TEMPORAL_INTENT_BOOST_CAP, 10);
  });

  test("an absent map entry falls back to mtime", () => {
    const withEmptyMap = rankResults(
      { ...EQUAL_RELEVANCE, eventTimeMsByChunk: new Map<number, number>() },
      { ...BASE_OPTS, temporalIntent: HISTORICAL_INTENT },
    );
    const withoutMap = rankResults(EQUAL_RELEVANCE, {
      ...BASE_OPTS,
      temporalIntent: HISTORICAL_INTENT,
    });
    expect(withEmptyMap).toEqual(withoutMap);
  });
});

describe("the temporal cap", () => {
  test("is in proportion to the existing link / entity / activation / reuse caps", () => {
    const siblings = [
      LINK_BOOST_CAP,
      ENTITY_BOOST_CAP,
      ACTIVATION_BOOST_CAP,
      CO_ACCESS_BOOST_CAP,
      REUSE_BOOST_CAP,
    ];
    // The constant's own justification: level with the TOP of the band,
    // never above it. Asserting mere membership of [min, max] could not
    // fail - the cap IS the max - so it pinned nothing.
    expect(TEMPORAL_INTENT_BOOST_CAP).toBe(Math.max(...siblings));
    expect(TEMPORAL_INTENT_BOOST_CAP).toBeGreaterThan(Math.min(...siblings));
    // Strong enough to overcome the full undamped freshness prior it
    // corrects, so a declared window can actually re-order the set. That
    // prior's maximum is the configured recency amplitude, which is the
    // number this cap is calibrated against - referenced, not restated.
    expect(TEMPORAL_INTENT_BOOST_CAP).toBeGreaterThan(DEFAULT_RECENCY.amplitude);
  });

  test("bounds the layer: no candidate ever exceeds it", () => {
    const ranked = rankResults(EQUAL_RELEVANCE, {
      ...BASE_OPTS,
      temporalIntent: HISTORICAL_INTENT,
    });
    for (const r of ranked) {
      expect(r.breakdown!.temporal).toBeLessThanOrEqual(TEMPORAL_INTENT_BOOST_CAP);
      expect(r.breakdown!.temporal).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("recencyAmplitude 0", () => {
  test("remains a global off switch under an active temporal intent", () => {
    const ranked = rankResults(EQUAL_RELEVANCE, {
      ...BASE_OPTS,
      recency: { shape: 0.8, scale: 30, amplitude: 0 },
      temporalIntent: HISTORICAL_INTENT,
    });
    for (const r of ranked) {
      expect(r.recencyBoost).toBe(0);
      expect(r.breakdown!.recency).toBe(0);
      expect(r.reasons.some((x) => x.startsWith("recency: "))).toBe(false);
    }
    // The temporal layer is independent and still fires.
    expect(ranked[0]!.chunkId).toBe(2);
  });
});

describe("the tie-break hazard", () => {
  /**
   * Both candidates saturate `clamp01`, so the in-window document's larger
   * temporal contribution is invisible in the final score and the historical
   * `mtime desc` rung would hand the win to the fresher document - exactly
   * the freshness bias this unit corrects.
   */
  const SATURATING_OPTS = { ...BASE_OPTS, keywordWeight: 1 };

  test("an exact score tie is broken toward the in-window result, not the newer mtime", () => {
    const ranked = rankResults(EQUAL_RELEVANCE, {
      ...SATURATING_OPTS,
      temporalIntent: HISTORICAL_INTENT,
    });
    expect(ranked[0]!.score).toBe(ranked[1]!.score);
    expect(ranked[0]!.chunkId).toBe(2);
  });

  test("with no intent the historical mtime-desc tie-break is untouched", () => {
    const ranked = rankResults(EQUAL_RELEVANCE, SATURATING_OPTS);
    expect(ranked[0]!.score).toBe(ranked[1]!.score);
    expect(ranked[0]!.chunkId).toBe(1);
  });

  /**
   * Two saturating candidates whose keyword scores DIFFER: chunk 1 has the
   * better keyword score and the fresher mtime, chunk 2 sits inside the
   * declared window. Pins where the temporal rung sits - above the whole
   * historical ladder (`keywordScore` included), not only above the two
   * freshness rungs.
   */
  const SPLIT_KEYWORD = {
    ...EQUAL_RELEVANCE,
    keyword: [
      { chunkId: 1, documentId: 10, bm25: -6 },
      { chunkId: 2, documentId: 20, bm25: -5.9 },
      // Anchors the min-max floor so the two above stay near-equal.
      { chunkId: 3, documentId: 30, bm25: -1 },
    ] as KeywordHit[],
    semantic: [
      { chunkId: 1, documentId: 10, distance: 0 },
      { chunkId: 2, documentId: 20, distance: 0 },
    ] as SemanticHit[],
    hydrated: new Map([
      [1, hyd(1, 10, NOW)],
      [2, hyd(2, 20, IN_WINDOW_MS)],
      [3, hyd(3, 30, NOW)],
    ]),
    // Chunk 2 trails on keyword score; this link boost lifts it back onto
    // an exact tie so the LADDER decides, with or without a window.
    inboundLinkSources: new Map([[2, new Set([10, 30])]]),
  };
  const SPLIT_OPTS = {
    ...BASE_OPTS,
    keywordWeight: 0.5,
    semanticWeight: 0.5,
    semanticEnabled: true,
  };

  test("the temporal rung outranks keywordScore, not only the two freshness rungs", () => {
    const ranked = rankResults(SPLIT_KEYWORD, {
      ...SPLIT_OPTS,
      temporalIntent: HISTORICAL_INTENT,
    });
    const [first, second] = [ranked[0]!, ranked[1]!];
    expect(first.score).toBe(second.score);
    expect(first.keywordScore).toBeLessThan(second.keywordScore);
    expect(first.chunkId).toBe(2);
  });

  test("with no window declared the same pair falls back to keywordScore desc", () => {
    const ranked = rankResults(SPLIT_KEYWORD, SPLIT_OPTS);
    expect(ranked[0]!.score).toBe(ranked[1]!.score);
    expect(ranked[0]!.chunkId).toBe(1);
  });
});
