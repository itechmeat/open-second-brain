/**
 * The `neighbour_relevant` decision use (task 4.3, design D10): one
 * `noul` question per candidate, the state `{ prompt, records }` with
 * the prompt's `<private>` regions stripped and cut to 2000 characters
 * and each record's text cut to 300. Candidates at or above
 * `inject_min` are injected; candidates judged below it are not, the
 * deterministic ones included. A candidate the model did not judge
 * (withheld, cut to fit the state budget, an invalid answer) keeps the
 * deterministic gate. No store record: recorded in
 * `decision_model_call` only.
 *
 * Budget: `min(cfg.hookBudgetMs, remaining hook budget)`, enforced again
 * around the call, as `recall-inject-decision.ts` does.
 */

import { decisionModelModeFor } from "../decision-model/config.ts";
import type { ResolvedDecisionModelConfig } from "../decision-model/config-types.ts";
import type { DecisionNoulQuestion, DecisionProvider } from "../decision-model/contract.ts";
import {
  NEIGHBOUR_RELEVANT_QUESTIONS,
  TOPIC_DECISION_LIMITS,
} from "../decision-model/questions-topics.ts";
import { mayStartRequest } from "../decision-model/request-floor.ts";
import { runDecision } from "../decision-model/run.ts";
import { appliedThreshold } from "../decision-model/use-thresholds.ts";
import { buildCandidateState, clip, type StateCandidate } from "../decision-model/state.ts";
import { REMOTE_DENY_VISIBILITY_TOKEN } from "../graph/visibility.ts";
import { privateRegionTexts, stripPrivateRegions } from "../redactor.ts";
import type { NeighbourCandidate } from "./neighbours.ts";
import { mayShareRecord } from "../decision-model/egress-guard.ts";

/** A candidate the use judged. */
export interface NeighbourRelevantOutcome {
  /** Whether `enforce` applied: the caller injects only these. */
  readonly applied: boolean;
  /** The candidate record ids that passed `inject_min` (enforce). */
  readonly relevant: ReadonlySet<string>;
  /**
   * The candidate record ids the model gave a valid answer for. One it
   * did not judge (withheld as private, cut to fit the state budget, an
   * invalid answer) keeps the deterministic gate, as `head_select` keeps
   * an unjudged head in its fallback place.
   */
  readonly judged: ReadonlySet<string>;
}

/**
 * Ask the model which neighbour records matter for this prompt. The
 * fallback (off, shadow, timeout, invalid) keeps the deterministic gate.
 */
