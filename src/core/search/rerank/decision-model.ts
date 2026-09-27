/**
 * Rerank kind `decision-model` (issue #213, Part 2).
 *
 * One decision request per rerank: the state is the query plus the top-K
 * candidates masked as `P0..Pn`, and the questions are one relevance
 * `noul` per candidate (`rel_<k>`), one injection `noul` per candidate
 * (`inj_<k>`, the passage carries instructions addressed to an AI
 * assistant) and, only while the `answerable` use is not `off`, one
 * `answerable` noul over all passages. Question texts and thresholds live
 * in `decision-model/questions.ts`.
 *
 * Modes come from `decision_model_uses` `rerank`:
 *   - `off`, or any configuration that is not active: the stage is
 *     disabled at config resolution, byte-identical to rerank off;
 *   - `shadow`: the request is sent and recorded, the heuristic order is
 *     returned unchanged;
 *   - `enforce`: the head is reordered by relevance probability.
 *
 * Invariants of the enforced order:
 *   - candidates that were not sent (private or unresolvable visibility,
 *     or dropped to fit the budget) and candidates whose answer is invalid
 *     keep their exact heuristic index in the head;
 *   - every other candidate fills the remaining head slots by relevance
 *     (ties by heuristic index), and a candidate whose injection
 *     probability reaches the threshold is moved to the end of those slots
 *     and tagged `decision_model_injection_suspected`;
 *   - the tail below the head is untouched, and nothing is added or
 *     removed.
 *
 * Any failure returns the heuristic order unchanged and is recorded in the
 * `decision_model_call` record only: no warning is added to the search
 * output, so a failed decision looks exactly like no decision.
 */

import { DecisionProviderError, type DecisionResponse } from "../../decision-model/contract.ts";
import {
  decisionModelModeFor,
  type ResolvedDecisionModelConfig,
} from "../../decision-model/config.ts";
import type { DecisionModelMode, DecisionProvider } from "../../decision-model/contract.ts";
import { RERANK_QUESTIONS } from "../../decision-model/questions.ts";
import { runDecision } from "../../decision-model/run.ts";
import { buildCandidateState, mayLeaveMachine } from "../../decision-model/state.ts";

/** Stands in for a private or unresolvable page in accounting records. */
const WITHHELD_PATH = "(withheld)";
import type { BrainSearchResult } from "../search-result.ts";
import type { ResolvedRerankConfig } from "../types.ts";
import type { RerankProvider } from "./contract.ts";

/** The extra answers one rerank request carries beside relevance. */
export interface DecisionRerankExtras {
  readonly answerable?: {
    readonly probability: number;
    readonly model: string;
    readonly calibrated: boolean;
  };
}

interface RerankContext {
  /** `included[k]` is the head index of mask `P<k>`. */
  readonly included: ReadonlyArray<number>;
}

interface RerankAnswers {
  readonly mode: Exclude<DecisionModelMode, "off">;
  /** Relevance per head index; null when not sent or invalid. */
  readonly relevance: ReadonlyArray<number | null>;
  /** Injection probability per head index; null when not sent or invalid. */
  readonly injection: ReadonlyArray<number | null>;
  readonly extras: DecisionRerankExtras;
}

export interface DecisionModelRerankProviderOptions {
  /** Visibility tokens per document, aligned with `rerank`'s `documents`. */
  readonly visibility: ReadonlyArray<ReadonlyArray<string> | null>;
  /** Vault paths per document, for the accounting record only. */
  readonly paths: ReadonlyArray<string>;
  readonly provider?: DecisionProvider;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** The eval gate measures `enforce` whatever the configured mode. */
  readonly modeOverride?: Exclude<DecisionModelMode, "off">;
  readonly minScore?: number;
}

/**
 * Reorder a head given per-candidate relevance and injection answers.
 * Returns head indexes in their new order. Pure, so the record can carry
 * the order `enforce` would produce while `shadow` returns the heuristic
 * one.
 */
export function decisionRerankOrder(
  relevance: ReadonlyArray<number | null>,
  injection: ReadonlyArray<number | null>,
  minScore: number,
): number[] {
  const n = relevance.length;
  const movable: number[] = [];
  for (let i = 0; i < n; i++) if (relevance[i] !== null) movable.push(i);
  const suspect = (i: number): boolean =>
    (injection[i] ?? 0) >= RERANK_QUESTIONS.injectionDemoteMin;
  const byScore = (a: number, b: number): number => relevance[b]! - relevance[a]! || a - b;
  const clean = movable.filter((i) => !suspect(i));
  const qualifying = clean.filter((i) => relevance[i]! >= minScore).toSorted(byScore);
  const belowFloor = clean.filter((i) => relevance[i]! < minScore);
  const suspects = movable.filter(suspect).toSorted(byScore);
  const ordered = [...qualifying, ...belowFloor, ...suspects];
  const out: number[] = Array.from({ length: n }, (_, i) => i);
  movable.forEach((slot, k) => {
    out[slot] = ordered[k]!;
  });
  return out;
}

