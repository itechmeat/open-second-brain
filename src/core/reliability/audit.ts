import { closeSync, fsyncSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { redactRawOutput } from "../redactor.ts";
import {
  JSONL_LEDGER_EXT,
  resolveAppendShardId,
  shardedFileName,
  type LedgerShardGrammar,
} from "../brain/ledger-shards.ts";
// The one value this module reads at module-evaluation time is declared in
// the leaf `path-constants.ts` and re-exported by `ledger-shards.ts` (see
// that constant's docblock for the import cycle that motivated the move).
// Reading it through the re-export is what keeps this module safe: a
// re-exported binding resolves to the declaring leaf module, so it is
// initialized even when `ledger-shards.ts` itself is still mid-cycle.

/**
 * The file-name layout of every per-device ISO-week audit directory:
 * `<YYYY-Www>[.<deviceId>].jsonl`, the base being what {@link isoWeekLabel}
 * produces. The writer below and every reader that lists the week files
 * share this one grammar, so the two cannot disagree on what a week shard
 * is, and a `*.sync-conflict-*` copy is never one.
 */
export const AUDIT_WEEK_SHARD_GRAMMAR: LedgerShardGrammar = Object.freeze({
  base: "\\d{4}-W\\d{2}",
  extensions: Object.freeze([JSONL_LEDGER_EXT]),
});

export interface AuditRecord {
  readonly timestamp: string;
  readonly actor: string;
  readonly action: string;
  readonly target: string;
  readonly ok: boolean;
  readonly details?: Record<string, unknown>;
}

export function appendAuditRecord(auditRoot: string, record: AuditRecord): string {
  const timestamp = new Date(record.timestamp);
  if (!Number.isFinite(timestamp.getTime())) {
    throw new Error(`invalid audit timestamp: ${record.timestamp}`);
  }
  mkdirSync(auditRoot, { recursive: true });
  // Per-device week shard (t_774dea61): two synced machines appending to
  // one `<week>.jsonl` produce `*.sync-conflict-*` copies no reader
  // merges. Each device now appends to its own `<week>[.<deviceId>].jsonl`
  // through the shared ledger-shard grammar; the empty device id keeps the
  // legacy un-sharded name, so existing vaults need no migration.
  const path = join(
    auditRoot,
    shardedFileName(isoWeekLabel(timestamp), resolveAppendShardId(), JSONL_LEDGER_EXT),
  );
  const line = redactRawOutput(JSON.stringify(record), {
    maxInput: Number.POSITIVE_INFINITY,
  });

  const fileDescriptor = openSync(path, "a", 0o600);
  try {
    writeFileSync(fileDescriptor, line + "\n", "utf8");
    fsyncSync(fileDescriptor);
  } finally {
    closeSync(fileDescriptor);
  }
  return path;
}

export function isoWeekLabel(input: Date): string {
  const date = new Date(Date.UTC(input.getUTCFullYear(), input.getUTCMonth(), input.getUTCDate()));
  const dayNumber = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNumber);
  const year = date.getUTCFullYear();
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}