export async function runNeighbourRelevant(input: {
  readonly config: ResolvedDecisionModelConfig | null | undefined;
  readonly candidates: ReadonlyArray<NeighbourCandidate>;
  readonly prompt: string;
  readonly remainingMs: number;
  readonly provider?: DecisionProvider;
  readonly env?: Readonly<Record<string, string | undefined>>;
}): Promise<NeighbourRelevantOutcome> {
  const use = "neighbour_relevant" as const;
  const cfg = input.config;
  const fallback: NeighbourRelevantOutcome = {
    applied: false,
    relevant: new Set(),
    judged: new Set(),
  };
  const mode = decisionModelModeFor(cfg, use);
  if (mode === "off" || cfg === null || cfg === undefined) return fallback;
  const budgetMs = Math.max(0, Math.min(cfg.hookBudgetMs, input.remainingMs));
  // No request starts with less than the minimum request time left.
  if (budgetMs <= 0 || !mayStartRequest(0, input.remainingMs, cfg.hookBudgetMs)) return fallback;
  const candidates = input.candidates.slice(0, TOPIC_DECISION_LIMITS.neighbourCandidatesPerTurn);
  if (candidates.length === 0) return fallback;
  const prompt = clip(
    stripPrivateRegions(input.prompt),
    NEIGHBOUR_RELEVANT_QUESTIONS.promptClipChars,
  );
  const request = runDecision<{ map: Map<number, NeighbourCandidate> }>(
    use,
    () => {
      const built = buildCandidateState({
        candidates: candidates.map((candidate): StateCandidate => {
          const text = candidate.text ?? candidate.kind;
          // The title rides beside the text: blank when its winning
          // record is private and may not leave; `<private>` regions are
          // stripped from every field by the state builder.
          const title = mayShareRecord(cfg, use, candidate.titlePrivate)
            ? candidate.topicTitle
            : "";
          return {
            text,
            visibility: mayShareRecord(cfg, use, candidate.private)
              ? []
              : [REMOTE_DENY_VISIBILITY_TOKEN],
            privateRegions: [...privateRegionTexts(text), ...privateRegionTexts(title)],
            fields: { topic: title, kind: candidate.kind },
          };
        }),
        prefix: NEIGHBOUR_RELEVANT_QUESTIONS.recordPrefix,
        clipChars: NEIGHBOUR_RELEVANT_QUESTIONS.recordClipChars,
        maxStateTokens: cfg.maxStateTokens,
        frame: (records) => ({ prompt, records }),
      });
      if (built.kind !== "ok") return { kind: "empty" as const };
      const context = { map: new Map<number, NeighbourCandidate>() };
      built.included.forEach((candidateIndex, k) =>
        context.map.set(k, candidates[candidateIndex]!),
      );
      return {
        kind: "ok" as const,
        state: built.state,
        candidateCount: built.included.length,
        context,
      };
    },
    (built): Record<string, DecisionNoulQuestion> => {
      const questions: Record<string, DecisionNoulQuestion> = {};
      for (let k = 0; k < built.candidateCount; k++) {
        questions[NEIGHBOUR_RELEVANT_QUESTIONS.mattersId(k)] =
          NEIGHBOUR_RELEVANT_QUESTIONS.matters(k);
      }
      return questions;
    },
    {
      config: cfg,
      timeoutMs: budgetMs,
      // The floor holds for each attempt of the chain, not only here.
      requestFloor: true,
      ...(input.provider !== undefined ? { provider: input.provider } : {}),
      ...(input.env !== undefined ? { env: input.env } : {}),
      recordDetails: (response, context) => {
        // One entry per candidate, a private one written as withheld;
        // the probabilities line up with it (null where not asked).
        const details: Record<string, unknown> = {
          record_ids: candidates.map((c) =>
            mayShareRecord(cfg, use, c.private) ? c.record : "(withheld)",
          ),
        };
        if (response !== null && context !== null) {
          const probabilities: Array<number | null> = candidates.map(() => null);
          for (const [k, candidate] of context.map) {
            const a = response.answers[NEIGHBOUR_RELEVANT_QUESTIONS.mattersId(k)];
            probabilities[candidates.indexOf(candidate)] =
              a !== undefined && a.valid === true && typeof a.value === "number" ? a.value : null;
          }
          details["probabilities"] = probabilities;
        }
        return details;
      },
    },
  );
  // A provider that outlives its own timeout must not hold the hook.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cutoff = new Promise<"cutoff">((resolve) => {
    timer = setTimeout(() => resolve("cutoff"), budgetMs);
  });
  let result: Awaited<typeof request> | "cutoff";
  try {
    result = await Promise.race([request, cutoff]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  if (result === "cutoff") return fallback;
  if (result.status !== "ok" || result.mode !== "enforce") return fallback;
  const injectMin = appliedThreshold(cfg, use, result.answeredBy.model, "inject_min");
  const relevant = new Set<string>();
  const judged = new Set<string>();
  for (const [k, candidate] of result.context.map) {
    const a = result.response.answers[NEIGHBOUR_RELEVANT_QUESTIONS.mattersId(k)];
    const p = a !== undefined && a.valid === true && typeof a.value === "number" ? a.value : null;
    if (p === null) continue;
    judged.add(candidate.record);
    if (p >= injectMin) relevant.add(candidate.record);
  }
  return { applied: true, relevant, judged };
}
