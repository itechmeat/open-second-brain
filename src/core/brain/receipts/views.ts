/**
 * Wire views over the receipt scan and fold results (storage-lifecycle,
 * Lane 3 task 3.4).
 *
 * ONE renderer per result, consumed by both surfaces - the
 * `o2b brain receipts` verb's `--json` output and the `brain_receipts`
 * tool's structured content - so the two cannot disagree on field
 * spellings (`dry_run`, `snapshot_run_id`, `protected_records`) or on
 * which fields exist. The core types stay camelCase for the engine; the
 * snake_case spellings live only here, at the boundary, exactly once.
 */

import type { ReceiptCompactResult } from "./compact.ts";
import { RECEIPT_COMPACTION_OPERATION } from "./types.ts";
import type { ReceiptScanReport } from "./types.ts";

/** The scan report as both surfaces render it. */
export function scanView(report: ReceiptScanReport): Record<string, unknown> {
  return {
    operation: RECEIPT_COMPACTION_OPERATION,
    generated_at: report.generated_at,
    older_than_days: report.olderThanDays,
    cutoff: report.cutoff,
    shards: report.shards.map((shard) => ({
      family: shard.family,
      name: shard.name,
      path: shard.path,
      base: shard.base,
      shard_id: shard.shardId,
      bytes: shard.bytes,
      records: shard.records,
      foldable: shard.foldable,
      protected_records: shard.protectedRecords,
      aggregates: shard.aggregates,
      unparseable: shard.unparseable,
    })),
    totals: {
      shards: report.totals.shards,
      records: report.totals.records,
      bytes: report.totals.bytes,
      foldable: report.totals.foldable,
      protected_records: report.totals.protectedRecords,
      aggregates: report.totals.aggregates,
      unparseable: report.totals.unparseable,
    },
    errors: report.errors.map(({ shard, path, message }) => ({ shard, path, message })),
  };
}

/** The fold result as both surfaces render it. */
export function compactView(result: ReceiptCompactResult): Record<string, unknown> {
  return {
    operation: result.operation,
    dry_run: result.dryRun,
    older_than_days: result.olderThanDays,
    cutoff: result.cutoff,
    shards: result.shards.map((shard) => ({
      shard: shard.shard,
      folded: shard.folded,
      kept: shard.kept,
      aggregates: shard.aggregates,
      bytes_before: shard.bytesBefore,
      bytes_after: shard.bytesAfter,
    })),
    groups: result.groups.map((group) => ({
      shard: group.shard,
      kind: group.kind,
      month: group.month,
      count: group.count,
      first: group.first,
      last: group.last,
      bytes: group.bytes,
    })),
    // Both rows are rendered field-by-field rather than passed through:
    // the wire holds the shard's identity and the sanitized verdict, and
    // a field the core later grows cannot ride along unreviewed.
    failures: result.failures.map(({ shard, message }) => ({ shard, message })),
    totals: {
      shards: result.totals.shards,
      folded: result.totals.folded,
      kept: result.totals.kept,
      aggregates: result.totals.aggregates,
      bytes_before: result.totals.bytesBefore,
      bytes_after: result.totals.bytesAfter,
    },
    ...(result.snapshotRunId !== undefined ? { snapshot_run_id: result.snapshotRunId } : {}),
    ...(result.recoverability !== undefined ? { recoverability: result.recoverability } : {}),
    // The run's net cost (M6): the ledger shrink beside the recovery
    // point's own bytes - a whole-Brain archive in a counted surface -
    // so the caller can see growth the shrink did not pay for.
    ...(result.snapshotBytes !== undefined ? { snapshot_bytes: result.snapshotBytes } : {}),
    ...(result.netDeltaBytes !== undefined ? { net_delta_bytes: result.netDeltaBytes } : {}),
    ...(result.auditRecordId !== undefined ? { audit_record_id: result.auditRecordId } : {}),
    ...(result.auditError !== undefined ? { audit_error: result.auditError } : {}),
  };
}
