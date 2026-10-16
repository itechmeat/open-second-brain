/**
 * Per-pack retrieval trust receipts (t_5f61130a): two compact-reference
 * receipts consistent with the existing context-receipt model. Neither
 * duplicates result payloads - they reference candidates by id / path and
 * carry counts and reasons only.
 */

import { test, expect, describe } from "bun:test";

import {
  buildMemoryTrustAssessment,
  buildRetrievalDecisionTrace,
  RETRIEVAL_TRUST_REFUSAL_LANE,
  type RetrievalTrustRefusal,
} from "../../../../src/core/brain/trust/retrieval-receipts.ts";
import type { RankAdjustExclusion } from "../../../../src/core/search/rank-adjust.ts";

const exclusions: ReadonlyArray<RankAdjustExclusion> = Object.freeze([
  Object.freeze({
    documentId: 2,
    chunkId: 20,
    path: "quarantined.md",
    reasons: Object.freeze(["trust_gate:self_approval_quarantine"]),
  }),
  Object.freeze({
    documentId: 3,
    chunkId: 30,
    path: "tainted.md",
    reasons: Object.freeze(["trust_gate:entity_contamination"]),
  }),
]);

describe("buildRetrievalDecisionTrace", () => {
  test("counts survivors and excluded, listing each exclusion with reasons", () => {
    const trace = buildRetrievalDecisionTrace({ surfaced: 5, excluded: exclusions });
    expect(trace).toEqual({
      evaluated: 7,
      surfaced: 5,
      excluded: 2,
      exclusions: [
        {
          document_id: 2,
          chunk_id: 20,
          path: "quarantined.md",
          reasons: ["trust_gate:self_approval_quarantine"],
        },
        {
          document_id: 3,
          chunk_id: 30,
          path: "tainted.md",
          reasons: ["trust_gate:entity_contamination"],
        },
      ],
    });
  });

  test("no exclusions yields an empty trace with matching counts", () => {
    const trace = buildRetrievalDecisionTrace({ surfaced: 3, excluded: [] });
    expect(trace).toEqual({ evaluated: 3, surfaced: 3, excluded: 0, exclusions: [] });
  });

  test("carries no result bodies (compact reference only)", () => {
    const trace = buildRetrievalDecisionTrace({ surfaced: 1, excluded: exclusions });
    expect(JSON.stringify(trace)).not.toContain("body");
    expect(JSON.stringify(trace)).not.toContain("content");
  });
});

describe("buildMemoryTrustAssessment", () => {
  test("summarizes trust posture with a reason histogram", () => {
    const assessment = buildMemoryTrustAssessment({ surfaced: 5, excluded: exclusions });
    expect(assessment).toEqual({
      evaluated: 7,
      surfaced: 5,
      quarantined: 2,
      reason_counts: {
        "trust_gate:entity_contamination": 1,
        "trust_gate:self_approval_quarantine": 1,
      },
    });
  });

  test("clean pack reports zero quarantined and an empty histogram", () => {
    const assessment = buildMemoryTrustAssessment({ surfaced: 4, excluded: [] });
    expect(assessment).toEqual({
      evaluated: 4,
      surfaced: 4,
      quarantined: 0,
      reason_counts: {},
    });
  });
});

// ── Shadow measurements (session-mining-economy, t_05a0eaa4) ────────────────

const poolRefusal: RetrievalTrustRefusal = Object.freeze({
  document_id: 4,
  chunk_id: 40,
  path: "would-be.md",
  reasons: Object.freeze(["trust_gate:self_approval_quarantine"]),
  lane: RETRIEVAL_TRUST_REFUSAL_LANE.pool,
});
const secondPoolRefusal: RetrievalTrustRefusal = Object.freeze({
  document_id: 5,
  chunk_id: 50,
  path: "would-be-2.md",
  reasons: Object.freeze(["trust_gate:entity_contamination"]),
  lane: RETRIEVAL_TRUST_REFUSAL_LANE.pool,
});
const armRefusal: RetrievalTrustRefusal = Object.freeze({
  document_id: 6,
  chunk_id: 60,
  path: "arm-reached.md",
  reasons: Object.freeze(["relational_arm:entity_contamination"]),
  lane: RETRIEVAL_TRUST_REFUSAL_LANE.arm,
});

