/**
 * Per-store reranker evaluation gate (Retrieval & Ranking Quality,
 * t_9f95ebb6).
 *
 * Before a store commits to reranking, this gate MEASURES whether the
 * reranker actually improves recall/ranking quality on that store's own
 * labelled queries. It runs the existing recall-benchmark twice - rerank
 * OFF then ON - over the same dataset and compares the metric families
 * (hit@k, MRR), pooled and per language. Reranking is recommended only
 * when it lifts ranking without regressing hit@k in the pooled numbers
 * OR in any single language (t_693fa22a review, M14), so a store where
 * the reranker helps one language and hurts another never silently
 * enables on the pooled delta.
 *
 * Reuses `runRecallBenchmark` for the metrics rather than a bespoke scorer,
 * and is deterministic and offline when the store and reranker are (the
 * bundled "local" reranker always is).
 */

import { runRecallBenchmark } from "./benchmark.ts";
import type { RecallBenchmarkDataset, RecallBenchmarkReport } from "./benchmark.ts";
import { MAINTENANCE_LANE_REACH } from "../graph/transport-reach.ts";
import type { ResolvedDecisionModelConfig } from "../decision-model/config.ts";
import { SearchError, type ResolvedRerankConfig, type ResolvedSearchConfig } from "./types.ts";

export interface RerankEvalGateOptions {
  /** Rank depth for the benchmark (defaults to the benchmark default). */
  readonly k?: number;
  /** Reranker kind to evaluate (defaults to "local", the offline reranker). */
  readonly kind?: ResolvedRerankConfig["kind"];
  /** Minimum pooled MRR lift required to recommend enabling. Default 0.01. */
  readonly minMrrDelta?: number;
  /** Minimum pooled hit@k lift that alone justifies enabling. Default 0.01. */
  readonly minHitDelta?: number;
  /**
   * The decision-model config for `kind: "decision-model"`, when the
   * search config was not resolved with that kind. Must be active; the
   * reranked arm always runs the `rerank` use in `enforce`, since a shadow
   * arm would return the heuristic order and measure nothing.
   */
  readonly decisionModel?: ResolvedDecisionModelConfig;
}

/** The rerank-arm minus baseline difference of one metric family. */
export interface RerankDelta {
  readonly hitAtK: number;
  readonly mrr: number;
}

export interface RerankEvalGateResult {
  /** Whether reranking is recommended for this store. */
  readonly improves: boolean;
  readonly recommendation: "enable" | "keep-disabled";
  readonly baseline: RecallBenchmarkReport;
  readonly reranked: RecallBenchmarkReport;
  /**
   * Rerank-arm minus baseline, combined over the whole run and (t_693fa22a
   * review, M14) per language: `byLang` carries one entry per `byLang`
   * group of the two arms, so a reranker that helps one language and hurts
   * another is visible per language instead of washing out in the pooled
   * numbers. Same keys as `baseline.byLang`, sorted.
   */
  readonly deltas: RerankEvalDeltas;
}

export interface RerankEvalDeltas {
  /** The pooled delta over every query. */
  readonly hitAtK: number;
  readonly mrr: number;
  /** The same difference folded per language group. */
  readonly byLang: Readonly<Record<string, RerankDelta>>;
}

/**
 * Slack for float noise between two folds of the same orders: identical
 * rankings fold to bit-identical fractions, and a real demotion moves a
 * fraction by far more than this, so only genuine dust lands inside it.
 */
const VERDICT_FP_NOISE = 1e-9;

/**
 * The gate's verdict rule, pure so a constructed pair of reports pins it
 * unit-wise (t_693fa22a review, M14). Enables reranking only when the
 * POOLED numbers lift - hit@k does not regress and either MRR or hit@k
 * gains at least the requested margin - AND no single language regresses
 * on either family: a reranker that helps EN and hurts ZH must not be
 * recommended on the pooled delta. The per-language check subsumes the
 * pooled hit@k floor (a pooled regression is always some language's
 * regression), and both stay so the rule reads as the contract it keeps.
 */
