/**
 * The batch plan (task 3.19): `brain_ingest_batch_plan` and the wire
 * serializer the tool, the CLI verb and the tests share. Split from
 * `ingest-tools.ts`; registration happens through that module's
 * registry, which preserves the public INGEST_TOOLS surface.
 */

import { serializeImportCensus } from "../../core/brain/import-census.ts";
import { planBatches, type BatchPlan } from "../../core/brain/ingest/batch-plan.ts";
import { clearCheckpoint } from "../../core/brain/ingest/checkpoint.ts";
import { reconcilePlan } from "../../core/brain/ingest/reconcile.ts";
import { coerceBoolOptional, coerceInt, coerceStr, coerceStrList } from "../coerce.ts";
import { type ServerContext } from "../tool-contract.ts";
import { readableAtContextReach } from "./reach-readable.ts";
import { DEFAULT_MAX_BATCH_BYTES, DEFAULT_MAX_BATCH_FILES } from "./ingest-source-tools.ts";

/**
 * The wire shape of a batch plan, shared by every surface that emits one: this
 * tool and `o2b brain batch-plan --json` (which spreads its own `reconcile` on
 * top). One serializer means a field added here cannot reach one surface and
 * miss the other.
 */
export function serializeBatchPlan(plan: BatchPlan): Record<string, unknown> {
  return {
    source_dir: plan.sourceDir,
    max_batch_bytes: plan.maxBatchBytes,
    max_batch_files: plan.maxBatchFiles,
    total_files: plan.totalFiles,
    total_bytes: plan.totalBytes,
    skipped: [...plan.skipped],
    // The H3 resurrect guard on the wire: sources whose manifest entry is
    // marked retired and whose bytes are unchanged. Only emitted when
    // non-empty, so a plan with no retired entry serializes byte-identically
    // to before.
    ...(plan.skippedRetired.length > 0 ? { skipped_retired: [...plan.skippedRetired] } : {}),
    // Only emitted when the manifest's recorded extraction contract differs
    // from the live one (t_586d5d8b), so a plan under an unchanged contract
    // serializes byte-identically to before. The count names how many files
    // reprocess because of the contract rather than their bytes.
    ...(plan.contractChanged
      ? { contract_changed: true, contract_changed_files: plan.contractChangedFiles }
      : {}),
    // Only emitted when the extractable gate skipped something, so a plan with
    // no extractable declaration serializes byte-identically to before. The
    // reason is the typed token (P4) and `detail` carries the value behind
    // it - the schema_type, or the format of a format skip - so a reader can
    // check the skip without re-reading.
    ...(plan.skippedNonExtractable.length > 0
      ? {
          skipped_non_extractable: plan.skippedNonExtractable.map((s) => ({
            path: s.path,
            reason: s.reason,
            detail: s.detail,
          })),
        }
      : {}),
    // Per-reason counts (P4), emitted only when something was skipped.
    ...(Object.keys(plan.skipReasonCounts).length > 0
      ? { skip_reason_counts: plan.skipReasonCounts }
      : {}),
    // Per-extension unclassifiable counts (P4), emitted only when the walk
    // dropped at least one non-ingestible file, so a tree that is all
    // ingestible serializes byte-identically to before.
    ...(plan.unclassifiable.total > 0
      ? {
          unclassifiable: {
            total: plan.unclassifiable.total,
            by_extension: plan.unclassifiable.byExtension,
          },
        }
      : {}),
    // Only emitted when the repository's own ignore files carried a malformed
    // pattern (t_4b2bd8f7), so a tree that declares none - or declares only
    // well-formed patterns - serializes byte-identically to before.
    ...(plan.ignoreWarnings.length > 0
      ? {
          ignore_warnings: plan.ignoreWarnings.map((w) => ({
            source: w.source,
            line: w.line,
            pattern: w.pattern,
            reason: w.reason,
          })),
        }
      : {}),
    plan_id: plan.planId,
    resumed_completed: plan.resumedCompleted,
    batches: plan.batches.map((b) => ({
      index: b.index,
      total_bytes: b.totalBytes,
      // `format` only for a non-text file, so a Markdown plan is unchanged.
      files: b.files.map((f) => ({
        path: f.path,
        bytes: f.bytes,
        status: f.status,
        ...(f.format !== undefined ? { format: f.format } : {}),
      })),
    })),
  };
}

export async function toolBrainIngestBatchPlan(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const sourceDir = coerceStr(args, "source_dir", true)!;
  const maxBatchBytes = coerceInt(
    args,
    "max_batch_bytes",
    DEFAULT_MAX_BATCH_BYTES,
    1,
    Number.MAX_SAFE_INTEGER,
  );
  const maxBatchFiles = coerceInt(
    args,
    "max_batch_files",
    DEFAULT_MAX_BATCH_FILES,
    1,
    Number.MAX_SAFE_INTEGER,
  );
  const resume = coerceBoolOptional(args, "resume") ?? false;
  const reconcile = coerceBoolOptional(args, "reconcile") ?? false;
  const srcSubpath = coerceStr(args, "src_subpath", false) ?? undefined;
  const exclude = coerceStrList(args, "exclude");
  // A file the caller may not read at its reach is planned as an absent one.
  const include = readableAtContextReach(ctx);
  const plan = planBatches(ctx.vault, sourceDir, {
    maxBatchBytes,
    maxBatchFiles,
    resume,
    include,
    ...(srcSubpath !== undefined ? { srcSubpath } : {}),
    ...(exclude.length > 0 ? { exclude } : {}),
  });
  // Reconcile BEFORE any checkpoint clear below, so the gap report reads a live
  // checkpoint. Read-only: it only diffs dispatched vs completed.
  const report = reconcile ? reconcilePlan(ctx.vault, plan, include) : undefined;
  // A resumed plan that comes back empty is fully drained: drop its checkpoint
  // (the content manifest is the authoritative final state from here on).
  if (resume && plan.batches.length === 0) {
    clearCheckpoint(ctx.vault, plan.planId);
  }
  const serialized = serializeBatchPlan(plan);
  return report === undefined
    ? serialized
    : {
        ...serialized,
        reconcile: {
          plan_id: report.planId,
          dispatched: [...report.dispatched],
          ingested: [...report.ingested],
          missing: [...report.missing],
          complete: report.complete,
          census: serializeImportCensus(report.census),
        },
      };
}
