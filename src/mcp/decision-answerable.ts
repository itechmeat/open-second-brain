/**
 * Shared handling of the optional `decision_answerable` argument of
 * `brain_recall_gate` and `brain_context_pack` (issue #213, Part 8).
 *
 * Resolved only when a caller passed the argument, so a call without it
 * reads no extra config and changes nothing.
 */

import {
  answerableModeFor,
  assessDecisionAnswerable,
  DECISION_ANSWERABLE_OFF_WARNING,
  type DecisionAnswerableVerdict,
} from "../core/decision-model/answerable.ts";
import type { RecallAdequacyLevel } from "../core/brain/recall-adequacy.ts";
import { resolveSearchConfig } from "../core/search/index.ts";
import type { ServerContext } from "./tool-contract.ts";

export type DecisionAnswerableOutcome =
  | { readonly kind: "annotated"; readonly verdict: DecisionAnswerableVerdict }
  | { readonly kind: "ignored"; readonly warning: string };

/**
 * Annotate a deterministic level with the caller's advisory probability,
 * or ignore it with a warning when the `answerable` use is off (or the
 * search config cannot be resolved, which is off too).
 */
export function decisionAnswerableFor(
  ctx: ServerContext,
  level: RecallAdequacyLevel,
  probability: number,
): DecisionAnswerableOutcome {
  let mode: ReturnType<typeof answerableModeFor> = "off";
  try {
    const config = resolveSearchConfig({
      vault: ctx.vault,
      configPath: ctx.configPath ?? undefined,
    });
    mode = answerableModeFor(config.rerank);
  } catch {
    mode = "off";
  }
  if (mode === "off") return { kind: "ignored", warning: DECISION_ANSWERABLE_OFF_WARNING };
  return { kind: "annotated", verdict: assessDecisionAnswerable(level, probability) };
}
