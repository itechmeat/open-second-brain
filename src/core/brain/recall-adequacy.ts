/**
 * Recall adequacy verdict (retrieval-precision-quality-loop, t_b8f66fec).
 *
 * A thin verdict + action layer over the relevance scores the recall
 * stack already produces (search / recall-telemetry `top_artifacts`
 * scores). It does NOT search or re-rank; given the top-k scores of a
 * recall attempt it classifies grounding fitness and names the explicit
 * low-adequacy action so callers can branch instead of always feeding
 * top-k to the LLM:
 *
 *   sufficient   -> proceed     (grounding is strong enough to answer)
 *   weak         -> re_recall   (broaden scope / try an alternate path first)
 *   insufficient -> abstain     (return an explicit 'insufficient grounding'
 *                                signal, and escalate for review)
 *
 * Language-agnostic and deterministic: it reads only numeric scores, so
 * it behaves identically for any prompt language. Complements the
 * epistemic-provenance card (which feeds grounded scores into this gate).
 */

export const RECALL_ADEQUACY_LEVELS = ["sufficient", "weak", "insufficient"] as const;
export type RecallAdequacyLevel = (typeof RECALL_ADEQUACY_LEVELS)[number];

export const RECALL_ADEQUACY_ACTIONS = ["proceed", "re_recall", "abstain"] as const;
export type RecallAdequacyAction = (typeof RECALL_ADEQUACY_ACTIONS)[number];

export interface RecallAdequacyThresholds {
  /** Top score at/above which recall is sufficient. */
  readonly sufficient: number;
  /** Top score at/above which recall is at least weak (below => insufficient). */
  readonly weak: number;
  /** Minimum usable-result count below which recall cannot be sufficient. */
  readonly minResults: number;
}

export const DEFAULT_RECALL_ADEQUACY_THRESHOLDS: RecallAdequacyThresholds = Object.freeze({
  sufficient: 0.6,
  weak: 0.3,
  minResults: 1,
});

export interface RecallAdequacyVerdict {
  readonly level: RecallAdequacyLevel;
  readonly action: RecallAdequacyAction;
  /** True when the result should be flagged for review / surfaced to an operator. */
  readonly escalate: boolean;
  readonly resultCount: number;
  /** Highest usable score, or 0 when there are no usable results. */
  readonly topScore: number;
  /** Mean of usable scores, or 0 when there are no usable results. */
  readonly meanScore: number;
  readonly reason: string;
}

const ACTION_BY_LEVEL: Readonly<Record<RecallAdequacyLevel, RecallAdequacyAction>> = Object.freeze({
  sufficient: "proceed",
  weak: "re_recall",
  insufficient: "abstain",
});

function resolveThresholds(
  overrides?: Partial<RecallAdequacyThresholds>,
): RecallAdequacyThresholds {
  const merged = { ...DEFAULT_RECALL_ADEQUACY_THRESHOLDS, ...overrides };
  const { sufficient, weak, minResults } = merged;
  for (const [name, value] of [
    ["sufficient", sufficient],
    ["weak", weak],
  ] as const) {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error(`recall adequacy: ${name} threshold must be in [0,1]; got ${value}`);
    }
  }
  if (weak > sufficient) {
    throw new Error(
      `recall adequacy: weak threshold (${weak}) must not exceed sufficient threshold (${sufficient})`,
    );
  }
  if (!Number.isInteger(minResults) || minResults < 1) {
    throw new Error(`recall adequacy: minResults must be a positive integer; got ${minResults}`);
  }
  return Object.freeze({ sufficient, weak, minResults });
}

/** Round to 4 decimals so verdict payloads stay stable and compact. */
function round4(value: number): number {
  return Math.round(value * 1e4) / 1e4;
}

/**
 * Classify recall fitness from the relevance scores of a recall attempt
 * and name the explicit action. Non-finite scores are dropped; negative
 * scores clamp to 0 (search scores are normalized to [0,1]).
 */
export function assessRecallAdequacy(
  scores: ReadonlyArray<number>,
  overrides?: Partial<RecallAdequacyThresholds>,
): RecallAdequacyVerdict {
  const thresholds = resolveThresholds(overrides);
  const usable = scores.filter((s) => Number.isFinite(s)).map((s) => Math.max(0, s));
  const resultCount = usable.length;

  if (resultCount === 0) {
    return finalize("insufficient", {
      resultCount: 0,
      topScore: 0,
      meanScore: 0,
      reason: "no recall results — insufficient grounding",
    });
  }

  const topScore = Math.max(...usable);
  const meanScore = usable.reduce((a, b) => a + b, 0) / resultCount;

  if (topScore >= thresholds.sufficient) {
    if (resultCount >= thresholds.minResults) {
      return finalize("sufficient", {
        resultCount,
        topScore,
        meanScore,
        reason: `top score ${round4(topScore)} >= sufficient ${thresholds.sufficient} across ${resultCount} result(s) — sufficient grounding`,
      });
    }
    // Strong single hit but too few corroborating results: re-recall to
    // broaden before answering rather than proceed on a lone signal.
    return finalize("weak", {
      resultCount,
      topScore,
      meanScore,
      reason: `strong top score ${round4(topScore)} but only ${resultCount} result(s) < min_results ${thresholds.minResults} — re-recall to broaden`,
    });
  }

  if (topScore >= thresholds.weak) {
    return finalize("weak", {
      resultCount,
      topScore,
      meanScore,
      reason: `top score ${round4(topScore)} in [${thresholds.weak}, ${thresholds.sufficient}) — weak grounding, re-recall via alternate strategy`,
    });
  }

  return finalize("insufficient", {
    resultCount,
    topScore,
    meanScore,
    reason: `top score ${round4(topScore)} < weak ${thresholds.weak} — insufficient grounding, abstain`,
  });
}

function finalize(
  level: RecallAdequacyLevel,
  parts: {
    readonly resultCount: number;
    readonly topScore: number;
    readonly meanScore: number;
    readonly reason: string;
  },
): RecallAdequacyVerdict {
  return Object.freeze({
    level,
    action: ACTION_BY_LEVEL[level],
    escalate: level === "insufficient",
    resultCount: parts.resultCount,
    topScore: round4(parts.topScore),
    meanScore: round4(parts.meanScore),
    reason: parts.reason,
  });
}
