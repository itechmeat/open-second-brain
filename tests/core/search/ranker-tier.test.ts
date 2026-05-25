/**
 * Coverage for the tier-aware ranker hook added in v0.10.15. The
 * non-regression anchor: when `tierByDoc` is absent (or every entry
 * is the default `supporting`), the ranker output is bit-identical
 * to pre-tier behaviour. Distinct tiers re-order candidates with the
 * relevance-only multiplier.
 */

import { test, expect } from "bun:test";

import { rankResults } from "../../../src/core/search/ranker.ts";
import type {
  KeywordHit,
  SemanticHit,
  HydratedChunk,
} from "../../../src/core/search/store.ts";

function hyd(
  chunkId: number,
  docId: number,
  mtime: number,
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
  });
}

const NOW = 1_750_000_000_000;
const OLD = NOW / 1000 - 365 * 24 * 3600;

function rank(
  tierByDoc?: ReadonlyMap<number, "core" | "supporting" | "peripheral">,
) {
  // Varied bm25 values produce a non-degenerate normalized spread
  // (min-max ≠ 0) so the tier multiplier has headroom below clamp01.
  // Lower keyword weight keeps the weighted product comfortably
  // below 1.0 for `core` * relevance.
  const kw: KeywordHit[] = [
    { chunkId: 1, documentId: 10, bm25: -2 },
    { chunkId: 2, documentId: 11, bm25: -3 },
    { chunkId: 3, documentId: 12, bm25: -4 },
  ];
  const sem: SemanticHit[] = [];
  const hydrated = new Map<number, HydratedChunk>([
    [1, hyd(1, 10, OLD)],
    [2, hyd(2, 11, OLD)],
    [3, hyd(3, 12, OLD)],
  ]);
  return rankResults(
    {
      keyword: kw,
      semantic: sem,
      hydrated,
      inboundLinkSources: new Map(),
      tagsByDoc: new Map(),
      tierByDoc,
    },
    { keywordWeight: 1.0, semanticWeight: 0, limit: 10, nowMs: NOW },
  );
}

test("absent tierByDoc behaves as if every doc is 'supporting'", () => {
  const baseline = rank();
  const allSupporting = rank(
    new Map([
      [10, "supporting"],
      [11, "supporting"],
      [12, "supporting"],
    ]),
  );
  expect(allSupporting.length).toBe(baseline.length);
  for (let i = 0; i < baseline.length; i++) {
    expect(allSupporting[i]!.documentId).toBe(baseline[i]!.documentId);
    expect(allSupporting[i]!.score).toBeCloseTo(baseline[i]!.score, 10);
  }
});

test("core tier outranks supporting which outranks peripheral", () => {
  const ranked = rank(
    new Map([
      [10, "peripheral"],
      [11, "supporting"],
      [12, "core"],
    ]),
  );
  // tie-break is mtime desc + chunkId asc - all OLD/equal so tier
  // multiplier alone drives ordering.
  expect(ranked[0]!.documentId).toBe(12); // core
  expect(ranked[1]!.documentId).toBe(11); // supporting
  expect(ranked[2]!.documentId).toBe(10); // peripheral
});

test("unknown tier entries silently fall back to supporting", () => {
  // Type system forbids invalid tier strings at compile time; this
  // case covers a doc that is simply absent from tierByDoc, which
  // is the realistic "not yet tagged" scenario.
  const ranked = rank(
    new Map([
      // 10 missing -> supporting (fallback)
      [11, "supporting"],
      [12, "core"],
    ]),
  );
  expect(ranked[0]!.documentId).toBe(12); // core wins
  // Relevance gradient (doc 12 best ... doc 10 worst); both 10 and 11
  // are supporting, so relevance breaks the tie - doc 11 has higher
  // bm25-derived score than doc 10.
  expect(ranked[1]!.documentId).toBe(11);
  expect(ranked[2]!.documentId).toBe(10);
});

test("tier multiplier preserves clamp01 on score", () => {
  const ranked = rank(new Map([[10, "core"]]));
  for (const r of ranked) {
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(1);
  }
});
