/**
 * Reconcile domain classification (Brain lifecycle suite, Feature 3).
 *
 * Deterministic, structural-only classification of a contradiction into
 * one of four domains, plus a conservative resolver: ONLY the
 * source-freshness domain auto-resolves (toward the strictly fresher
 * side, beyond a margin); every other domain - and an ambiguous
 * freshness case - becomes an operator-facing open question. No
 * language inspection, no LLM fan-out.
 */

import { describe, expect, test } from "bun:test";

import {
  classifyContradiction,
  resolveContradiction,
  RECONCILE_DOMAIN,
  type ContradictionInput,
} from "../../../src/core/brain/reconcile-domains.ts";

const now = new Date("2026-05-29T12:00:00Z");

function input(over: Partial<ContradictionInput> = {}): ContradictionInput {
  return {
    topic: "commit-style",
    positives: [{ created_at: "2026-05-20T00:00:00Z" }],
    negatives: [{ created_at: "2026-05-21T00:00:00Z" }],
    ...over,
  };
}

describe("RECONCILE_DOMAIN", () => {
  test("exposes the four canonical domains", () => {
    expect(RECONCILE_DOMAIN.claims).toBe("claims");
    expect(RECONCILE_DOMAIN.entity).toBe("entity");
    expect(RECONCILE_DOMAIN.decisions).toBe("decisions");
    expect(RECONCILE_DOMAIN.sourceFreshness).toBe("source-freshness");
  });
});

describe("classifyContradiction", () => {
  test("scope 'decisions' classifies as the decisions domain", () => {
    expect(classifyContradiction(input({ scope: "decisions" }))).toBe("decisions");
  });

  test("entity wikilinks in a signal source classify as the entity domain", () => {
    const out = classifyContradiction(
      input({
        positives: [{ created_at: "2026-05-20T00:00:00Z", source: ["[[Acme Corp]]"] }],
      }),
    );
    expect(out).toBe("entity");
  });

  test("a recency separation with no entity/decisions marker is source-freshness", () => {
    const out = classifyContradiction(
      input({
        positives: [{ created_at: "2026-05-01T00:00:00Z" }],
        negatives: [{ created_at: "2026-05-28T00:00:00Z" }],
      }),
    );
    expect(out).toBe("source-freshness");
  });

  test("same-day signals with no markers fall back to claims", () => {
    const out = classifyContradiction(
      input({
        positives: [{ created_at: "2026-05-20T00:00:00Z" }],
        negatives: [{ created_at: "2026-05-20T00:00:00Z" }],
      }),
    );
    expect(out).toBe("claims");
  });
});

describe("resolveContradiction", () => {
  test("auto-resolves source-freshness toward the fresher side beyond the margin", () => {
    const out = resolveContradiction(
      input({
        positives: [{ created_at: "2026-05-01T00:00:00Z" }],
        negatives: [{ created_at: "2026-05-28T00:00:00Z" }],
      }),
      { now, freshnessMarginDays: 7 },
    );
    expect(out.kind).toBe("auto-resolved");
    if (out.kind === "auto-resolved") {
      expect(out.domain).toBe("source-freshness");
      expect(out.winner_sign).toBe("negative"); // the newer side
    }
  });

  test("source-freshness within the margin stays an open question", () => {
    const out = resolveContradiction(
      input({
        positives: [{ created_at: "2026-05-26T00:00:00Z" }],
        negatives: [{ created_at: "2026-05-28T00:00:00Z" }],
      }),
      { now, freshnessMarginDays: 7 },
    );
    expect(out.kind).toBe("open-question");
  });

  test("a claims contradiction is never auto-resolved", () => {
    const out = resolveContradiction(
      input({
        positives: [{ created_at: "2026-05-20T00:00:00Z" }],
        negatives: [{ created_at: "2026-05-20T00:00:00Z" }],
      }),
      { now, freshnessMarginDays: 7 },
    );
    expect(out.kind).toBe("open-question");
    if (out.kind === "open-question") {
      expect(out.question.domain).toBe("claims");
      expect(out.question.topic).toBe("commit-style");
    }
  });

  test("a decisions contradiction is never auto-resolved even with a recency gap", () => {
    const out = resolveContradiction(
      input({
        scope: "decisions",
        positives: [{ created_at: "2026-05-01T00:00:00Z" }],
        negatives: [{ created_at: "2026-05-28T00:00:00Z" }],
      }),
      { now, freshnessMarginDays: 7 },
    );
    expect(out.kind).toBe("open-question");
    if (out.kind === "open-question") {
      expect(out.question.domain).toBe("decisions");
    }
  });

  test("is deterministic and never throws on empty sides", () => {
    const empty = resolveContradiction(
      { topic: "x", positives: [], negatives: [] },
      { now, freshnessMarginDays: 7 },
    );
    expect(empty.kind).toBe("open-question");
  });
});
