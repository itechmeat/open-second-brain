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

/**
 * Whether a value is one of the declared adequacy levels — the guard a
 * persisted verdict must clear before it is trusted, mirroring the sibling
 * `isRecallTelemetryMode`.
 */
export function isRecallAdequacyLevel(value: unknown): value is RecallAdequacyLevel {
  return RECALL_ADEQUACY_LEVELS.includes(value as RecallAdequacyLevel);
}

export const RECALL_ADEQUACY_ACTIONS = ["proceed", "re_recall", "abstain"] as const;
export type RecallAdequacyAction = (typeof RECALL_ADEQUACY_ACTIONS)[number];

export interface RecallAdequacyThresholds {
  /** Match quality at/above which recall is sufficient. */
  readonly sufficient: number;
  /** Match quality at/above which recall is at least weak (below => insufficient). */
  readonly weak: number;
  /** Minimum usable-result count below which recall cannot be sufficient. */
  readonly minResults: number;
}

/**
 * One recall attempt, as the verdict reads it.
 *
 * The level is decided by {@link matchQuality} and never by
 * {@link scores}. It used to be decided by the top score, and that could
 * not work: the keyword lane is min-max normalised inside the candidate
 * set, so the top row of any recall with a non-empty keyword lane sits at
 * or above the configured `keywordWeight` whatever it matched -
 * `DEFAULT_KEYWORD_WEIGHT`, shipped at 0.6, which is exactly
 * {@link DEFAULT_RECALL_ADEQUACY_THRESHOLDS}.sufficient, and measured at
 * 0.65 on a freshly written keyword-only vault once the additive boost
 * layers are on top. Every keyword recall in the product graded
 * `sufficient / proceed`, `weak` and `insufficient` were unreachable, and
 * a hundredth of a point on either constant would have inverted the
 * verdict for every query at once.
 *
 * `scores` is still read, for the two things it can honestly answer: how
 * many usable results there were, and what their spread was.
 */
export interface RecallAdequacyInput {
  /**
   * Absolute match quality in `[0,1]` - the share of the query's IDF mass
   * the retrieved material covers (`SearchOutcome.idfWeightedCoverage`).
   *
   * Absolute in the sense that separates it from a score: it does not
   * depend on rank position, lane magnitude or fusion mode, so two
   * retrievals for one query are comparable. It is NOT independent of
   * which rows were delivered - see that field's docblock, which used to
   * claim it was.
   *
   * A `number`, never null, and this is a boundary rather than an
   * oversight: the producer reports `null` for a query it could not
   * weigh, and the surfaces that reach this function take the value from
   * a CALLER (`match_quality`, `src/mcp/coerce.ts`), which supplies a
   * measured number or omits the pair entirely and gets no verdict. A
   * caller holding an unmeasurable quality must omit it; forwarding a
   * substitute number is the exact move this release removed.
   */
  readonly matchQuality: number;
  /** Per-result relevance scores: the count and the mean, never the level. */
  readonly scores: ReadonlyArray<number>;
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
  /**
   * Highest usable score, or 0 when there are no usable results.
   * Descriptive: it reports where the top row sat in its own pool and
   * decides nothing.
   */
  readonly topScore: number;
  /** Mean of usable scores, or 0 when there are no usable results. */
  readonly meanScore: number;
  /** The quantity the level was decided by; see {@link RecallAdequacyInput}. */
  readonly matchQuality: number;
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
 * Reject a match quality that cannot be compared against the thresholds.
 *
 * An out-of-range or non-finite quality is a caller defect, not a weak
 * recall: clamping it would produce a confident `insufficient` from a
 * broken measurement, which is indistinguishable from a genuine one.
 */
function requireMatchQuality(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`recall adequacy: matchQuality must be in [0,1]; got ${value}`);
  }
  return value;
}

/**
 * Classify recall fitness from the match quality of a recall attempt and
 * name the explicit action.
 *
 * The level comes from {@link RecallAdequacyInput.matchQuality} alone. The
 * scores decide only how many usable results there were - which is what
 * `minResults` gates - and what their spread was. Non-finite scores are
 * dropped; negative scores clamp to 0 (search scores are normalized to
 * [0,1]).
 */
export function assessRecallAdequacy(
  input: RecallAdequacyInput,
  overrides?: Partial<RecallAdequacyThresholds>,
): RecallAdequacyVerdict {
  const thresholds = resolveThresholds(overrides);
  const matchQuality = requireMatchQuality(input.matchQuality);
  const usable = input.scores.filter((s) => Number.isFinite(s)).map((s) => Math.max(0, s));
  const resultCount = usable.length;

  if (resultCount === 0) {
    return finalize("insufficient", {
      resultCount: 0,
      topScore: 0,
      meanScore: 0,
      matchQuality,
      reason: "no recall results — insufficient grounding",
    });
  }

  const parts = {
    resultCount,
    topScore: Math.max(...usable),
    meanScore: usable.reduce((a, b) => a + b, 0) / resultCount,
    matchQuality,
  };

  if (matchQuality >= thresholds.sufficient) {
    if (resultCount >= thresholds.minResults) {
      return finalize("sufficient", {
        ...parts,
        reason: `match quality ${round4(matchQuality)} >= sufficient ${thresholds.sufficient} across ${resultCount} result(s) — sufficient grounding`,
      });
    }
    // Strong coverage from too few corroborating results: re-recall to
    // broaden before answering rather than proceed on a lone signal.
    return finalize("weak", {
      ...parts,
      reason: `strong match quality ${round4(matchQuality)} but only ${resultCount} result(s) < min_results ${thresholds.minResults} — re-recall to broaden`,
    });
  }

  if (matchQuality >= thresholds.weak) {
    return finalize("weak", {
      ...parts,
      reason: `match quality ${round4(matchQuality)} in [${thresholds.weak}, ${thresholds.sufficient}) — weak grounding, re-recall via alternate strategy`,
    });
  }

  return finalize("insufficient", {
    ...parts,
    reason: `match quality ${round4(matchQuality)} < weak ${thresholds.weak} — insufficient grounding, abstain`,
  });
}

function finalize(
  level: RecallAdequacyLevel,
  parts: {
    readonly resultCount: number;
    readonly topScore: number;
    readonly meanScore: number;
    readonly matchQuality: number;
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
    matchQuality: round4(parts.matchQuality),
    reason: parts.reason,
  });
}
