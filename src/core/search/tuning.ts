/**
 * Opt-in self-tuning recall (link-recall-intelligence, t_ae973491).
 *
 * The learned-weights fold already adapts per-layer multipliers from
 * explicit feedback; nothing tuned retrieval PARAMETERS. This module
 * closes that loop with the same philosophy - bounded, deterministic,
 * replayable:
 *
 *   - the parameter space is a FIXED grid (candidate-pool multiplier
 *     {3,4,5}, traversal depth {1,2}, learned weights on/off,
 *     expansion on/off) - nothing learned can leave it;
 *   - the objective function is the recall benchmark (t_e2215d49)
 *     over an operator-chosen dataset, best MRR wins (hit@k, then
 *     grid order break ties), so the choice is auditable;
 *   - the winner persists to `Brain/search/tuning.json` with every
 *     evaluated score and the dataset hash - delete the file (reset)
 *     and nothing else changes;
 *   - `search()` consults the tuned parameters ONLY when self-tuning
 *     is enabled (`search_self_tuning_enabled` /
 *     `OPEN_SECOND_BRAIN_SEARCH_SELF_TUNING`), values re-validated
 *     against the grid bounds on every read, fail-soft to defaults.
 *
 * The persisted read/reset side (`loadTunedParameters`, `resetTuning`)
 * and `applyTunedParameters` live in `tuning-store.ts`, a leaf module:
 * `search()` needs the tuned-parameter READ path but must not pull in
 * this module's `runRecallBenchmark` dependency, which itself calls
 * back into `search()`.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";

import { runRecallBenchmark } from "./benchmark.ts";
import type { RecallBenchmarkDataset } from "./benchmark.ts";
import {
  applyTunedParameters,
  TUNING_POOL_MULTIPLIERS,
  TUNING_SCHEMA_VERSION,
  TUNING_TRAVERSAL_DEPTHS,
  tuningPath,
} from "./tuning-store.ts";
import type { ResolvedSearchConfig, TunedParameters } from "./types.ts";

export interface TuningEvaluation {
  readonly params: TunedParameters;
  readonly mrr: number;
  readonly hitAtK: number;
}

export interface TuneRecallReport {
  readonly chosen: TunedParameters;
  readonly evaluated: ReadonlyArray<TuningEvaluation>;
  readonly datasetHash: string;
}

export interface TuneRecallOptions {
  /** Grid override (tests, narrowed sweeps). Defaults to the full grid. */
  readonly grid?: ReadonlyArray<TunedParameters>;
  /** Rank depth forwarded to the benchmark. */
  readonly k?: number;
  /** Injected clock for the persisted `evaluated_at` stamp. */
  readonly now: Date;
}

/** The full bounded grid in stable order (defaults first). */
export function defaultTuningGrid(): TunedParameters[] {
  const grid: TunedParameters[] = [];
  for (const expansion of [false, true]) {
    for (const learnedWeights of [false, true]) {
      for (const traversalDepth of TUNING_TRAVERSAL_DEPTHS) {
        for (const poolMultiplier of TUNING_POOL_MULTIPLIERS) {
          grid.push({ poolMultiplier, traversalDepth, learnedWeights, expansion });
        }
      }
    }
  }
  // Stable order with the all-defaults combo first: the sort above
  // already yields (3,1,false,false) first; keep insertion order.
  return grid;
}

/**
 * Grid-evaluate against the benchmark and persist the winner.
 * Deterministic for a fixed index state and dataset.
 */
export async function tuneRecall(
  config: ResolvedSearchConfig,
  dataset: RecallBenchmarkDataset,
  opts: TuneRecallOptions,
): Promise<TuneRecallReport> {
  const grid = opts.grid ?? defaultTuningGrid();
  if (grid.length === 0) throw new Error("tuneRecall: the parameter grid is empty");

  const evaluated = await Promise.all(
    grid.map(async (params): Promise<TuningEvaluation> => {
      const report = await runRecallBenchmark(applyTunedParameters(config, params), dataset, {
        ...(opts.k !== undefined ? { k: opts.k } : {}),
        expand: params.expansion,
      });
      return Object.freeze({ params, mrr: report.mrr, hitAtK: report.hitAtK });
    }),
  );

  // Best MRR; hit@k, then grid order break ties.
  let chosen = evaluated[0]!;
  for (const candidate of evaluated.slice(1)) {
    if (
      candidate.mrr > chosen.mrr ||
      (candidate.mrr === chosen.mrr && candidate.hitAtK > chosen.hitAtK)
    ) {
      chosen = candidate;
    }
  }

  const datasetHash = createHash("sha256").update(JSON.stringify(dataset)).digest("hex");
  const path = tuningPath(config.vault);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify(
      {
        schema: TUNING_SCHEMA_VERSION,
        chosen: chosen.params,
        evaluated: evaluated.map((e) => ({
          params: e.params,
          mrr: e.mrr,
          hit_at_k: e.hitAtK,
        })),
        dataset_hash: datasetHash,
        evaluated_at: opts.now.toISOString(),
      },
      null,
      2,
    ) + "\n",
  );

  return Object.freeze({
    chosen: chosen.params,
    evaluated: Object.freeze(evaluated),
    datasetHash,
  });
}