/**
 * A `RerankProvider` over the decision model. One instance serves one
 * rerank: it is built with the head's visibility and paths, because the
 * privacy filter needs to know which documents may leave the machine.
 */
export class DecisionModelRerankProvider implements RerankProvider {
  readonly name = "decision-model";
  readonly model: string;
  /** The answers of the last successful `rerank` call. */
  lastAnswers: RerankAnswers | null = null;
  private readonly cfg: ResolvedDecisionModelConfig;
  private readonly opts: DecisionModelRerankProviderOptions;

  constructor(cfg: ResolvedDecisionModelConfig, opts: DecisionModelRerankProviderOptions) {
    this.cfg = cfg;
    this.opts = opts;
    this.model = cfg.model ?? "";
  }

  /**
   * Relevance probability per document (NaN where no valid answer exists:
   * not sent, dropped or invalid). Throws {@link DecisionProviderError} on
   * a degrade so the caller falls back to the heuristic order.
   */
  async rerank(query: string, documents: ReadonlyArray<string>): Promise<number[]> {
    this.lastAnswers = null;
    const n = documents.length;
    const withAnswerable = decisionModelModeFor(this.cfg, "answerable") !== "off";
    const minScore = this.opts.minScore ?? 0;
    const relevanceFor = (
      response: DecisionResponse,
      context: RerankContext,
    ): { relevance: (number | null)[]; injection: (number | null)[] } => {
      const relevance: (number | null)[] = Array.from({ length: n }, () => null);
      const injection: (number | null)[] = Array.from({ length: n }, () => null);
      context.included.forEach((headIndex, k) => {
        const rel = response.answers[RERANK_QUESTIONS.relevanceId(k)];
        if (rel?.valid === true && typeof rel.value === "number") relevance[headIndex] = rel.value;
        const inj = response.answers[RERANK_QUESTIONS.injectionId(k)];
        if (inj?.valid === true && typeof inj.value === "number") injection[headIndex] = inj.value;
      });
      return { relevance, injection };
    };

    const result = await runDecision<RerankContext>(
      "rerank",
      () => {
        const built = buildCandidateState({
          candidates: documents.map((text, i) => ({
            text,
            visibility: this.opts.visibility[i] ?? null,
          })),
          prefix: RERANK_QUESTIONS.prefix,
          clipChars: RERANK_QUESTIONS.clipChars,
          maxStateTokens: this.cfg.maxStateTokens,
          frame: (texts) => ({ query, passages: texts }),
        });
        if (built.kind !== "ok") return built;
        return {
          kind: "ok",
          state: built.state,
          candidateCount: built.included.length,
          context: { included: built.included },
        };
      },
      (built) => {
        const questions: Record<string, ReturnType<typeof RERANK_QUESTIONS.relevance>> = {};
        for (let k = 0; k < built.context.included.length; k++) {
          questions[RERANK_QUESTIONS.relevanceId(k)] = RERANK_QUESTIONS.relevance(k);
          questions[RERANK_QUESTIONS.injectionId(k)] = RERANK_QUESTIONS.injection(k);
        }
        if (withAnswerable)
          questions[RERANK_QUESTIONS.answerableId] = RERANK_QUESTIONS.answerable();
        return questions;
      },
      {
        config: this.cfg,
        ...(this.opts.provider !== undefined ? { provider: this.opts.provider } : {}),
        ...(this.opts.env !== undefined ? { env: this.opts.env } : {}),
        ...(this.opts.modeOverride !== undefined ? { modeOverride: this.opts.modeOverride } : {}),
        recordDetails: (response, context) => {
          // A page that may not leave the machine is not named in the
          // record either: continuity records sync and can be read raw.
          const heuristic = this.opts.paths
            .slice(0, n)
            .map((path, i) =>
              mayLeaveMachine(this.opts.visibility[i] ?? null) ? path : WITHHELD_PATH,
            );
          const details: Record<string, unknown> = { heuristic_order: heuristic };
          if (response === null || context === null) return details;
          const { relevance, injection } = relevanceFor(response, context);
          details["decision_order"] = decisionRerankOrder(relevance, injection, minScore).map(
            (i) => heuristic[i] ?? "",
          );
          details["withheld_count"] = n - context.included.length;
          details["injection_suspected"] = injection.filter(
            (p) => p !== null && p >= RERANK_QUESTIONS.injectionDemoteMin,
          ).length;
          const ans = response.answers[RERANK_QUESTIONS.answerableId];
          if (ans?.valid === true && typeof ans.value === "number") {
            details["answerable_probability"] = ans.value;
          }
          return details;
        },
      },
    );

    if (result.status === "off") {
      throw new DecisionProviderError("no_key", "decision model is not active");
    }
    if (result.status === "degraded") {
      throw new DecisionProviderError(result.reason, `decision rerank degraded: ${result.reason}`);
    }
    if (result.status === "empty") {
      // Nothing could be sent (every candidate private or unresolvable):
      // every position is pinned, so the order is unchanged.
      this.lastAnswers = {
        mode: result.mode,
        relevance: Array.from({ length: n }, () => null),
        injection: Array.from({ length: n }, () => null),
        extras: {},
      };
      return Array.from({ length: n }, () => Number.NaN);
    }
    const { relevance, injection } = relevanceFor(result.response, result.context);
    const ans = result.response.answers[RERANK_QUESTIONS.answerableId];
    const extras: DecisionRerankExtras =
      ans?.valid === true && typeof ans.value === "number"
        ? {
            answerable: {
              probability: ans.value,
              model: result.response.model,
              calibrated: result.response.calibrated,
            },
          }
        : {};
    this.lastAnswers = { mode: result.mode, relevance, injection, extras };
    return relevance.map((p) => (p === null ? Number.NaN : p));
  }
}

