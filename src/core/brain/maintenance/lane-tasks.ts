/**
 * The maintenance lane's task list, built once for both front doors
 * (`o2b brain maintenance run` and the `brain_maintenance` MCP tool).
 *
 * The two surfaces carried the same four task bodies inline, and the
 * copies drifted. This builder owns them now: the four built-ins in their
 * registration order ({@link LANE_TASKS}), then the install-owned custom
 * tasks the machine config declares, when the master switch is on. What
 * differs per surface arrives by injection: the per-task safeguard (built
 * lazily, so each deadline starts when its task starts), the abort
 * signal, the progress sink and the spend banner.
 *
 * `taskNames` is the registered vocabulary both surfaces validate
 * `--retry`/`retry_tasks` against, and `custom.errors` carries every
 * refused declaration by name for the surface to report.
 */

import { dream } from "../dream.ts";
import {
  discoverBridges,
  readDismissedBridges,
  writeBridgeProposals,
} from "../link-graph/bridge-discovery.ts";
import { detectCommunities, materializeClusterNotes } from "../link-graph/communities.ts";
import { appendMetric } from "../metrics.ts";
import type { ProgressSink } from "../progress.ts";
import type { Safeguard } from "../safeguard.ts";
import { isoSecond } from "../time.ts";
import type { EmbeddingSpendPreview } from "../../search/indexer.ts";
import { Store } from "../../search/store.ts";
import type { ResolvedSearchConfig } from "../../search/types.ts";
import {
  createCustomLaneTask,
  resolveCustomTasks,
  type CustomTaskResolution,
} from "./custom-tasks.ts";
import { LANE_TASK, type LaneTask, type LaneTaskId, type MaintenanceTask } from "./lane.ts";
import { createLaneReindex, type LaneReindex } from "./reindex-task.ts";
import { runRelinkAnchors, type RelinkAnchorsReport } from "./relink-anchors-task.ts";

export interface LaneTaskBuildOptions {
  readonly vault: string;
  readonly configPath?: string;
  readonly searchConfig: ResolvedSearchConfig;
  readonly now: Date;
  /** Bypass a positive embedding cost gate for this run (`--force-cost`). */
  readonly forceCost: boolean;
  /**
   * Apply the relink pass: rewrite the changed signal pages' anchor
   * lines. Absent or false, the lane's relink task is the dry run - it
   * reports what it would add and writes nothing - because every other
   * pass an unattended lane runs through a cron produces no new writes
   * without an explicit ask. The apply arm carries the run's own
   * vault-identity write guard.
   */
  readonly relinkApply?: boolean;
  /** One fresh deadline per built-in task, called when that task starts. */
  readonly safeguardFor: (operation: LaneTask) => Safeguard;
  readonly signal?: AbortSignal;
  readonly onProgress?: ProgressSink;
  /** Called once with the reindex spend preview, before the pass, when there is one. */
  readonly onBanner?: (preview: EmbeddingSpendPreview) => void;
}

export interface LaneTaskSet {
  readonly tasks: ReadonlyArray<MaintenanceTask>;
  readonly reindex: LaneReindex;
  /** Every registered identity, in registration order. */
  readonly taskNames: ReadonlyArray<LaneTaskId>;
  readonly custom: CustomTaskResolution;
  /**
   * The relink pass's report for the run dispatched through this set, or
   * `undefined` while the task has not completed: the preview on the
   * default arm, the changes on the apply arm. Read after
   * `runMaintenance` resolves, beside the task rows - the same shape the
   * reindex spend block rides, because a task's report belongs to the
   * run, not to a task row's receipt field.
   */
  relinkReport(): RelinkAnchorsReport | undefined;
}

