/**
 * MMR diversity rerank. Greedy Maximal Marginal Relevance over the
 * fused result pool so near-identical paraphrases don't crowd out
 * complementary content. Similarity is a deterministic token-set
 * Jaccard over chunk content; relevance reuses the fused `score`.
 */

import { test, expect } from "bun:test";

import { mmrRerank } from "../../../src/core/search/mmr.ts";
import type { BrainSearchResult } from "../../../src/core/search/types.ts";

let nextId = 1;
function res(content: string, score: number): BrainSearchResult {
  const id = nextId++;
  return Object.freeze({
    documentId: id,
    chunkId: id,
    path: `doc${id}.md`,
    title: `Doc ${id}`,
    content,
    startLine: 1,
    endLine: 1,
    score,
    keywordScore: score,
    semanticScore: 0,
    linkBoost: 0,
    recencyBoost: 0,
    searchType: "keyword" as const,
    reasons: Object.freeze([`fts5_bm25: ${score.toFixed(3)}`]),
  });
}

test("lambda == 1 preserves input order (pure relevance)", () => {
  const input = [res("alpha beta", 0.9), res("alpha beta gamma", 0.85), res("zeta", 0.8)];
  const out = mmrRerank(input, { lambda: 1 });
  expect(out.map((r) => r.chunkId)).toEqual(input.map((r) => r.chunkId));
});

test("fewer than two results is identity", () => {
  const a = res("solo", 0.5);
  expect(mmrRerank([a], { lambda: 0.5 })).toEqual([a]);
  expect(mmrRerank([], { lambda: 0.5 })).toEqual([]);
});

test("near-duplicate of the top hit is demoted below a dissimilar lower-relevance hit", () => {
  const top = res("alpha beta gamma", 0.9);
  const dup = res("alpha beta gamma delta", 0.85); // 0.75 Jaccard with top
  const diverse = res("zeta eta theta", 0.8); // disjoint from top
  const out = mmrRerank([top, dup, diverse], { lambda: 0.5 });
  const order = out.map((r) => r.chunkId);
  expect(order[0]).toBe(top.chunkId); // highest relevance picked first
  expect(order[1]).toBe(diverse.chunkId); // diversity beats the near-dup
  expect(order[2]).toBe(dup.chunkId);
});

test("is deterministic across repeated runs", () => {
  const mk = () => [
    res("alpha beta gamma", 0.9),
    res("alpha beta gamma delta", 0.85),
    res("zeta eta theta", 0.8),
  ];
  // Same logical input → same output ordering by content.
  const a = mmrRerank(mk(), { lambda: 0.5 }).map((r) => r.content);
  const b = mmrRerank(mk(), { lambda: 0.5 }).map((r) => r.content);
  expect(a).toEqual(b);
});

test("a result reordered by MMR carries an mmr reason", () => {
  const top = res("alpha beta gamma", 0.9);
  const dup = res("alpha beta gamma delta", 0.85);
  const diverse = res("zeta eta theta", 0.8);
  const out = mmrRerank([top, dup, diverse], { lambda: 0.5 });
  const movedDup = out.find((r) => r.chunkId === dup.chunkId)!;
  expect(movedDup.reasons.some((x) => x.startsWith("mmr"))).toBe(true);
  // The untouched top result keeps its original reasons unchanged.
  const stayedTop = out.find((r) => r.chunkId === top.chunkId)!;
  expect(stayedTop.reasons.some((x) => x.startsWith("mmr"))).toBe(false);
});
