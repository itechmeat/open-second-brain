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
import type { ResolvedRerankConfig, ResolvedSearchConfig } from "./types.ts";

export interface RerankEvalGateOptions {
  /** Rank depth for the benchmark (defaults to the benchmark default). */
  readonly k?: number;
  /** Reranker kind to evaluate (defaults to "local", the offline reranker). */
  readonly kind?: ResolvedRerankConfig["kind"];
  /** Minimum MRR lift required to recommend enabling. Default 0.01. */
  readonly minMrrDelta?: number;
  /** Minimum hit@k lift that alone justifies enabling. Default 0.01. */
  readonly minHitDelta?: number;
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
): ResolvedSearchConfig {
  return Object.freeze({
    ...config,
    rerank: Object.freeze({ ...config.rerank, enabled, kind }),
  });
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

  const baseline = await runRecallBenchmark(withRerank(config, false, kind), dataset, { k });
  const reranked = await runRecallBenchmark(withRerank(config, true, kind), dataset, { k });

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
