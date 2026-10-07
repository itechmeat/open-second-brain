/**
 * The maintenance lane's reindex task, shared by both front doors
 * (`o2b brain maintenance run` and the `brain_maintenance` MCP tool).
 *
 * One builder owns the three things the two doors used to copy: whether
 * the pass may run its embedding phase, the spend preview announced
 * before the pass, and the receipt recorded after it (task row, metrics
 * line, run-level `spend` block).
 *
 * Spend is opt-in. The lane is unattended - a cron runs it - so the
 * embedding phase runs only when the operator set `maintenance_embeddings`
 * AND the resolved config can reach a provider. Off, the pass is
 * keyword-only: no preview, no provider call, no receipt. On, the
 * embedding cost gate applies exactly as it does for `o2b search index`.
 *
 * The preview is computed INSIDE the task, so a run the window, busy or
 * lease gate skips never reads the pending chunks and never reports a
 * banner for a pass that did not happen.
 */

import type { EmbeddingPriceSource } from "../../search/embeddings/pricing.ts";
import { resolveMaintenanceEmbeddings } from "../../config.ts";
import {
  resolveSemanticCapability,
  semanticCapabilityIsBlocked,
} from "../../search/capability-tier.ts";
import { indexVault } from "../../search/index.ts";
import {
  embeddingSpendOf,
  estimatePendingEmbeddingSpend,
  type EmbeddingSpendPreview,
} from "../../search/indexer.ts";
import type { ResolvedSearchConfig } from "../../search/types.ts";
import { appendMetric } from "../metrics.ts";
import type { ProgressSink } from "../progress.ts";
import type { Safeguard } from "../safeguard.ts";
import { isoSecond } from "../time.ts";
import { MAINTENANCE_SPEND_METRIC, type MaintenanceSpendReceipt } from "./journal.ts";
import { LANE_TASK, type MaintenanceTask, type MaintenanceTaskResult } from "./lane.ts";

export interface LaneReindexOptions {
  readonly vault: string;
  readonly configPath?: string;
  readonly searchConfig: ResolvedSearchConfig;
  readonly now: Date;
  /** Bypass a positive embedding cost gate for this run (`--force-cost`). */
  readonly forceCost: boolean;
  /** Built lazily, so the deadline starts when the task starts. */
  readonly safeguard: () => Safeguard;
  readonly signal?: AbortSignal;
  readonly onProgress?: ProgressSink;
  /** Called once with the preview, before the pass, when there is one. */
  readonly onBanner?: (preview: EmbeddingSpendPreview) => void;
}

/** The run-level `spend` block both doors report beside the task rows. */
export interface LaneSpendBlock {
  readonly banner?: {
    readonly model: string | null;
    readonly pendingChunks: number;
    /** Null when nobody stated the model's price. */
    readonly estimatedUsd: number | null;
    /** Who stated the price the estimate used. */
    readonly priceSource: EmbeddingPriceSource;
    readonly gateUsd: number;
  };
  readonly receipt?: MaintenanceSpendReceipt;
  /** Set when the receipt's metrics line could not be written, naming why. */
  readonly receipt_metric_error?: string;
}

export interface LaneReindex {
  /** True when this run may contact an embedding provider. */
  readonly embeddings: boolean;
  readonly task: MaintenanceTask;
  /** The `spend` block for the finished run, or undefined when there is nothing to say. */
  spendBlock(tasks: ReadonlyArray<MaintenanceTaskResult>): LaneSpendBlock | undefined;
}

/** Whether the lane may run the embedding phase under this config. */
export function laneEmbeddingsEnabled(
  searchConfig: ResolvedSearchConfig,
  configPath?: string,
): boolean {
  return (
    resolveMaintenanceEmbeddings(configPath) &&
    !semanticCapabilityIsBlocked(resolveSemanticCapability(searchConfig.semantic))
  );
}

export function createLaneReindex(opts: LaneReindexOptions): LaneReindex {
  const embeddings = laneEmbeddingsEnabled(opts.searchConfig, opts.configPath);
  let banner: EmbeddingSpendPreview | undefined;
  let metricError: string | undefined;

  const task: MaintenanceTask = {
    name: LANE_TASK.reindex,
    run: async () => {
      // An estimate by position: the walk may still add chunks, so the
      // receipt below is the phase's own census, not this number.
      if (embeddings) {
        const preview = await estimatePendingEmbeddingSpend(opts.searchConfig);
        if (preview !== null) {
          banner = preview;
          opts.onBanner?.(preview);
        }
      }
      const stats = await indexVault(opts.searchConfig, {
        embeddings,
        forceCost: opts.forceCost,
        safeguard: opts.safeguard(),
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
        ...(opts.onProgress !== undefined ? { onProgress: opts.onProgress } : {}),
      });
      // Only a completed pass returns stats, so a pass killed mid-spend
      // receipts nothing and its row carries the named failure instead.
      const receipt = embeddingSpendOf(stats);
      if (receipt !== undefined) {
        try {
          appendMetric(opts.vault, {
            surface: MAINTENANCE_SPEND_METRIC,
            runAt: isoSecond(opts.now),
            payload: {
              task: LANE_TASK.reindex,
              model: receipt.model,
              tokens: receipt.tokens,
              estimated_usd: receipt.estimatedUsd,
              price_source: receipt.priceSource,
              forced: receipt.forced,
              lane: true,
            },
          });
        } catch (err) {
          // The receipt still rides the task row and the journal; the
          // missing metrics line is reported by name on the spend block.
          metricError = err instanceof Error ? err.message : String(err);
        }
      }
      return receipt;
    },
  };

  return {
    embeddings,
    task,
    spendBlock(tasks) {
      const receipt = tasks.find(
        (t) => t.name === LANE_TASK.reindex && t.receipt !== undefined,
      )?.receipt;
      if (banner === undefined && receipt === undefined) return undefined;
      return {
        ...(banner !== undefined
          ? {
              banner: {
                model: banner.model,
                pendingChunks: banner.pendingChunks,
                estimatedUsd: banner.estimatedUsd,
                priceSource: banner.priceSource,
                gateUsd: opts.searchConfig.semantic.costGateUsd,
              },
            }
          : {}),
        ...(receipt !== undefined ? { receipt } : {}),
        ...(metricError !== undefined ? { receipt_metric_error: metricError } : {}),
      };
    },
  };
}
