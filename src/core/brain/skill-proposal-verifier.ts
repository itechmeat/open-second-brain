/**
 * Skill-proposal verifier gate (K1, t_6fc8663c).
 *
 * A deterministic gate that runs BEFORE a proposal draft may reach the pending
 * queue. It validates the candidate against its OWN supporting records - the
 * distinct evidence count, the count of records that structurally support the
 * pattern, a confidence floor, and a present pattern key - so a thin or padded
 * candidate never lands in front of a human. Every check is a fixed structural
 * predicate; there is no natural-language word list.
 *
 * The verifier is pure: identical input yields an identical verdict. It reports
 * every check and, on rejection, a concise reason naming the failed checks.
 */

/** Minimum distinct supporting records for a candidate to be verifiable. */
export const VERIFIER_MIN_EVIDENCE = 3;

/** Minimum confidence for a candidate to pass the gate. */
export const VERIFIER_MIN_CONFIDENCE = 0.55;

/** One record's contribution to a candidate. */
export interface VerifierEvidence {
  readonly id: string;
  /** True when this record structurally supports the candidate's pattern. */
  readonly supportsPattern: boolean;
}

export interface VerifierCandidate {
  readonly patternKind: string;
  readonly key: string;
  readonly confidence: number;
  readonly evidence: readonly VerifierEvidence[];
}

export interface VerifierCheck {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

export interface VerifierVerdict {
  readonly accepted: boolean;
  /** "verified" when accepted, else a concise list of failed checks. */
  readonly reason: string;
  readonly checks: readonly VerifierCheck[];
}

export interface VerifySkillProposalOptions {
  /** Minimum distinct/supporting evidence; defaults to {@link VERIFIER_MIN_EVIDENCE}. */
  readonly minEvidence?: number;
  /** Confidence floor; defaults to {@link VERIFIER_MIN_CONFIDENCE}. */
  readonly minConfidence?: number;
}

/**
 * Verify a skill-proposal candidate against its supporting records. Returns an
 * accept/reject verdict with per-check detail and, on rejection, a reason.
 */
export function verifySkillProposalCandidate(
  candidate: VerifierCandidate,
  opts: VerifySkillProposalOptions = {},
): VerifierVerdict {
  const minEvidence = Math.max(1, Math.floor(opts.minEvidence ?? VERIFIER_MIN_EVIDENCE));
  const minConfidence = opts.minConfidence ?? VERIFIER_MIN_CONFIDENCE;

  const distinctIds = new Set(candidate.evidence.map((e) => e.id)).size;
  const supporting = new Set(candidate.evidence.filter((e) => e.supportsPattern).map((e) => e.id))
    .size;

  const checks: VerifierCheck[] = [
    {
      name: "key-present",
      passed: candidate.key.trim().length > 0,
      detail: "the pattern key must not be empty",
    },
    {
      name: "distinct-evidence",
      passed: distinctIds >= minEvidence,
      detail: `distinct evidence ${distinctIds} must be at least ${minEvidence}`,
    },
    {
      name: "supporting-evidence",
      passed: supporting >= minEvidence,
      detail: `supporting evidence ${supporting} must be at least ${minEvidence}`,
    },
    {
      name: "confidence-floor",
      passed: candidate.confidence >= minConfidence,
      detail: `confidence ${candidate.confidence} must be at least ${minConfidence}`,
    },
  ];

  const failed = checks.filter((c) => !c.passed);
  return {
    accepted: failed.length === 0,
    reason:
      failed.length === 0 ? "verified" : failed.map((c) => `${c.name}: ${c.detail}`).join("; "),
    checks: Object.freeze(checks),
  };
}
