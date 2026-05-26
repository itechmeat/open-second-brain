/**
 * Entity-boosted ranking: when a candidate chunk shares entities with
 * the query, the ranker adds a small capped boost and records an
 * entity_match reason. With no entity-match map (or zero matches),
 * ranking is bit-identical to pre-entity behaviour.
 */

import { test, expect } from "bun:test";

import { rankResults } from "../../../src/core/search/ranker.ts";
import type {
  KeywordHit,
  HydratedChunk,
} from "../../../src/core/search/store.ts";

function hyd(chunkId: number, docId: number): HydratedChunk {
  return Object.freeze({
    chunkId,
    documentId: docId,
    path: `doc${docId}.md`,
    title: `Doc ${docId}`,
    content: `chunk ${chunkId}`,
    startLine: 1,
    endLine: 1,
    mtime: 0,
  });
}

const NOW = 1_750_000_000_000;

function baseInputs() {
  return {
    keyword: [
      { chunkId: 1, documentId: 10, bm25: -5 },
      { chunkId: 2, documentId: 11, bm25: -5 },
    ] as KeywordHit[],
    semantic: [],
    hydrated: new Map([
      [1, hyd(1, 10)],
      [2, hyd(2, 11)],
    ]),
    inboundLinkSources: new Map(),
    tagsByDoc: new Map(),
  };
}

test("a chunk with entity matches scores above an equal chunk without", () => {
  const ranked = rankResults(
    { ...baseInputs(), entityMatchByChunk: new Map([[2, 2]]) },
    { keywordWeight: 0.6, semanticWeight: 0.4, limit: 10, nowMs: NOW },
  );
  const one = ranked.find((r) => r.chunkId === 1)!;
  const two = ranked.find((r) => r.chunkId === 2)!;
  // Same bm25, but chunk 2 carries the entity boost.
  expect(two.score).toBeGreaterThan(one.score);
  expect(two.reasons.some((x) => x.startsWith("entity_match"))).toBe(true);
  expect(one.reasons.some((x) => x.startsWith("entity_match"))).toBe(false);
});

test("entity boost is capped regardless of match count", () => {
  const ranked = rankResults(
    { ...baseInputs(), entityMatchByChunk: new Map([[1, 50]]) },
    { keywordWeight: 0.6, semanticWeight: 0.4, limit: 10, nowMs: NOW },
  );
  const one = ranked.find((r) => r.chunkId === 1)!;
  // bm25 normalises to 1.0 here; with the cap the score stays <= 1.
  expect(one.score).toBeLessThanOrEqual(1);
  expect(one.score).toBeGreaterThan(0.6 * 1); // boosted above pure keyword
});

test("no entity-match map leaves scores bit-identical to pre-entity ranking", () => {
  const withoutArg = rankResults(baseInputs(), {
    keywordWeight: 0.6,
    semanticWeight: 0.4,
    limit: 10,
    nowMs: NOW,
  });
  const withEmpty = rankResults(
    { ...baseInputs(), entityMatchByChunk: new Map() },
    { keywordWeight: 0.6, semanticWeight: 0.4, limit: 10, nowMs: NOW },
  );
  expect(withEmpty.map((r) => r.score)).toEqual(withoutArg.map((r) => r.score));
});