describe("shadow refusals on the receipts", () => {
  test("the trace keeps excluded untouched and reports refusals beside it", () => {
    const trace = buildRetrievalDecisionTrace({
      surfaced: 5,
      excluded: [],
      shadow: { refusals: [poolRefusal, armRefusal] },
    });
    expect(trace).toEqual({
      evaluated: 5,
      surfaced: 5,
      excluded: 0,
      exclusions: [],
      mode: "shadow",
      refused: 2,
      refusals: [poolRefusal, armRefusal],
    });
  });

  test("without shadow input the trace keeps today's exact shape", () => {
    const trace = buildRetrievalDecisionTrace({ surfaced: 1, excluded: [] });
    expect(Object.keys(trace)).toEqual(["evaluated", "surfaced", "excluded", "exclusions"]);
  });

  test("the assessment reports refused counts per lane, never folded into quarantined", () => {
    const assessment = buildMemoryTrustAssessment({
      surfaced: 5,
      excluded: exclusions,
      shadow: { refusals: [poolRefusal, secondPoolRefusal, armRefusal] },
    });
    expect(assessment.mode).toBe("shadow");
    // `quarantined` keeps meaning actually dropped; the measured-only
    // refusals ride beside it, split per lane.
    expect(assessment.quarantined).toBe(2);
    expect(assessment.refused).toBe(3);
    expect(assessment.refusals_by_lane).toEqual({ arm: 1, pool: 2 });
    expect(assessment.refused_reason_counts).toEqual({
      arm: { "relational_arm:entity_contamination": 1 },
      pool: {
        "trust_gate:entity_contamination": 1,
        "trust_gate:self_approval_quarantine": 1,
      },
    });
  });

  test("without shadow input the assessment keeps today's exact shape", () => {
    const assessment = buildMemoryTrustAssessment({ surfaced: 4, excluded: [] });
    expect(Object.keys(assessment)).toEqual([
      "evaluated",
      "surfaced",
      "quarantined",
      "reason_counts",
    ]);
  });
});

// ── Enforced arm drops on the receipts (session-mining-economy) ─────────────

describe("enforced arm drops on the receipts", () => {
  test("the trace carries the arm's drops without a shadow mode stamp", () => {
    const trace = buildRetrievalDecisionTrace({
      surfaced: 5,
      excluded: exclusions,
      enforce: { refusals: [armRefusal] },
    });
    expect(trace.refused).toBe(1);
    expect(trace.refusals).toEqual([armRefusal]);
    // The drop is receipted, but an enforce receipt never names itself
    // shadow: the mode stamp stays shadow-only.
    expect("mode" in trace).toBe(false);
  });

  test("the assessment aggregates the arm's drops per lane beside quarantined", () => {
    const assessment = buildMemoryTrustAssessment({
      surfaced: 5,
      excluded: exclusions,
      enforce: { refusals: [armRefusal] },
    });
    // `quarantined` keeps meaning the pool's actual drops; the arm's
    // pre-pool drops ride beside them, split per lane.
    expect(assessment.quarantined).toBe(2);
    expect(assessment.refused).toBe(1);
    expect(assessment.refusals_by_lane).toEqual({ arm: 1, pool: 0 });
    expect(assessment.refused_reason_counts).toEqual({
      arm: { "relational_arm:entity_contamination": 1 },
      pool: {},
    });
    expect("mode" in assessment).toBe(false);
  });

  test("no enforce section keeps today's exact shape on both receipts", () => {
    const trace = buildRetrievalDecisionTrace({ surfaced: 1, excluded: [] });
    const assessment = buildMemoryTrustAssessment({ surfaced: 1, excluded: [] });
    expect("refusals" in trace).toBe(false);
    expect("refused" in trace).toBe(false);
    expect("refusals_by_lane" in assessment).toBe(false);
    expect(Object.keys(assessment)).toEqual([
      "evaluated",
      "surfaced",
      "quarantined",
      "reason_counts",
    ]);
  });
});
