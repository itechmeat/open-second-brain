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
