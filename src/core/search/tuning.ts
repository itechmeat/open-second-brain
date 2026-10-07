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
 *     and nothing else changes. A winner measured while the semantic
 *     lane was missing (the spend gate, a blocked capability, a provider
 *     outage, the hybrid deadline) is never saved: it scored a
 *     keyword-only system, not the configured one;
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
import { BLOCKED_TIER_ERROR_CODE, type BlockedCapabilityTier } from "./capability-tier.ts";
import { COST_GATE_KEY } from "./embedding-spend.ts";
import { EMBEDDING_PRICE_MODEL_KEY, EMBEDDING_PRICE_RATE_KEY } from "./embeddings/pricing.ts";
import { INPUT_WINDOW_TOKENS_KEY } from "./embeddings/presets.ts";
import {
  RETRIEVAL_DEGRADATION,
  semanticLaneMissing,
  type RetrievalDegradationCode,
} from "./retrieval-trail.ts";
import {
  applyTunedParameters,
  TUNING_POOL_MULTIPLIERS,
  TUNING_SCHEMA_VERSION,
  TUNING_TRAVERSAL_DEPTHS,
  tuningPath,
} from "./tuning-store.ts";
import type { TransportReach } from "../graph/transport-reach.ts";
import { SearchError, type SearchErrorCode } from "./types.ts";
import type { ResolvedSearchConfig, TunedParameters } from "./types.ts";

export interface TuningEvaluation {
  readonly params: TunedParameters;
  readonly mrr: number;
  readonly hitAtK: number;
  /** The benchmark's degradation codes for this cell (empty when none). */
  readonly degraded: ReadonlyArray<RetrievalDegradationCode>;
  /** The blocked capability rung, when {@link degraded} names one. */
  readonly capabilityTier?: BlockedCapabilityTier;
}

export interface TuneRecallReport {
  readonly chosen: TunedParameters;
  readonly evaluated: ReadonlyArray<TuningEvaluation>;
  readonly datasetHash: string;
  /** Every cell's degradation codes, sorted and de-duplicated. */
  readonly degraded: ReadonlyArray<RetrievalDegradationCode>;
}

export interface TuneRecallOptions {
  /** Grid override (tests, narrowed sweeps). Defaults to the full grid. */
  readonly grid?: ReadonlyArray<TunedParameters>;
  /** Rank depth forwarded to the benchmark. */
  readonly k?: number;
  /** Injected clock for the persisted `evaluated_at` stamp. */
  readonly now: Date;
  /**
   * The reach the party that supplied this dataset was established at,
   * forwarded verbatim to every grid cell's benchmark run. Absent
   * resolves to the narrowest there - see
   * {@link RecallBenchmarkOptions.transportReach}, which is where the
   * reason lives.
   */
  readonly transportReach?: TransportReach;
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

/** Why a sweep's winner was refused: the typed error and the lever that clears it. */
interface SemanticLaneRefusal {
  readonly trail: RetrievalDegradationCode;
  readonly error: (chosen: TuningEvaluation) => SearchErrorCode;
  readonly remedy: (config: ResolvedSearchConfig, chosen: TuningEvaluation) => string;
}

/**
 * The trail codes that name WHY the semantic lane did not run, in the
 * order a refusal names them, each with the typed error the explicit
 * semantic lane throws for the same cause. Whether the lane was missing
 * at all is {@link semanticLaneMissing}'s call, not this list's: a stop
 * no entry names refuses through {@link SEMANTIC_LANE_STOPPED}.
 */
const SEMANTIC_LANE_CAUSES: ReadonlyArray<SemanticLaneRefusal> = Object.freeze<
  SemanticLaneRefusal[]
>([
  {
    trail: RETRIEVAL_DEGRADATION.semanticCostUnpriced,
    error: () => "EMBEDDING_COST_UNPRICED",
    remedy: (config) =>
      `It was refused by ${COST_GATE_KEY}: declare the price of ` +
      `${config.semantic.model ?? "the embedding model"} with ${EMBEDDING_PRICE_MODEL_KEY} and ` +
      `${EMBEDDING_PRICE_RATE_KEY} (0 for a free self-hosted model), or lower ${COST_GATE_KEY}`,
  },
  {
    trail: RETRIEVAL_DEGRADATION.semanticCapabilityBlocked,
    // The rung the benchmark carried picks the code the explicit lane
    // throws for it; a summary without one keeps the pre-tier code.
    error: (chosen) =>
      chosen.capabilityTier !== undefined
        ? BLOCKED_TIER_ERROR_CODE[chosen.capabilityTier]
        : "EMBEDDING_DISABLED",
    remedy: () => "Complete the embedding provider configuration and its credential",
  },
  {
    trail: RETRIEVAL_DEGRADATION.semanticProviderUnavailable,
    error: () => "EMBEDDING_PROVIDER_HTTP",
    remedy: () => "Wait until the embedding provider answers again (o2b search check)",
  },
]);

/**
 * The named generic arm: the composite hybrid deadline cut the lane, the
 * provider answered with an empty vector, the instruction prefix alone
 * filled the input window, or another stop left the hybrid caller
 * keyword-only. The message names the codes the winner carried, and an
 * empty fit adds the window lever, which no provider check clears. A cut
 * where the lane still ran is not a stop, so it names no lever here.
 */
const SEMANTIC_LANE_STOPPED: SemanticLaneRefusal = Object.freeze({
  trail: RETRIEVAL_DEGRADATION.hybridDegraded,
  error: () => "EMBEDDING_PROVIDER_HTTP",
  remedy: (_config: ResolvedSearchConfig, chosen: TuningEvaluation) =>
    "Check why the embedding provider did not answer in time (o2b search check) " +
    "or raise search_hybrid_deadline_ms" +
    (chosen.degraded.includes(RETRIEVAL_DEGRADATION.semanticQueryEmptyFit)
      ? `; the instruction prefix fills the input window: raise ${INPUT_WINDOW_TOKENS_KEY} ` +
        "or shorten the query prefix"
      : ""),
});

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
        ...(opts.transportReach !== undefined ? { transportReach: opts.transportReach } : {}),
        expand: params.expansion,
      });
      return Object.freeze({
        params,
        mrr: report.mrr,
        hitAtK: report.hitAtK,
        degraded: report.degraded,
        ...(report.capabilityTier !== undefined ? { capabilityTier: report.capabilityTier } : {}),
      });
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

  // A winner scored while the semantic lane was missing would be saved as
  // the vault's parameters for the hybrid system it never ran.
  if (semanticLaneMissing(chosen.degraded)) {
    const missing =
      SEMANTIC_LANE_CAUSES.find(({ trail }) => chosen.degraded.includes(trail)) ??
      SEMANTIC_LANE_STOPPED;
    throw new SearchError(
      missing.error(chosen),
      `the tuning sweep was measured with the semantic lane missing ` +
        `(${chosen.degraded.join(", ")}), ` +
        `so its winner scores a keyword-only system and was not saved. ` +
        `${missing.remedy(config, chosen)}, then run the sweep again.`,
    );
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
    degraded: Object.freeze([...new Set(evaluated.flatMap((e) => e.degraded))].toSorted()),
  });
}