export function buildLaneTasks(opts: LaneTaskBuildOptions): LaneTaskSet {
  const { vault, now, searchConfig, safeguardFor } = opts;
  const laneProgress = opts.onProgress !== undefined ? { onProgress: opts.onProgress } : {};
  // The relink report is captured by the task body and read by the
  // caller after the run: `undefined` until the task completes, and
  // undefined again never - a set builds one run's tasks.
  let relinkReport: RelinkAnchorsReport | undefined;
  // Spend is opt-in (`maintenance_embeddings`): the reindex builder decides
  // whether the pass may embed, announces the predicted spend inside the
  // task and receipts what the phase priced.
  const reindex = createLaneReindex({
    vault,
    ...(opts.configPath !== undefined ? { configPath: opts.configPath } : {}),
    searchConfig,
    now,
    forceCost: opts.forceCost,
    safeguard: () => safeguardFor(LANE_TASK.reindex),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...laneProgress,
    ...(opts.onBanner !== undefined ? { onBanner: opts.onBanner } : {}),
  });
  const builtIns: MaintenanceTask[] = [
    {
      name: LANE_TASK.dream,
      run: async () => {
        dream(vault, { now, safeguard: safeguardFor(LANE_TASK.dream), ...laneProgress });
      },
    },
    reindex.task,
    // Link-recall-intelligence passes ride the same lease, after reindex
    // so they see fresh edges. Both are fail-soft inside: a vault without
    // embeddings simply proposes nothing, and a metrics write failure
    // never fails the task.
    {
      name: LANE_TASK.bridges,
      run: async () => {
        const store = await Store.open(searchConfig, { mode: "read" });
        try {
          const report = discoverBridges(store, {
            dismissed: readDismissedBridges(vault),
            safeguard: safeguardFor(LANE_TASK.bridges),
            ...laneProgress,
          });
          writeBridgeProposals(vault, report, { now });
          try {
            appendMetric(vault, {
              surface: "bridge_discovery",
              runAt: isoSecond(now),
              payload: {
                proposals: report.proposals.length,
                scanned_candidates: report.scannedCandidates,
                vec_available: report.vecAvailable,
                lane: true,
              },
            });
          } catch {
            // Metrics are observability, not correctness.
          }
        } finally {
          await store.close();
        }
      },
    },
    {
      name: LANE_TASK.clusters,
      run: async () => {
        const store = await Store.open(searchConfig, { mode: "read" });
        try {
          const communities = detectCommunities(store, {
            safeguard: safeguardFor(LANE_TASK.clusters),
            ...laneProgress,
          });
          const materialized = materializeClusterNotes(vault, communities, { store, now });
          try {
            appendMetric(vault, {
              surface: "communities",
              runAt: isoSecond(now),
              payload: {
                communities: communities.length,
                sizes: communities.map((c) => c.size),
                written: materialized.written.length,
                removed: materialized.removed.length,
                lane: true,
              },
            });
          } catch {
            // Metrics are observability, not correctness.
          }
        } finally {
          await store.close();
        }
      },
    },
    // The anchor-relink pass (note-change truth maintenance) closes the
    // lane: it reads the signal tree and the entity index only, so it
    // needs no store. It PREVIEWS by contract - `relinkApply` hands it
    // the apply arm, and absent that flag the report is what would change
    // and no signal page is rewritten. Either way the pass's report is
    // captured below and surfaced through `relinkReport()`, so neither
    // front door runs the pass blind. The pass never calls a model and
    // returns no spend receipt.
    {
      name: LANE_TASK.relink,
      run: async () => {
        relinkReport = runRelinkAnchors(vault, {
          now,
          apply: opts.relinkApply === true,
          safeguard: safeguardFor(LANE_TASK.relink),
          ...laneProgress,
        });
      },
    },
  ];
  const custom = resolveCustomTasks(opts.configPath);
  const customTasks = custom.specs.map((spec) =>
    createCustomLaneTask(spec, {
      vault,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    }),
  );
  const tasks = [...builtIns, ...customTasks];
  return {
    tasks,
    reindex,
    taskNames: tasks.map((task) => task.name),
    custom,
    relinkReport: () => relinkReport,
  };
}
