/**
 * Skill-proposal verifier gate (K1, t_6fc8663c). The deterministic verifier
 * validates a candidate against its own supporting records - evidence count and
 * structural checks - before the draft may reach the pending queue. A rejection
 * records a reason.
 */

import { describe, expect, test } from "bun:test";

import {
  VERIFIER_MIN_CONFIDENCE,
  VERIFIER_MIN_EVIDENCE,
  verifySkillProposalCandidate,
  type VerifierCandidate,
} from "../../../src/core/brain/skill-proposal-verifier.ts";

function evidence(count: number, supporting: number): VerifierCandidate["evidence"] {
  return Array.from({ length: count }, (_v, i) => ({
    id: `rec-${i}`,
    supportsPattern: i < supporting,
  }));
}

function candidate(overrides: Partial<VerifierCandidate> = {}): VerifierCandidate {
  return {
    patternKind: "repeated_action",
    key: "triage_inbox",
    confidence: 0.9,
    evidence: evidence(VERIFIER_MIN_EVIDENCE, VERIFIER_MIN_EVIDENCE),
    ...overrides,
  };
}

describe("verifySkillProposalCandidate", () => {
  test("a well-supported candidate is accepted", () => {
    const verdict = verifySkillProposalCandidate(candidate());
    expect(verdict.accepted).toBe(true);
    expect(verdict.checks.every((c) => c.passed)).toBe(true);
  });

  test("too few supporting records is rejected with a reason", () => {
    const verdict = verifySkillProposalCandidate(
      candidate({ evidence: evidence(VERIFIER_MIN_EVIDENCE, VERIFIER_MIN_EVIDENCE - 1) }),
    );
    expect(verdict.accepted).toBe(false);
    expect(verdict.reason.length).toBeGreaterThan(0);
    expect(verdict.checks.some((c) => !c.passed && c.name === "supporting-evidence")).toBe(true);
  });

  test("duplicate evidence ids do not satisfy the distinct-evidence check", () => {
    const dupes: VerifierCandidate["evidence"] = [
      { id: "same", supportsPattern: true },
      { id: "same", supportsPattern: true },
      { id: "same", supportsPattern: true },
    ];
    const verdict = verifySkillProposalCandidate(candidate({ evidence: dupes }));
    expect(verdict.accepted).toBe(false);
    expect(verdict.checks.some((c) => !c.passed && c.name === "distinct-evidence")).toBe(true);
  });

  test("a below-floor confidence is rejected", () => {
    const verdict = verifySkillProposalCandidate(
      candidate({ confidence: VERIFIER_MIN_CONFIDENCE - 0.01 }),
    );
    expect(verdict.accepted).toBe(false);
    expect(verdict.checks.some((c) => !c.passed && c.name === "confidence-floor")).toBe(true);
  });

  test("an empty key is rejected structurally", () => {
    const verdict = verifySkillProposalCandidate(candidate({ key: "  " }));
    expect(verdict.accepted).toBe(false);
    expect(verdict.checks.some((c) => !c.passed && c.name === "key-present")).toBe(true);
  });
});
