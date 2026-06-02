/**
 * Retrieval feedback loop (recall-trust-suite, Feature B).
 *
 * Explicit per-result recall feedback lands as one JSON file per event
 * under `Brain/search/feedback/` (the conflict-free inbox pattern), and
 * a deterministic bounded fold derives per-layer learned multipliers
 * into `Brain/search/learned-weights.json`. Search applies them only
 * when the config opt-in is on, tags affected results with a
 * `learned_weights:` reason, and folds the weights state into the
 * query-cache key.
 */

import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { existsSync, readdirSync } from "node:fs";

import {
  computeLearnedWeights,
  contributionsFromResult,
  feedbackDir,
  learnedWeightsPath,
  learnedWeightsFingerprint,
  loadFeedbackEvents,
  readLearnedWeights,
  recordRecallFeedback,
  resetLearnedWeights,
  LEARNED_WEIGHT_MIN,
  LEARNED_WEIGHT_MAX,
  type RecallFeedbackEvent,
} from "../../../src/core/search/feedback.ts";
import { indexVault } from "../../../src/core/search/indexer.ts";
import { search } from "../../../src/core/search/search.ts";
import type { BrainSearchResult } from "../../../src/core/search/types.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";

let vault: string;
let dbPath: string;
let cleanup: () => void;

beforeEach(() => {
  ({ vault, dbPath, cleanup } = createTempVault("feedback"));
});
afterEach(() => cleanup());

function event(over: Partial<RecallFeedbackEvent>): RecallFeedbackEvent {
  return {
    ts: 1_700_000_000_000,
    queryHash: "abcd1234",
    resultPath: "note.md",
    verdict: "up",
    contributions: { keyword: 0.8, semantic: 0, entity: 0, recency: 0.05 },
    ...over,
  };
}

describe("feedback event store", () => {
  test("recordRecallFeedback writes one JSON file per event and round-trips", () => {
    const a = event({ ts: 1_700_000_000_000 });
    const b = event({ ts: 1_700_000_000_001, verdict: "down" });
    recordRecallFeedback(vault, a);
    recordRecallFeedback(vault, b);
    const files = readdirSync(feedbackDir(vault));
    expect(files).toHaveLength(2);
    expect(files.every((f) => f.endsWith(".json"))).toBe(true);
    const events = loadFeedbackEvents(vault);
    expect(events).toHaveLength(2);
    expect(events[0]!.ts).toBe(a.ts);
    expect(events[1]!.verdict).toBe("down");
  });

  test("recording the same event twice is idempotent (deterministic filename)", () => {
    const a = event({});
    recordRecallFeedback(vault, a);
    recordRecallFeedback(vault, a);
    expect(readdirSync(feedbackDir(vault))).toHaveLength(1);
  });

  test("loadFeedbackEvents on a vault without feedback returns empty", () => {
    expect(loadFeedbackEvents(vault)).toEqual([]);
  });
});

