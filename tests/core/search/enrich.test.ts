/**
 * Read-time enrichment projections (Search & Recall Quality Suite).
 * Pure functions over a ranked result - never stored, computed at read
 * time like recall-hint. This file covers the score_breakdown projection;
 * trust-metadata and hybrid-degrade cases live alongside as the suite lands.
 */

import { test, expect } from "bun:test";

import { projectScoreBreakdown } from "../../../src/core/search/enrich.ts";
import type { BrainSearchResult, ScoreBreakdown } from "../../../src/core/search/types.ts";

function result(over: Partial<BrainSearchResult>): BrainSearchResult {
  return Object.freeze({
    documentId: 1,
    chunkId: 1,
    path: "doc.md",
    title: "Doc",
    content: "body",
    startLine: 1,
    endLine: 1,
    score: 0.5,
    keywordScore: 0.4,
    semanticScore: 0.2,
    linkBoost: 0.01,
    recencyBoost: 0.03,
    searchType: "keyword",
    reasons: Object.freeze([]),
    ...over,
  }) as BrainSearchResult;
}

test("projects the ranker breakdown verbatim when present", () => {
  const breakdown: ScoreBreakdown = Object.freeze({
    keyword: 0.4,
    semantic: 0.2,
    rrf: 0,
    entity: 0.02,
    activation: 0,
    coAccess: 0,
    link: 0.01,
    recency: 0.03,
    tier: 1.2,
    trend: 1,
    sessionFocus: 0,
  });
  const out = projectScoreBreakdown(result({ breakdown }));
  expect(out).toEqual(breakdown);
});

test("derives a faithful breakdown from first-class fields when breakdown is absent", () => {
  // Synthetic results (traversal expansions, successor pull-ins) carry no
  // breakdown; the projection falls back to the lane/boost fields they DO
  // expose, with non-derivable layers honestly zero.
  const out = projectScoreBreakdown(
    result({ keywordScore: 0.7, semanticScore: 0.1, linkBoost: 0.02, recencyBoost: 0.05 }),
  );
  expect(out.keyword).toBe(0.7);
  expect(out.semantic).toBe(0.1);
  expect(out.link).toBe(0.02);
  expect(out.recency).toBe(0.05);
  expect(out.entity).toBe(0);
  expect(out.activation).toBe(0);
  expect(out.coAccess).toBe(0);
  expect(out.rrf).toBe(0);
  expect(out.tier).toBe(1);
  expect(out.trend).toBe(1);
  expect(out.sessionFocus).toBe(0);
});

test("projection is frozen", () => {
  expect(Object.isFrozen(projectScoreBreakdown(result({})))).toBe(true);
});
