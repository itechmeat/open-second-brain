/**
 * Explainable recall: every ranked result carries a `reasons` array,
 * one entry per scoring layer that actually contributed. Pure exposure
 * of the values `rankResults` already computes - no new ranking logic.
 */

import { test, expect } from "bun:test";

import { rankResults } from "../../../src/core/search/ranker.ts";
import type { KeywordHit, SemanticHit, HydratedChunk } from "../../../src/core/search/store.ts";

function hyd(
  chunkId: number,
  docId: number,
  mtime: number,
  path = `doc${docId}.md`,
): HydratedChunk {
  return Object.freeze({
    chunkId,
    documentId: docId,
    path,
    title: `Doc ${docId}`,
    content: `chunk ${chunkId}`,
    startLine: 1,
    endLine: 1,
    mtime,
  });
}

const NOW = 1_750_000_000_000;
const RECENT = NOW / 1000 - 3 * 24 * 3600; // ~0.05 recency
const OLD = NOW / 1000 - 365 * 24 * 3600; // 0 recency

function reasonLayers(reasons: ReadonlyArray<string>): string[] {
  return reasons.map((r) => r.split(":")[0]!.trim());
}

test("keyword-only hit lists exactly the fts5_bm25 layer", () => {
  const ranked = rankResults(
    {
      keyword: [{ chunkId: 1, documentId: 10, bm25: -5 }] as KeywordHit[],
      semantic: [] as SemanticHit[],
      hydrated: new Map([[1, hyd(1, 10, OLD)]]),
      inboundLinkSources: new Map(),
      tagsByDoc: new Map(),
    },
    { keywordWeight: 0.6, semanticWeight: 0.4, limit: 10, nowMs: NOW },
  );
  const r = ranked.find((x) => x.chunkId === 1)!;
  expect(Array.isArray(r.reasons)).toBe(true);
  expect(reasonLayers(r.reasons)).toEqual(["fts5_bm25"]);
});

test("hybrid hit lists both keyword and semantic layers", () => {
  const ranked = rankResults(
    {
      keyword: [{ chunkId: 2, documentId: 11, bm25: -3 }] as KeywordHit[],
      semantic: [{ chunkId: 2, documentId: 11, distance: 0.3 }] as SemanticHit[],
      hydrated: new Map([[2, hyd(2, 11, OLD)]]),
      inboundLinkSources: new Map(),
      tagsByDoc: new Map(),
    },
    { keywordWeight: 0.6, semanticWeight: 0.4, limit: 10, nowMs: NOW },
  );
  const r = ranked.find((x) => x.chunkId === 2)!;
  const layers = reasonLayers(r.reasons);
  expect(layers).toContain("fts5_bm25");
  expect(layers).toContain("semantic_cos");
});

test("recent + linked hit also lists link and recency layers", () => {
  // Two candidate docs that link to each other so the inbound link boost
  // fires; both recent so recency fires.
  const ranked = rankResults(
    {
      keyword: [
        { chunkId: 1, documentId: 10, bm25: -5 },
        { chunkId: 2, documentId: 11, bm25: -5 },
      ] as KeywordHit[],
      semantic: [] as SemanticHit[],
      hydrated: new Map([
        [1, hyd(1, 10, RECENT)],
        [2, hyd(2, 11, RECENT)],
      ]),
      // doc 11 links to chunk 1's doc (10) and vice-versa.
      inboundLinkSources: new Map([
        [1, new Set([11])],
        [2, new Set([10])],
      ]),
      tagsByDoc: new Map(),
    },
    { keywordWeight: 0.6, semanticWeight: 0.4, limit: 10, nowMs: NOW },
  );
  const r = ranked.find((x) => x.chunkId === 1)!;
  const layers = reasonLayers(r.reasons);
  expect(layers).toContain("fts5_bm25");
  expect(layers).toContain("link_boost");
  expect(layers).toContain("recency");
});

test("semantic layer omitted when its contribution is zero", () => {
  // semanticEnabled false → semantic score forced to 0 → no semantic reason.
  const ranked = rankResults(
    {
      keyword: [{ chunkId: 1, documentId: 10, bm25: -5 }] as KeywordHit[],
      semantic: [{ chunkId: 1, documentId: 10, distance: 0.1 }] as SemanticHit[],
      hydrated: new Map([[1, hyd(1, 10, OLD)]]),
      inboundLinkSources: new Map(),
      tagsByDoc: new Map(),
    },
    {
      keywordWeight: 0.6,
      semanticWeight: 0.4,
      limit: 10,
      nowMs: NOW,
      semanticEnabled: false,
    },
  );
  const r = ranked.find((x) => x.chunkId === 1)!;
  expect(reasonLayers(r.reasons)).not.toContain("semantic_cos");
});

test("reasons array is frozen", () => {
  const ranked = rankResults(
    {
      keyword: [{ chunkId: 1, documentId: 10, bm25: -5 }] as KeywordHit[],
      semantic: [] as SemanticHit[],
      hydrated: new Map([[1, hyd(1, 10, OLD)]]),
      inboundLinkSources: new Map(),
      tagsByDoc: new Map(),
    },
    { keywordWeight: 0.6, semanticWeight: 0.4, limit: 10, nowMs: NOW },
  );
  expect(Object.isFrozen(ranked[0]!.reasons)).toBe(true);
});

test("session focus can re-rank a focused path and explains the contribution", () => {
  const ranked = rankResults(
    {
      keyword: [
        { chunkId: 1, documentId: 10, bm25: -5 },
        { chunkId: 2, documentId: 11, bm25: -5 },
      ] as KeywordHit[],
      semantic: [] as SemanticHit[],
      hydrated: new Map([
        [1, hyd(1, 10, OLD, "archive/other.md")],
        [2, hyd(2, 11, OLD, "sessions/focus.md")],
      ]),
      inboundLinkSources: new Map(),
      tagsByDoc: new Map(),
    },
    {
      keywordWeight: 0.6,
      semanticWeight: 0.4,
      limit: 10,
      nowMs: NOW,
      sessionFocus: { query: null, pathPrefix: "sessions/", expiresAt: NOW + 60_000 },
    },
  );

  expect(ranked[0]?.path).toBe("sessions/focus.md");
  expect(ranked[0]?.reasons.some((reason) => reason.startsWith("session_focus:"))).toBe(true);
});
