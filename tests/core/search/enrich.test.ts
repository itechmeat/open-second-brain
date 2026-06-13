/**
 * Read-time enrichment projections (Search & Recall Quality Suite).
 * Pure functions over a ranked result - never stored, computed at read
 * time like recall-hint. This file covers the score_breakdown projection;
 * trust-metadata and hybrid-degrade cases live alongside as the suite lands.
 */

import { describe, test, expect } from "bun:test";

import {
  deriveTrust,
  detectHybridDegrade,
  projectScoreBreakdown,
} from "../../../src/core/search/enrich.ts";
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

describe("detectHybridDegrade", () => {
  test("flags a keyword-only degrade when semantic was wanted but did not run", () => {
    const w = detectHybridDegrade({
      wantSemantic: true,
      semanticAttempted: false,
      keywordHitCount: 5,
    });
    expect(w).not.toBeNull();
    expect(w!.startsWith("hybrid_degraded:")).toBe(true);
  });

  test("no warning when both lanes ran (genuine hybrid)", () => {
    expect(
      detectHybridDegrade({ wantSemantic: true, semanticAttempted: true, keywordHitCount: 5 }),
    ).toBeNull();
  });

  test("no warning when the caller did not want semantic (keyword-only by choice)", () => {
    expect(
      detectHybridDegrade({ wantSemantic: false, semanticAttempted: false, keywordHitCount: 5 }),
    ).toBeNull();
  });

  test("no warning when there are no keyword candidates to serve", () => {
    // Nothing was served, so there is no degraded result set to flag - that
    // is an empty query, not a silent single-lane fallback.
    expect(
      detectHybridDegrade({ wantSemantic: true, semanticAttempted: false, keywordHitCount: 0 }),
    ).toBeNull();
  });
});

describe("deriveTrust", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const NOW = 1_750_000_000_000;

  test("age_days is the whole-day distance from mtime, floored at zero", () => {
    const t = deriveTrust({ mtimeMs: NOW - 10 * DAY_MS, nowMs: NOW });
    expect(t.age_days).toBe(10);
    // A future mtime never reports a negative age.
    expect(deriveTrust({ mtimeMs: NOW + 5 * DAY_MS, nowMs: NOW }).age_days).toBe(0);
  });

  test("superseded and conflict default false with no relations", () => {
    const t = deriveTrust({ mtimeMs: NOW, nowMs: NOW });
    expect(t.superseded).toBe(false);
    expect(t.conflict).toBe(false);
  });

  test("superseded_by relation marks the hit superseded", () => {
    const t = deriveTrust({
      mtimeMs: NOW,
      nowMs: NOW,
      relations: [{ relation: "superseded_by", target: "newer.md" }],
    });
    expect(t.superseded).toBe(true);
    expect(t.conflict).toBe(false);
  });

  test("contradicts relation marks the hit conflicted", () => {
    const t = deriveTrust({
      mtimeMs: NOW,
      nowMs: NOW,
      relations: [{ relation: "contradicts", target: "other.md" }],
    });
    expect(t.conflict).toBe(true);
    expect(t.superseded).toBe(false);
  });

  test("unrelated relation types leave both flags false", () => {
    const t = deriveTrust({
      mtimeMs: NOW,
      nowMs: NOW,
      relations: [{ relation: "related", target: "x.md" }],
    });
    expect(t.superseded).toBe(false);
    expect(t.conflict).toBe(false);
  });

  test("result is frozen", () => {
    expect(Object.isFrozen(deriveTrust({ mtimeMs: NOW, nowMs: NOW }))).toBe(true);
  });
});
