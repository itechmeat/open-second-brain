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