describe("learned-weight fold", () => {
  test("no events → neutral multipliers", () => {
    const w = computeLearnedWeights([]);
    expect(w.keywordMul).toBe(1);
    expect(w.semanticMul).toBe(1);
    expect(w.entityMul).toBe(1);
    expect(w.recencyMul).toBe(1);
    expect(w.events).toBe(0);
  });

  test("up-votes on keyword-driven results raise keywordMul; down-votes lower it", () => {
    const ups = [
      event({ ts: 1, contributions: { keyword: 1, semantic: 0, entity: 0, recency: 0 } }),
      event({ ts: 2, contributions: { keyword: 1, semantic: 0, entity: 0, recency: 0 } }),
    ];
    const up = computeLearnedWeights(ups);
    expect(up.keywordMul).toBeGreaterThan(1);
    expect(up.semanticMul).toBe(1);

    const downs = ups.map((e, i) => ({ ...e, ts: 10 + i, verdict: "down" as const }));
    const down = computeLearnedWeights(downs);
    expect(down.keywordMul).toBeLessThan(1);
  });

  test("multipliers never escape the documented bounds", () => {
    const extreme = Array.from({ length: 50 }, (_, i) =>
      event({
        ts: i,
        verdict: "down",
        contributions: { keyword: 1, semantic: 1, entity: 1, recency: 1 },
      }),
    );
    const w = computeLearnedWeights(extreme);
    for (const mul of [w.keywordMul, w.semanticMul, w.entityMul, w.recencyMul]) {
      expect(mul).toBeGreaterThanOrEqual(LEARNED_WEIGHT_MIN);
      expect(mul).toBeLessThanOrEqual(LEARNED_WEIGHT_MAX);
    }
  });

  test("the fold is deterministic and order-insensitive for the same event set", () => {
    const events = [
      event({ ts: 1, contributions: { keyword: 0.9, semantic: 0.1, entity: 0, recency: 0 } }),
      event({
        ts: 2,
        verdict: "down",
        contributions: { keyword: 0.1, semantic: 0.8, entity: 0, recency: 0 },
      }),
      event({ ts: 3, contributions: { keyword: 0, semantic: 0, entity: 0.5, recency: 0.5 } }),
    ];
    const a = computeLearnedWeights(events);
    const b = computeLearnedWeights(events.toReversed());
    expect(a).toEqual(b);
  });

  test("contributionsFromResult reads the scoring layers off a search result", () => {
    const result = {
      documentId: 1,
      chunkId: 10,
      path: "x.md",
      title: null,
      content: "",
      startLine: 1,
      endLine: 1,
      score: 0.7,
      keywordScore: 0.6,
      semanticScore: 0.2,
      linkBoost: 0,
      recencyBoost: 0.05,
      searchType: "hybrid",
      reasons: ["fts5_bm25: 0.600", "semantic_cos: 0.200", "entity_match: 0.020"],
    } as unknown as BrainSearchResult;
    const c = contributionsFromResult(result);
    expect(c.keyword).toBeCloseTo(0.6, 5);
    expect(c.semantic).toBeCloseTo(0.2, 5);
    expect(c.entity).toBeCloseTo(0.02, 5);
    expect(c.recency).toBeCloseTo(0.05, 5);
  });
});

describe("derived weights file", () => {
  test("record + recompute persists learned weights; reset removes them but keeps events", () => {
    recordRecallFeedback(vault, event({}));
    const w = computeLearnedWeights(loadFeedbackEvents(vault));
    expect(existsSync(learnedWeightsPath(vault))).toBe(true); // record() recomputes
    expect(readLearnedWeights(vault)?.events).toBe(w.events);

    resetLearnedWeights(vault);
    expect(existsSync(learnedWeightsPath(vault))).toBe(false);
    expect(loadFeedbackEvents(vault)).toHaveLength(1);
  });

  test("fingerprint changes when weights change and is stable otherwise", () => {
    const before = learnedWeightsFingerprint(vault);
    expect(learnedWeightsFingerprint(vault)).toBe(before);
    recordRecallFeedback(vault, event({}));
    expect(learnedWeightsFingerprint(vault)).not.toBe(before);
  });
});

describe("search integration", () => {
  test("learned weights shift scores only when the config opt-in is on", async () => {
    writeMd(vault, "doc.md", "# Doc\n\nthe migration ledger covers warehouse sync");
    // Two keyword-down events: learned keywordMul < 1.
    recordRecallFeedback(
      vault,
      event({
        ts: 1,
        verdict: "down",
        contributions: { keyword: 1, semantic: 0, entity: 0, recency: 0 },
      }),
    );
    recordRecallFeedback(
      vault,
      event({
        ts: 2,
        verdict: "down",
        contributions: { keyword: 1, semantic: 0, entity: 0, recency: 0 },
      }),
    );

    const off = makeConfig({ vault, dbPath });
    const on = makeConfig({ vault, dbPath, learnedWeightsEnabled: true });
    await indexVault(off);

    const plain = await search(off, { query: "migration ledger", limit: 3 });
    const learned = await search(on, { query: "migration ledger", limit: 3 });
    expect(plain.results).toHaveLength(1);
    expect(learned.results).toHaveLength(1);
    expect(learned.results[0]!.score).toBeLessThan(plain.results[0]!.score);
    expect(learned.results[0]!.reasons.some((r) => r.startsWith("learned_weights:"))).toBe(true);
    expect(plain.results[0]!.reasons.some((r) => r.startsWith("learned_weights:"))).toBe(false);
  });

  test("neutral learned weights leave results untagged", async () => {
    writeMd(vault, "doc.md", "# Doc\n\nplain note about ledger sync");
    const on = makeConfig({ vault, dbPath, learnedWeightsEnabled: true });
    await indexVault(on);
    const out = await search(on, { query: "ledger sync", limit: 3 });
    expect(out.results[0]!.reasons.some((r) => r.startsWith("learned_weights:"))).toBe(false);
  });
});
