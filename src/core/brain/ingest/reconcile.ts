/**
 * Dispatched-vs-ingested reconciliation for batch plans (P5, t_d067a153).
 *
 * A large-folder ingest is planned by {@link planBatches} and dispatched as
 * parallel subagents; each completed item folds into the plan's checkpoint via
 * {@link ../ingest/ingest.ts:ingestSource}'s `planId`. Nothing, however, told
 * the operator when the agent response quietly dropped a dispatched source. This
 * module closes that loop: {@link reconcilePlan} diffs the plan's dispatched set
 * against the checkpoint's completed entries and returns the gap.
 *
 * Report, not retry (a deliberate design decision): reconcile re-dispatches
 * nothing. It only reads the checkpoint and returns/warns what is missing;
 * re-ingesting the gap stays operator-driven. It is therefore read-only over
 * checkpoint state and idempotent - the same plan and checkpoint always yield
 * the same report, and calling it never mutates a byte on disk.
 *
 * The dispatched set is the full ingestible set the plan enumerated: the files
 * still packed into batches PLUS the files the content-hash manifest classified
 * `unchanged` (already ingested in a prior run of the same plan). Reconciling
 * that union against the checkpoint means a plan re-run after a partial ingest
 * still names exactly the sources that never landed.
 */

import type { BatchPlan } from "./batch-plan.ts";
import { readCheckpoint } from "./checkpoint.ts";

/** The gap report for one plan: what was dispatched vs what actually ingested. */
export interface ReconcileReport {
  /** The plan id the report is keyed on (matches {@link BatchPlan.planId}). */
  readonly planId: string;
  /** Every ingestible source the plan enumerated, sorted and deduped. */
  readonly dispatched: readonly string[];
  /** Dispatched sources the checkpoint confirms ingested, sorted. */
  readonly ingested: readonly string[];
  /** Dispatched sources the checkpoint never recorded - the gap, sorted. */
  readonly missing: readonly string[];
  /** True when the gap is empty (every dispatched source ingested). */
  readonly complete: boolean;
}

/**
 * Reconcile a batch plan against its checkpoint. Returns the set of dispatched
 * sources that never reached the checkpoint's completed set. Read-only and
 * idempotent: it reads the checkpoint keyed on `plan.planId` and mutates
 * nothing. A plan that dispatched nothing, or whose sources all completed,
 * reports an empty (explicitly `complete`) gap.
 */
export function reconcilePlan(vault: string, plan: BatchPlan): ReconcileReport {
  const completed = new Set(readCheckpoint(vault, plan.planId)?.completed ?? []);

  // Batch files are the sources actually dispatched for (re)ingest this run.
  const batchFiles = new Set<string>();
  for (const batch of plan.batches) {
    for (const file of batch.files) batchFiles.add(file.path);
  }
  // Manifest-`unchanged` skips are ingested by definition (their content hash
  // already matched a prior ingest). `--resume` drops completed items before
  // building batches/skips, so a checkpoint completion is the only surviving
  // record of a fully-resumed source - fold it in so it is not lost.
  const confirmed = new Set<string>([...plan.skipped, ...completed]);

  const dispatched = [...new Set<string>([...batchFiles, ...confirmed])].toSorted();
  const ingested: string[] = [];
  const missing: string[] = [];
  for (const path of dispatched) {
    // Missing only for a dispatched batch source with neither a manifest-skip
    // nor a checkpoint confirmation. Skips and checkpointed paths are ingested.
    if (confirmed.has(path)) ingested.push(path);
    else missing.push(path);
  }

  return {
    planId: plan.planId,
    dispatched,
    ingested,
    missing,
    complete: missing.length === 0,
  };
}
