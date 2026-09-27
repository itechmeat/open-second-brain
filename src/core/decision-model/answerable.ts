/**
 * Advisory `answerable` signal (issue #213, Part 8).
 *
 * The decision-model rerank request already asks, while the `answerable`
 * use is not `off`, whether the passages together contain enough to
 * answer the query. There is no extra request: search surfaces that
 * probability as `decision_model.answerable`, and a caller may hand it to
 * `brain_recall_gate` or `brain_context_pack` as `decision_answerable`
 * next to the scores it already passes.
 *
 * The signal is advisory only. The deterministic recall-adequacy `level`
 * and `action` never change in either mode (`enforce` only means the field
 * is surfaced); the gate adds `disagrees` when the level is `sufficient`
 * and the probability is below `ANSWERABLE_LOW`, or the level is
 * `insufficient` and the probability is above `ANSWERABLE_HIGH`.
 *
 * With the use `off` (or another rerank kind, or no decision config) no
 * question is asked and search carries no field; a `decision_answerable`
 * a caller passes anyway is ignored with one warning, since the caller
 * asked for it explicitly.
 */

import type { RecallAdequacyLevel } from "../brain/recall-adequacy.ts";
import { decisionModelModeFor } from "./config.ts";
import type { ResolvedDecisionModelConfig } from "./config-types.ts";
import type { DecisionAnswerableSignal, DecisionModelMode } from "./contract.ts";
import { ANSWERABLE_HIGH, ANSWERABLE_LOW } from "./questions.ts";

/** The warning a gate returns when `decision_answerable` arrives while the use is off. */
export const DECISION_ANSWERABLE_OFF_WARNING =
  "decision_answerable_ignored: the decision-model answerable use is off";

/** The advisory field a gate verdict gains. */
export interface DecisionAnswerableVerdict {
  readonly probability: number;
  readonly disagrees: boolean;
}

/** Which band a probability falls in; both edges belong to `mid`. */
export type AnswerableBand = "low" | "mid" | "high";

export function answerableBand(probability: number): AnswerableBand {
  if (probability < ANSWERABLE_LOW) return "low";
  if (probability > ANSWERABLE_HIGH) return "high";
  return "mid";
}

/**
 * Whether the advisory probability disagrees with a deterministic level:
 * `sufficient` with a low probability, or `insufficient` with a high one.
 * `weak` never disagrees; it already asks for another recall.
 */
export function assessDecisionAnswerable(
  level: RecallAdequacyLevel,
  probability: number,
): DecisionAnswerableVerdict {
  const band = answerableBand(probability);
  const disagrees =
    (level === "sufficient" && band === "low") || (level === "insufficient" && band === "high");
  return Object.freeze({ probability, disagrees });
}

/** The rerank settings the answerable mode depends on. */
export interface AnswerableRerankSettings {
  readonly enabled: boolean;
  readonly kind: string;
  readonly decisionModel?: ResolvedDecisionModelConfig;
}

/**
 * The effective `answerable` mode: `off` unless rerank kind
 * `decision-model` is on (which already requires an active decision
 * config and a rerank use that is not off) and the `answerable` use is
 * `shadow` or `enforce`. Only then can a search have produced the signal.
 */
export function answerableModeFor(
  rerank: AnswerableRerankSettings | null | undefined,
): DecisionModelMode {
  if (rerank === null || rerank === undefined) return "off";
  if (!rerank.enabled || rerank.kind !== "decision-model") return "off";
  return decisionModelModeFor(rerank.decisionModel, "answerable");
}

/**
 * The `decision_model` envelope `brain_search` and `o2b search query
 * --json` add to their payload. Empty (nothing added) unless the outcome
 * carries an answerable signal.
 */
export function decisionModelSearchEnvelope(outcome: {
  readonly decisionModel?: { readonly answerable: DecisionAnswerableSignal };
}): { decision_model?: { answerable: DecisionAnswerableSignal } } {
  const answerable = outcome.decisionModel?.answerable;
  if (answerable === undefined) return {};
  return {
    decision_model: {
      answerable: {
        probability: answerable.probability,
        model: answerable.model,
        calibrated: answerable.calibrated,
      },
    },
  };
}
