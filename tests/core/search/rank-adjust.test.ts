/**
 * Kernel 1: the deterministic retrieval rank-adjustment sink
 * (t_5f61130a). Registered adjusters return a per-candidate verdict
 * (keep, multiply, exclude-with-reason); the sink applies them, records
 * exclusions with reasons, and re-sorts survivors. With no adjuster
 * registered - and with adjusters that only ever keep - the output is
 * byte-identical to the input, so the default retrieval path is
 * unaffected.
 */

import { test, expect, describe } from "bun:test";

import {
  applyRankAdjusters,
  excludeVerdict,
  keepVerdict,
  multiplyVerdict,
  type RankAdjuster,
} from "../../../src/core/search/rank-adjust.ts";
import type { BrainSearchResult } from "../../../src/core/search/types.ts";

function result(over: Partial<BrainSearchResult> & { documentId: number }): BrainSearchResult {
  return Object.freeze({
    chunkId: over.documentId * 10,
    path: `doc-${over.documentId}.md`,
    title: null,
    content: "body",
    startLine: 1,
    endLine: 1,
    score: 0.5,
    keywordScore: 0.5,
    semanticScore: 0,
    linkBoost: 0,
    recencyBoost: 0,
    searchType: "keyword" as const,
    reasons: Object.freeze(["fts5_bm25: 0.500"]),
    ...over,
  });
}

describe("applyRankAdjusters (kernel 1)", () => {
  test("no adjusters registered returns the exact input array (byte-identical)", () => {
    const pool = [result({ documentId: 1, score: 0.9 }), result({ documentId: 2, score: 0.4 })];
    const out = applyRankAdjusters(pool, []);
    expect(out.results).toBe(pool);
    expect(out.excluded).toEqual([]);
  });

  test("adjusters that only ever keep leave the input unchanged (byte-identical)", () => {
    const pool = [result({ documentId: 1, score: 0.9 }), result({ documentId: 2, score: 0.4 })];
    const keepAll: RankAdjuster = { name: "keep-all", adjust: () => keepVerdict() };
    const out = applyRankAdjusters(pool, [keepAll]);
    expect(out.results).toBe(pool);
    expect(out.excluded).toEqual([]);
  });

  test("an exclude verdict removes the candidate and records it with a namespaced reason", () => {
    const pool = [
      result({ documentId: 1, score: 0.9 }),
      result({ documentId: 2, score: 0.4, path: "quarantined.md" }),
    ];
    const gate: RankAdjuster = {
      name: "trust_gate",
      adjust: (r) => (r.path === "quarantined.md" ? excludeVerdict("quarantined") : keepVerdict()),
    };
    const out = applyRankAdjusters(pool, [gate]);
    expect(out.results.map((r) => r.documentId)).toEqual([1]);
    expect(out.excluded).toEqual([
      { documentId: 2, chunkId: 20, path: "quarantined.md", reasons: ["trust_gate:quarantined"] },
    ]);
  });

  test("a multiply verdict scales the score, appends a reason, and re-sorts", () => {
    const pool = [
      result({ documentId: 1, score: 0.9, keywordScore: 0.9 }),
      result({ documentId: 2, score: 0.5, keywordScore: 0.5 }),
    ];
    const fade: RankAdjuster = {
      name: "supersede_fade",
      adjust: (r) => (r.documentId === 1 ? multiplyVerdict(0.4, "faded") : keepVerdict()),
    };
    const out = applyRankAdjusters(pool, [fade]);
    // doc 1 faded 0.9 * 0.4 = 0.36, now below doc 2 at 0.5 -> re-sorted.
    expect(out.results.map((r) => r.documentId)).toEqual([2, 1]);
    const faded = out.results.find((r) => r.documentId === 1)!;
    expect(faded.score).toBeCloseTo(0.36, 6);
    expect(faded.reasons).toContain("supersede_fade:faded");
  });

  test("multiply by 1 leaves the pool byte-identical", () => {
    const pool = [result({ documentId: 1, score: 0.9 }), result({ documentId: 2, score: 0.4 })];
    const noop: RankAdjuster = { name: "noop", adjust: () => multiplyVerdict(1, "neutral") };
    const out = applyRankAdjusters(pool, [noop]);
    expect(out.results).toBe(pool);
  });

  test("multiple adjusters compose: product of factors, all exclude reasons recorded", () => {
    const pool = [result({ documentId: 1, score: 1 }), result({ documentId: 2, score: 1 })];
    const a: RankAdjuster = {
      name: "a",
      adjust: (r) => (r.documentId === 1 ? multiplyVerdict(0.5, "half") : keepVerdict()),
    };
    const b: RankAdjuster = {
      name: "b",
      adjust: (r) => (r.documentId === 1 ? multiplyVerdict(0.5, "half-again") : keepVerdict()),
    };
    const out = applyRankAdjusters(pool, [a, b]);
    const doc1 = out.results.find((r) => r.documentId === 1)!;
    expect(doc1.score).toBeCloseTo(0.25, 6);
    expect(doc1.reasons).toContain("a:half");
    expect(doc1.reasons).toContain("b:half-again");
  });

  test("exclude wins over multiply on the same candidate", () => {
    const pool = [result({ documentId: 1, score: 1 })];
    const multiplier: RankAdjuster = { name: "m", adjust: () => multiplyVerdict(0.5, "half") };
    const excluder: RankAdjuster = { name: "x", adjust: () => excludeVerdict("blocked") };
    const out = applyRankAdjusters(pool, [multiplier, excluder]);
    expect(out.results).toEqual([]);
    expect(out.excluded[0]!.reasons).toEqual(["x:blocked"]);
  });
});
