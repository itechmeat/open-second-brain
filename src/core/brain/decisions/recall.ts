/**
 * Rated-decision recall wiring (Belief lifecycle suite, B5, t_5712fa39).
 *
 * The injection-side orchestrator that ties the deterministic prompt
 * matcher and per-session governor (`inject-governor.ts`) to the rated
 * decision store (`record.ts`) and the config keys (`config.ts`): given a
 * prompt, the current turn, and the caller-owned session state, it
 * resurfaces at most one rated decision verbatim, subject to the
 * per-session cap and spacing.
 *
 * Unconfigured behaviour is byte-identical: when
 * `decision_recall.max_per_session` is unset the resolver returns `null`,
 * the governor disables recall, and this returns `enabled: false` with an
 * empty surface and an unchanged state.
 *
 * Deterministic and language-agnostic end to end: no LLM, no
 * language-specific word lists - matching is structural token overlap.
 */

import {
  resolveDecisionRecallMaxPerSession,
  resolveDecisionRecallMinSpacingTurns,
} from "../../config.ts";
import {
  EMPTY_DECISION_RECALL_STATE,
  governDecisionRecall,
  matchRatedDecisions,
  type DecisionRecallState,
  type RatedDecisionCandidate,
} from "../inject-governor.ts";
import { listRatedDecisions, type DecisionRecord } from "./record.ts";

export interface RecallRatedDecisionsInput {
  /** The incoming user prompt to match against rated decisions. */
  readonly prompt: string;
  /** Monotonic current turn index (for spacing). Defaults to 0. */
  readonly turn?: number;
  /** Caller-owned session state; defaults to the empty state. */
  readonly state?: DecisionRecallState;
  readonly configPath?: string;
  /** Optional override of the match threshold (else the governor default). */
  readonly minOverlap?: number;
}

export interface RecallRatedDecisionsResult {
  /** False when recall is unconfigured (byte-identical, nothing surfaced). */
  readonly enabled: boolean;
  /** The decision resurfaced this turn (verbatim), or `null` when gated. */
  readonly surfaced: DecisionRecord | null;
  /** Verbatim injection text for the surfaced decision, or "" when none. */
  readonly text: string;
  /** Next session state (advanced only when a decision was surfaced). */
  readonly state: DecisionRecallState;
}

/** Structural match text for a decision: title + chosen + rationale. */
function candidateText(d: DecisionRecord): string {
  return [d.title, d.chosen, d.rationale].filter((s) => s.length > 0).join(" ");
}

/** Verbatim recall block rendered for injection. */
function renderVerbatim(d: DecisionRecord): string {
  const lines = [
    `Recalled decision \`${d.id}\` (rating ${d.rating ?? "n/a"}): ${d.title}`,
    `chose: ${d.chosen}`,
  ];
  if (d.rationale) lines.push(`rationale: ${d.rationale}`);
  if (d.outcome) lines.push(`outcome: ${d.outcome}`);
  return lines.join("\n");
}

/**
 * Resurface at most one rated decision matching the prompt, governed by
 * the per-session cap and spacing. Read-only on the decision store.
 */
export function recallRatedDecisions(
  vault: string,
  input: RecallRatedDecisionsInput,
): RecallRatedDecisionsResult {
  const state = input.state ?? EMPTY_DECISION_RECALL_STATE;
  const maxPerSession = resolveDecisionRecallMaxPerSession(input.configPath);
  const enabled = maxPerSession !== null;
  if (!enabled) {
    return { enabled: false, surfaced: null, text: "", state };
  }
  const minSpacingTurns = resolveDecisionRecallMinSpacingTurns(input.configPath) ?? 0;
  const turn = input.turn ?? 0;

  const rated = listRatedDecisions(vault);
  const candidates: RatedDecisionCandidate[] = rated.map((d) => ({
    id: d.id,
    rating: d.rating ?? 0,
    text: candidateText(d),
  }));
  const matches = matchRatedDecisions(
    input.prompt,
    candidates,
    input.minOverlap !== undefined ? { minOverlap: input.minOverlap } : {},
  );
  const governed = governDecisionRecall({
    matches,
    state,
    turn,
    config: { maxPerSession, minSpacingTurns },
  });
  if (governed.surface === null) {
    return { enabled: true, surfaced: null, text: "", state: governed.state };
  }
  const surfaced = rated.find((d) => d.id === governed.surface!.id) ?? null;
  return {
    enabled: true,
    surfaced,
    text: surfaced ? renderVerbatim(surfaced) : "",
    state: governed.state,
  };
}
