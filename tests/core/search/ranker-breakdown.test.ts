/**
 * Structured score breakdown: every ranked result carries a `breakdown`
 * object with the per-layer numeric components the final score is built
 * from. Pure exposure of values `rankResults` already computes - the
 * structured sibling of the human-readable `reasons` strings, and the
 * source `feedback.ts` and the MCP `explain` projection read.
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
const OLD = NOW / 1000 - 365 * 24 * 3600; // 0 recency

test("keyword-only hit breakdown mirrors the first-class lane fields", () => {
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
  expect(r.breakdown).toBeDefined();
  // The normalized lane components equal the first-class fields the
  // result already exposes - no divergent computation.
  expect(r.breakdown!.keyword).toBe(r.keywordScore);
  expect(r.breakdown!.semantic).toBe(r.semanticScore);
  expect(r.breakdown!.link).toBe(r.linkBoost);
  expect(r.breakdown!.recency).toBe(r.recencyBoost);
  // Layers that did not fire are exactly zero (not omitted, unlike reasons).
  expect(r.breakdown!.entity).toBe(0);
  expect(r.breakdown!.activation).toBe(0);
  expect(r.breakdown!.coAccess).toBe(0);
  expect(r.breakdown!.rrf).toBe(0);
  // Neutral multipliers report as 1.
  expect(r.breakdown!.tier).toBe(1);
  expect(r.breakdown!.trend).toBe(1);
});

test("entity boost surfaces as a structured number, not only a reason string", () => {
  const ranked = rankResults(
    {
      keyword: [{ chunkId: 1, documentId: 10, bm25: -5 }] as KeywordHit[],
      semantic: [] as SemanticHit[],
      hydrated: new Map([[1, hyd(1, 10, OLD)]]),
      inboundLinkSources: new Map(),
      tagsByDoc: new Map(),
      entityMatchByChunk: new Map([[1, 1]]),
    },
    { keywordWeight: 0.6, semanticWeight: 0.4, limit: 10, nowMs: NOW },
  );
  const r = ranked.find((x) => x.chunkId === 1)!;
  expect(r.breakdown!.entity).toBeGreaterThan(0);
  // And it equals the value the reason string reports.
  const reason = r.reasons.find((x) => x.startsWith("entity_match: "))!;
  expect(r.breakdown!.entity).toBeCloseTo(Number(reason.slice("entity_match: ".length)), 3);
});

test("breakdown is frozen", () => {
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
  expect(Object.isFrozen(ranked[0]!.breakdown)).toBe(true);
});