export interface ApplyDecisionModelRerankOptions {
  /** Visibility tokens for a result path, or null when unresolvable. */
  readonly resolveVisibility?: (path: string) => ReadonlyArray<string> | null;
  readonly provider?: DecisionProvider;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly modeOverride?: Exclude<DecisionModelMode, "off">;
  /** Receives the extra answers (e.g. `answerable`) when a reply arrived. */
  readonly onExtras?: (extras: DecisionRerankExtras) => void;
}

function formatProbability(p: number): string {
  return p.toFixed(4);
}

/**
 * The decision-model branch of the rerank stage. Returns the input
 * unchanged on shadow, on any degrade, and when nothing could be sent.
 */
export async function applyDecisionModelRerank(
  results: ReadonlyArray<BrainSearchResult>,
  query: string,
  config: ResolvedRerankConfig,
  opts: ApplyDecisionModelRerankOptions = {},
): Promise<ReadonlyArray<BrainSearchResult>> {
  const cfg = config.decisionModel;
  if (cfg === undefined || results.length === 0) return results;
  const topK = Math.min(Math.max(1, config.topK), results.length);
  const head = results.slice(0, topK);
  const tail = results.slice(topK);
  // No resolver means no way to prove a page may leave: send nothing.
  const visibility = head.map((r) => opts.resolveVisibility?.(r.path) ?? null);
  const provider = new DecisionModelRerankProvider(cfg, {
    visibility,
    paths: head.map((r) => r.path),
    minScore: config.minScore,
    ...(opts.provider !== undefined ? { provider: opts.provider } : {}),
    ...(opts.env !== undefined ? { env: opts.env } : {}),
    ...(opts.modeOverride !== undefined ? { modeOverride: opts.modeOverride } : {}),
  });
  try {
    await provider.rerank(
      query,
      head.map((r) => r.content),
    );
  } catch {
    return results;
  }
  const answers = provider.lastAnswers;
  if (answers === null) return results;
  if (answers.extras.answerable !== undefined) opts.onExtras?.(answers.extras);
  if (answers.mode !== "enforce") return results;
  if (answers.relevance.every((p) => p === null)) return results;

  const order = decisionRerankOrder(answers.relevance, answers.injection, config.minScore);
  const reordered = order.map((i) => {
    const result = head[i]!;
    const rel = answers.relevance[i];
    if (rel === null || rel === undefined) return result;
    const inj = answers.injection[i];
    const reasons = [...result.reasons, `decision_model: ${formatProbability(rel)}`];
    if (inj !== null && inj !== undefined && inj >= RERANK_QUESTIONS.injectionDemoteMin) {
      reasons.push("decision_model_injection_suspected");
    }
    return Object.freeze({ ...result, reasons: Object.freeze(reasons) });
  });
  return [...reordered, ...tail];
}
