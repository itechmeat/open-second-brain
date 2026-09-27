/**
 * Per-store reranker evaluation gate (Retrieval & Ranking Quality,
 * t_9f95ebb6).
 *
 * Before a store commits to reranking, this gate MEASURES whether the
 * reranker actually improves recall/ranking quality on that store's own
 * labelled queries. It runs the existing recall-benchmark twice - rerank
 * OFF then ON - over the same dataset and compares the metric families
 * (hit@k, MRR). Reranking is recommended only when it lifts ranking without
 * regressing hit@k, so a store where the reranker does not help never
 * silently enables one that hurts.
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
  /** Minimum MRR lift required to recommend enabling. Default 0.01. */
  readonly minMrrDelta?: number;
  /** Minimum hit@k lift that alone justifies enabling. Default 0.01. */
  readonly minHitDelta?: number;
  /**
   * The decision-model config for `kind: "decision-model"`, when the
   * search config was not resolved with that kind. Must be active; the
   * reranked arm always runs the `rerank` use in `enforce`, since a shadow
   * arm would return the heuristic order and measure nothing.
   */
  readonly decisionModel?: ResolvedDecisionModelConfig;
}

export interface RerankEvalGateResult {
  /** Whether reranking is recommended for this store. */
  readonly improves: boolean;
  readonly recommendation: "enable" | "keep-disabled";
  readonly baseline: RecallBenchmarkReport;
  readonly reranked: RecallBenchmarkReport;
  readonly deltas: { readonly hitAtK: number; readonly mrr: number };
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
 * rerank off and on and compares. Recommends enabling only when MRR lifts
 * by at least `minMrrDelta` (or hit@k by `minHitDelta`) AND hit@k does not
 * regress - a strictly safe promotion rule.
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

  const hitDelta = reranked.hitAtK - baseline.hitAtK;
  const mrrDelta = reranked.mrr - baseline.mrr;

  // Never recommend a reranker that drops hit@k; among non-regressing
  // candidates, require a real MRR or hit@k lift.
  const improves = hitDelta >= 0 && (mrrDelta >= minMrrDelta || hitDelta >= minHitDelta);

  return Object.freeze({
    improves,
    recommendation: improves ? "enable" : "keep-disabled",
    baseline,
    reranked,
    deltas: { hitAtK: hitDelta, mrr: mrrDelta },
  });
}
