/**
 * Link-graph traversal during recall. Two-stage retrieve-then-walk:
 * after relevance ranking, follow outbound wikilinks from the top hits
 * and surface linked documents scored as parent_score * hop_decay^hop,
 * bounded by max_hops and max_expansion_per_hit, deduped against the
 * existing result set. Pure function over precomputed inputs.
 */

import { test, expect } from "bun:test";

import { expandByTraversal } from "../../../src/core/search/traversal.ts";
import type { BrainSearchResult } from "../../../src/core/search/types.ts";
import type { TraversalDoc } from "../../../src/core/search/traversal.ts";

let nextChunk = 100;
function res(docId: number, score: number): BrainSearchResult {
  const chunkId = nextChunk++;
  return Object.freeze({
    documentId: docId,
    chunkId,
    path: `doc${docId}.md`,
    title: `Doc ${docId}`,
    content: `content of ${docId}`,
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

function docFor(docId: number): TraversalDoc {
  return {
    documentId: docId,
    chunkId: 900 + docId,
    path: `doc${docId}.md`,
    title: `Doc ${docId}`,
    content: `content of ${docId}`,
    startLine: 1,
    endLine: 1,
  };
}

const OPTS = { maxHops: 1, hopDecay: 0.5, maxExpansionPerHit: 3 };

test("maxHops == 0 returns the ranked set unchanged", () => {
  const ranked = [res(1, 0.8)];
  const out = expandByTraversal(
    {
      ranked,
      outbound: new Map([[1, [2]]]),
      expansionDoc: docFor,
    },
    { ...OPTS, maxHops: 0 },
  );
  expect(out).toEqual(ranked);
});

test("a doc linked from a top hit is surfaced with a decayed score", () => {
  const out = expandByTraversal(
    {
      ranked: [res(1, 0.8)],
      outbound: new Map([[1, [2]]]),
      expansionDoc: docFor,
    },
    OPTS,
  );
  const added = out.find((r) => r.documentId === 2);
  expect(added).toBeDefined();
  expect(added!.score).toBeCloseTo(0.4, 6); // 0.8 * 0.5
  expect(added!.searchType).toBe("link");
  expect(added!.reasons.some((x) => x.startsWith("link_traversal"))).toBe(true);
});

test("a doc already present is not duplicated and keeps its higher score", () => {
  const out = expandByTraversal(
    {
      ranked: [res(1, 0.8), res(2, 0.7)],
      outbound: new Map([[1, [2]]]),
      expansionDoc: docFor,
    },
    OPTS,
  );
  const twos = out.filter((r) => r.documentId === 2);
  expect(twos).toHaveLength(1);
  expect(twos[0]!.score).toBeCloseTo(0.7, 6); // original relevance, not 0.4
});

test("expansion per hit is capped by maxExpansionPerHit", () => {
  const out = expandByTraversal(
    {
      ranked: [res(1, 0.8)],
      outbound: new Map([[1, [2, 3, 4, 5, 6]]]),
      expansionDoc: docFor,
    },
    { ...OPTS, maxExpansionPerHit: 2 },
  );
  const added = out.filter((r) => r.searchType === "link");
  expect(added).toHaveLength(2);
});

test("decay compounds across hops up to maxHops", () => {
  const out = expandByTraversal(
    {
      ranked: [res(1, 0.8)],
      outbound: new Map([
        [1, [2]],
        [2, [3]],
      ]),
      expansionDoc: docFor,
    },
    { maxHops: 2, hopDecay: 0.5, maxExpansionPerHit: 3 },
  );
  const c = out.find((r) => r.documentId === 3);
  expect(c).toBeDefined();
  expect(c!.score).toBeCloseTo(0.2, 6); // 0.8 * 0.5 * 0.5
});

test("results stay sorted by score descending after expansion", () => {
  const out = expandByTraversal(
    {
      ranked: [res(1, 0.8), res(9, 0.3)],
      outbound: new Map([[1, [2]]]),
      expansionDoc: docFor,
    },
    OPTS,
  );
  const scores = out.map((r) => r.score);
  const sorted = [...scores].toSorted((a, b) => b - a);
  expect(scores).toEqual(sorted);
});
