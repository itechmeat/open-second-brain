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
 *   - candidates that were not sent (private, unresolvable or unreadable
 *     page, part of a private region, or dropped to fit the budget) and
 *     candidates whose relevance answer is invalid keep their exact
 *     heuristic index in the head;
 *   - every other candidate fills the remaining head slots by relevance
 *     (ties by heuristic index);
 *   - a candidate whose injection probability reaches the threshold is
 *     tagged `decision_model_injection_suspected`, whether or not its
 *     relevance answer is valid. The tag is advisory and never moves the
 *     candidate: notes that discuss prompt injection are flagged as often
 *     as real decoys, and real decoys already get a low relevance;
 *   - the tail below the head is untouched, and nothing is added or
 *     removed.
 *
 * Any failure returns the heuristic order unchanged and is recorded in the
 * `decision_model_call` record only: no warning is added to the search
 * output, so a failed decision looks exactly like no decision. The caller
 * is told through `onFallback`, so a fallback order is never cached as the
 * enforced one.
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

import type { BrainSearchResult } from "../search-result.ts";
import type { ResolvedRerankConfig } from "../types.ts";
import type { RerankProvider } from "./contract.ts";

/** Stands in for a private or unresolvable page in accounting records. */
const WITHHELD_PATH = "(withheld)";

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
  /** Candidates withheld by the privacy rules. */
  readonly withheld: number;
  /** Candidates dropped to fit `max_state_tokens`. */
  readonly dropped: number;
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
  /**
   * The `<private>` regions of each document's page, aligned with
   * `documents`; null where the page could not be read.
   */
  readonly privateRegions: ReadonlyArray<ReadonlyArray<string> | null>;
  /** Vault paths per document, for the accounting record only. */
  readonly paths: ReadonlyArray<string>;
  readonly provider?: DecisionProvider;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** The eval gate measures `enforce` whatever the configured mode. */
  readonly modeOverride?: Exclude<DecisionModelMode, "off">;
  readonly minScore?: number;
}

/**
 * Reorder a head given per-candidate relevance answers. Returns head
 * indexes in their new order. Pure, so the record can carry the order
 * `enforce` would produce while `shadow` returns the heuristic one. The
 * injection answer never moves a candidate; it only tags it.
 */
export function decisionRerankOrder(
  relevance: ReadonlyArray<number | null>,
  minScore: number,
): number[] {
  const n = relevance.length;
  const movable: number[] = [];
  for (let i = 0; i < n; i++) if (relevance[i] !== null) movable.push(i);
  const byScore = (a: number, b: number): number => relevance[b]! - relevance[a]! || a - b;
  const qualifying = movable.filter((i) => relevance[i]! >= minScore).toSorted(byScore);
  const belowFloor = movable.filter((i) => relevance[i]! < minScore);
  const ordered = [...qualifying, ...belowFloor];
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
   * a degrade so the caller falls back to the heuristic order. When the
   * feature is not active nothing is sent and `lastAnswers` stays null.
   */
  async rerank(query: string, documents: ReadonlyArray<string>): Promise<number[]> {
    this.lastAnswers = null;
    const n = documents.length;
    const withAnswerable = decisionModelModeFor(this.cfg, "answerable") !== "off";
    const minScore = this.opts.minScore ?? 0;
    const recordedMode = this.opts.modeOverride ?? decisionModelModeFor(this.cfg, "rerank");
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
            privateRegions: this.opts.privateRegions[i] ?? null,
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
          context: {
            included: built.included,
            withheld: built.withheld.length,
            dropped: built.dropped.length,
          },
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
          const details: Record<string, unknown> = { head_size: n };
          if (response === null || context === null) return details;
          const { relevance, injection } = relevanceFor(response, context);
          const order = decisionRerankOrder(relevance, minScore);
          if (recordedMode === "shadow") {
            // Shadow records feed the agreement report, which compares
            // paths. A page that may not leave the machine is not named
            // in the record either: continuity records sync and can be
            // read raw.
            const heuristic = this.opts.paths
              .slice(0, n)
              .map((path, i) =>
                mayLeaveMachine(this.opts.visibility[i] ?? null) ? path : WITHHELD_PATH,
              );
            details["heuristic_order"] = heuristic;
            details["decision_order"] = order.map((i) => heuristic[i] ?? "");
          } else {
            // Enforce: which heuristic position ended where, no paths.
            details["decision_permutation"] = order;
          }
          details["withheld_count"] = context.withheld;
          details["budget_dropped_count"] = context.dropped;
          details["injection_suspected"] = injection.filter(
            (p) => p !== null && p >= RERANK_QUESTIONS.injectionFlagMin,
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
      // Not active (e.g. the vault opted out): no request and no record.
      return Array.from({ length: n }, () => Number.NaN);
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
  /**
   * The `<private>` regions of a result's page (tags included), or null
   * when the page cannot be read. No resolver means nothing is sent.
   */
  readonly resolvePrivateRegions?: (path: string) => ReadonlyArray<string> | null;
  /** Receives the extra answers (e.g. `answerable`) when a reply arrived. */
  readonly onExtras?: (extras: DecisionRerankExtras) => void;
  /**
   * Called when the configured order could not be produced: the request
   * degraded, or the feature is not active. The returned order is then the
   * heuristic one, which must not be cached as the enforced result.
   */
  readonly onFallback?: () => void;
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
  // Regions are read only for pages that may leave at all.
  const privateRegions = head.map((r, i) =>
    mayLeaveMachine(visibility[i] ?? null) ? (opts.resolvePrivateRegions?.(r.path) ?? null) : null,
  );
  const provider = new DecisionModelRerankProvider(cfg, {
    visibility,
    privateRegions,
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
    opts.onFallback?.();
    return results;
  }
  const answers = provider.lastAnswers;
  if (answers === null) {
    opts.onFallback?.();
    return results;
  }
  if (answers.extras.answerable !== undefined) opts.onExtras?.(answers.extras);
  if (answers.mode !== "enforce") return results;
  const suspected = (i: number): boolean => {
    const inj = answers.injection[i];
    return inj !== null && inj !== undefined && inj >= RERANK_QUESTIONS.injectionFlagMin;
  };
  if (answers.relevance.every((p) => p === null) && !head.some((_, i) => suspected(i))) {
    return results;
  }

  const order = decisionRerankOrder(answers.relevance, config.minScore);
  const reordered = order.map((i) => {
    const result = head[i]!;
    const rel = answers.relevance[i];
    const reasons = [...result.reasons];
    if (rel !== null && rel !== undefined) {
      reasons.push(`decision_model: ${formatProbability(rel)}`);
    }
    if (suspected(i)) reasons.push("decision_model_injection_suspected");
    if (reasons.length === result.reasons.length) return result;
    return Object.freeze({ ...result, reasons: Object.freeze(reasons) });
  });
  return [...reordered, ...tail];
}
