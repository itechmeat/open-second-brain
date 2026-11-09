import { closeSync, fsyncSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import { redactRawOutput } from "../redactor.ts";
import {
  JSONL_LEDGER_EXT,
  resolveAppendShardId,
  shardedFileName,
  type LedgerShardGrammar,
} from "../brain/ledger-shards.ts";
import { auditRowRecord, DUAL_WRITE_LEDGERS } from "../store/dual-write-records.ts";
import { isRecordLabel } from "../store/envelope.ts";
import { logRefsNamePrivatePage } from "../store/reference-privacy.ts";
import { isStoreOnly } from "../store/store-only.ts";
import { isPathInsideResolved } from "../store/store-paths.ts";
import { routeWrite } from "../store/store-write.ts";
import { resolveVault } from "../config.ts";
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

/**
 * The directory name of the hook audit trail (`hookAuditDir` in
 * `brain/paths.ts`), whose rows are written from hooks only.
 */
const HOOK_AUDIT_TRAIL = "hook-audit";

/**
 * The name a store-only write reports for its row: the ledger every audit
 * trail shares, never the device path of a store shard (which holds store
 * envelopes, not audit lines, and must not reach a remote caller).
 */
export const AUDIT_STORE_LEDGER_NAME = `store:ledgers/${DUAL_WRITE_LEDGERS.reliabilityAudit}`;

/** Options of {@link appendAuditRecord}. */
export interface AppendAuditRecordOptions {
  /**
   * Hooks and other best-effort trails (design D14 item 1): on a
   * store-only machine a store failure is counted in the device-local
   * store-write status and the call returns instead of throwing. The
   * hook audit trail (`hook-audit`) is always fail-open.
   */
  readonly failOpen?: boolean;
}

/**
 * Append `record` to the audit trail `auditRoot` names. `vault` is the vault
 * the trail belongs to: the store-only switch and the privacy judge look
 * at it (the configured vault when absent), and the brain store refuses a
 * store root inside it.
 *
 *  - Unswitched machine: one line in the trail's week shard under
 *    `auditRoot`, then the phase 1 dual write. Returns the shard path.
 *  - Store-only machine (design D14 item 1): one `reliability-audit`
 *    ledger row and nothing under the vault. Returns
 *    {@link AUDIT_STORE_LEDGER_NAME} (the empty string when a fail-open
 *    write did not land).
 *  - A trail outside the vault (the device-local hook audit) stays a file
 *    on a store-only machine; that branch is what keeps the hook audit
 *    off the store, and its file append can still throw (hooks catch it).
 */
export function appendAuditRecord(
  auditRoot: string,
  record: AuditRecord,
  vault?: string,
  options: AppendAuditRecordOptions = {},
): string {
  const timestamp = new Date(record.timestamp);
  if (!Number.isFinite(timestamp.getTime())) {
    throw new Error(`invalid audit timestamp: ${record.timestamp}`);
  }
  const line = redactRawOutput(JSON.stringify(record), {
    maxInput: Number.POSITIVE_INFINITY,
  });
  // A trail outside the vault is device-local (the store's hook audit,
  // design D14 item 1): a store-only machine keeps writing it as a file,
  // since it is no part of the legacy tree and no other machine reads it.
  // The vault is resolved once (the configured one when none is given)
  // for the trail check and the store-only switch. The privacy judge sees
  // only the vault the caller named: a row written without its vault
  // cannot be judged against one and goes to `private` (fail closed).
  const effectiveVault = vault ?? configuredVaultOrUndefined();
  const context = vault !== undefined ? { vault } : {};
  if (
    !trailInsideVault(auditRoot, effectiveVault) &&
    isStoreOnly(effectiveVault !== undefined ? { vault: effectiveVault } : {})
  ) {
    return appendLegacyAuditLine(auditRoot, timestamp, line);
  }
  // The redacted row, exactly as written, with the trail it belongs to.
  // Every audit trail (hygiene, secret custody, hook audit, watchdog,
  // schema mutations, ...) shares this one store ledger, so the directory
  // name is what maps a row back to its trail. Audit rows go to `private`
  // when this machine holds it, else `shared`; a row whose target or
  // details name a private page goes to `private` only, judged by the rule
  // the Brain log events use.
  const routed = routeWrite({
    legacy: () => appendLegacyAuditLine(auditRoot, timestamp, line),
    store: () => {
      const written = JSON.parse(line) as AuditRecord;
      return auditRowRecord(
        DUAL_WRITE_LEDGERS.reliabilityAudit,
        { audit_dir: basename(auditRoot), record: written },
        isRecordLabel(written.actor) ? written.actor : undefined,
        auditRowNamesPrivatePage(vault, written),
      );
    },
    context,
    // The hook audit is written from hooks only, which never fail the
    // agent's turn over their own record keeping.
    ...(options.failOpen === true || basename(auditRoot) === HOOK_AUDIT_TRAIL
      ? { failOpen: true }
      : {}),
  });
  if (routed.mode === "legacy") return routed.value;
  return routed.records.length > 0 ? AUDIT_STORE_LEDGER_NAME : "";
}

/** The configured vault, or `undefined` when none resolves. */
function configuredVaultOrUndefined(): string | undefined {
  try {
    const vault = resolveVault();
    return vault !== null && vault.trim() !== "" ? vault : undefined;
  } catch {
    return undefined;
  }
}

/** Whether `auditRoot` lies inside the trail's vault. */
function trailInsideVault(auditRoot: string, vault: string | undefined): boolean {
  return (
    vault !== undefined &&
    vault.trim() !== "" &&
    isPathInsideResolved(auditRoot, vault, process.platform)
  );
}

/** The legacy week-shard append; returns the shard path. */
function appendLegacyAuditLine(auditRoot: string, timestamp: Date, line: string): string {
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
  const fileDescriptor = openSync(path, "a", 0o600);
  try {
    writeFileSync(fileDescriptor, line + "\n", "utf8");
    fsyncSync(fileDescriptor);
  } finally {
    closeSync(fileDescriptor);
  }
  return path;
}

/** Every string in `value`, nested arrays and objects included. */
function stringsIn(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) stringsIn(v, out);
  else if (value !== null && typeof value === "object") {
    for (const v of Object.values(value)) stringsIn(v, out);
  }
  return out;
}

/**
 * Whether an audit row names a private page through its target or the
 * strings in its details. Without the vault nothing can be judged, so the
 * row counts as private (fails closed).
 */
export function auditRowNamesPrivatePage(vault: string | undefined, record: AuditRecord): boolean {
  if (vault === undefined) return true;
  return logRefsNamePrivatePage(vault, [record.target, ...stringsIn(record.details)]);
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