export function rerankEvalVerdict(
  baseline: RecallBenchmarkReport,
  reranked: RecallBenchmarkReport,
  minMrrDelta: number,
  minHitDelta: number,
): {
  improves: boolean;
  recommendation: "enable" | "keep-disabled";
  deltas: RerankEvalDeltas;
} {
  const hitDelta = reranked.hitAtK - baseline.hitAtK;
  const mrrDelta = reranked.mrr - baseline.mrr;

  // The per-language fold of the same difference (M14): one entry per
  // language group of the baseline, so a verdict consumer sees which
  // language moved which way. The keys are the baseline's, and both arms
  // ran the same dataset, so the groups always pair up.
  const byLang: Record<string, RerankDelta> = {};
  let languageRegressed = false;
  for (const [lang, before] of Object.entries(baseline.byLang)) {
    const after = reranked.byLang[lang];
    const hitAtK = (after?.hitAtK ?? before.hitAtK) - before.hitAtK;
    const mrr = (after?.mrr ?? before.mrr) - before.mrr;
    byLang[lang] = Object.freeze({ hitAtK, mrr });
    if (hitAtK < -VERDICT_FP_NOISE || mrr < -VERDICT_FP_NOISE) languageRegressed = true;
  }

  // Never recommend a reranker that drops hit@k pooled or in any one
  // language; among non-regressing candidates, require a real pooled MRR
  // or hit@k lift.
  const improves =
    !languageRegressed && hitDelta >= 0 && (mrrDelta >= minMrrDelta || hitDelta >= minHitDelta);

  return {
    improves,
    recommendation: improves ? "enable" : "keep-disabled",
    deltas: Object.freeze({ hitAtK: hitDelta, mrr: mrrDelta, byLang: Object.freeze(byLang) }),
  };
}

function withRerank(
  config: ResolvedSearchConfig,
  enabled: boolean,
  kind: ResolvedRerankConfig["kind"],
  decisionModel?: ResolvedDecisionModelConfig,
): ResolvedSearchConfig {
  return Object.freeze({
    ...config,
    rerank: Object.freeze({
      ...config.rerank,
      enabled,
      kind,
      ...(decisionModel !== undefined
        ? {
            decisionModel: Object.freeze({
              ...decisionModel,
              uses: Object.freeze({ ...decisionModel.uses, rerank: "enforce" as const }),
              // Eval requests are real spend (the gate counts them) but not
              // shadow data: the report keeps them out of the agreement.
              recordOrigin: "eval" as const,
            }),
          }
        : {}),
    }),
  });
}

/** The active decision config the reranked arm needs, or a typed refusal. */
function decisionModelFor(
  config: ResolvedSearchConfig,
  opts: RerankEvalGateOptions,
): ResolvedDecisionModelConfig {
  const dm = opts.decisionModel ?? config.rerank.decisionModel;
  if (dm === undefined || dm.status !== "active") {
    throw new SearchError(
      "INVALID_INPUT",
      `the decision-model reranker is not active (${dm?.status ?? "not configured"}); ` +
        "run `o2b decision-model check` for what is missing",
    );
  }
  return dm;
}

/**
 * Evaluate whether reranking helps this store. Runs the benchmark with
 * rerank off and on and compares through {@link rerankEvalVerdict} - the
 * pooled lift with the no-regression rule, pooled and per language.
 */
export async function runRerankEvalGate(
  config: ResolvedSearchConfig,
  dataset: RecallBenchmarkDataset,
  opts: RerankEvalGateOptions = {},
): Promise<RerankEvalGateResult> {
  const kind = opts.kind ?? "local";
  const minMrrDelta = opts.minMrrDelta ?? 0.01;
  const minHitDelta = opts.minHitDelta ?? 0.01;
  const k = opts.k;

  // An internal gate with no caller: it scores the reranker against the
  // whole corpus, and a run that stopped seeing reserved pages would
  // compare the two arms over different vaults. Named through the shared
  // constant so the claim is the same claim every lane makes.
  const reach = MAINTENANCE_LANE_REACH;
  const decisionModel = kind === "decision-model" ? decisionModelFor(config, opts) : undefined;
  const baseline = await runRecallBenchmark(withRerank(config, false, kind), dataset, {
    k,
    transportReach: reach,
  });
  const reranked = await runRecallBenchmark(
    withRerank(config, true, kind, decisionModel),
    dataset,
    {
      k,
      transportReach: reach,
    },
  );

  const { improves, recommendation, deltas } = rerankEvalVerdict(
    baseline,
    reranked,
    minMrrDelta,
    minHitDelta,
  );

  return Object.freeze({
    improves,
    recommendation,
    baseline,
    reranked,
    deltas,
  });
}
