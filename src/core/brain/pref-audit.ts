/**
 * Per-preference mutation audit log (Brain lifecycle suite, Feature 1).
 *
 * Every mutation to a preference is captured at the mutation chokepoint
 * (`writePreferenceTxn`, `moveToRetired`, `mergePreferences`) as one
 * append-only JSONL line under
 * `Brain/log/pref-audit/<pref-id>/device[.<deviceId>].jsonl` - one file
 * per preference per device (who-wrote-what, Task B), so two machines
 * editing the same preference never contend for one synced file. Because
 * the trail is written where the content hash is computed, it is
 * authoritative (true before/after) and also catches manual edits routed
 * through the same primitives.
 *
 * ## Why a directory per preference
 *
 * The trail was flat - `<pref-id>[.<deviceId>].jsonl` - and that name is
 * ambiguous, because {@link import('./paths.ts').validateSlug} permits a
 * dot inside a preference id. `pref-a.b.jsonl` is BOTH the legacy trail
 * of the preference `pref-a.b` and `pref-a`'s shard on a device called
 * `b`: reading `pref-a` returned the neighbour's records, and appending
 * for `pref-a` on device `b` wrote into the neighbour's file.
 *
 * No separator fixes it. Every character `validateSlug` accepts can also
 * appear inside a preference id, so any flat name built from
 * `(prefId, deviceId)` is a name some other valid preference id could
 * own. One path SEGMENT per preference can not be another preference's
 * segment, so the directory is the layout that makes the collision
 * impossible rather than unlikely. Inside it the file is named by a fixed
 * stem plus the shard id, which is the same grammar every other ledger
 * uses and which gives the empty (legacy) shard id a name.
 *
 * Legacy flat files stay readable and are never renamed: a read merges
 * `<pref-id>[.<deviceId>].jsonl` from the parent directory with the
 * per-preference directory. Because a flat name can be ambiguous, every
 * record read is checked against the id that was asked for; a record
 * carrying a different `pref_id` is DROPPED and reported as a warning,
 * never silently mixed in.
 *
 * No-op contract: for an `update` op, {@link appendPrefAudit} writes
 * nothing and returns `false` when `hash_before === hash_after` (both
 * present and equal), i.e. the write did not change the preference
 * content - so counter-only refresh churn leaves no audit line and the
 * byte-identical default-install contract holds. Lifecycle ops
 * (`create` / `promote` / `retire` / `merge`) always record: they are
 * meaningful transitions even when the principle/scope fingerprint is
 * unchanged (e.g. a merge that only absorbs evidence).
 *
 * Append uses `appendFileSync` (the same `O_APPEND` atomicity assumption
 * as `dream-workrun.ts`); each line is small. The reader tolerates
 * malformed lines (surfaced as warnings) and unknown future op kinds
 * (kept as the raw string), matching the log-reader tolerance contract.
 */

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  listShardedFiles,
  literalBase,
  mergeShardedRows,
  type LedgerShardGrammar,
  type ShardedRow,
} from "./ledger-shards.ts";
import {
  PREF_AUDIT_EXT,
  PREF_AUDIT_STEM,
  prefAuditDir,
  prefAuditPath,
  prefAuditPrefDir,
  validateSlug,
} from "./paths.ts";
import { assertVaultIdentityForWrite } from "./vault-identity.ts";
import { isoSecond } from "./time.ts";
import { PREF_AUDIT_OP, type PrefAuditOp, type PrefAuditRecord } from "./types.ts";

/**
 * Opt-in audit sink threaded through a mutation chokepoint. When
 * supplied, the chokepoint appends one audit record (subject to the
 * per-op no-op rule). Omitting it preserves pre-suite behaviour - no
 * audit file is created.
 */
export interface PrefAuditSink {
  /** Agent identity recorded on the audit line. */
  readonly agent: string;
  /** Optional machine-readable reason code. */
  readonly reason?: string;
  /** Clock for the audit timestamp; defaults to `new Date()`. */
  readonly now?: () => Date;
}

/** Input for {@link appendPrefAudit}. `reason` is optional. */
export interface AppendPrefAuditInput {
  readonly pref_id: string;
  readonly op: PrefAuditOp;
  readonly agent: string;
  readonly reason?: string;
  readonly revision_before: number | null;
  readonly revision_after: number | null;
  readonly hash_before: string | null;
  readonly hash_after: string | null;
}

/** One warning raised while reading an audit JSONL file. */
export interface PrefAuditParseWarning {
  readonly path: string;
  readonly lineNumber: number;
  readonly message: string;
}

export interface ReadPrefAuditResult {
  readonly records: ReadonlyArray<PrefAuditRecord>;
  readonly warnings: ReadonlyArray<PrefAuditParseWarning>;
}

/**
 * Render one audit record as a canonical JSON line (trailing newline).
 * Field order is fixed so the on-disk line stays stable across writes -
 * important for the Syncthing byte-identical contract.
 */
export function renderPrefAuditLine(rec: PrefAuditRecord): string {
  const ordered: Record<string, unknown> = {
    ts: rec.ts,
    pref_id: rec.pref_id,
    op: rec.op,
    agent: rec.agent,
    ...(rec.reason !== undefined ? { reason: rec.reason } : {}),
    revision_before: rec.revision_before,
    revision_after: rec.revision_after,
    hash_before: rec.hash_before,
    hash_after: rec.hash_after,
  };
  return JSON.stringify(ordered) + "\n";
}

/**
 * Append one audit line for `input`. Returns `true` when a line was
 * written, `false` on the no-op path (unchanged content hash). The
 * audit directory is created on demand.
 */
export function appendPrefAudit(
  vault: string,
  input: AppendPrefAuditInput,
  opts: { now?: Date } = {},
): boolean {
  // Vault-identity write guard (context-integrity-gates, Unit J).
  assertVaultIdentityForWrite(vault);
  // No-op when an `update` did not change the preference content. Both
  // hashes present and equal => counter-only churn, nothing meaningful
  // to record. Lifecycle ops always record (see module docstring).
  if (
    input.op === PREF_AUDIT_OP.update &&
    input.hash_before !== null &&
    input.hash_after !== null &&
    input.hash_before === input.hash_after
  ) {
    return false;
  }

  const now = opts.now ?? new Date();
  const record: PrefAuditRecord = {
    ts: isoSecond(now),
    pref_id: input.pref_id,
    op: input.op,
    agent: input.agent,
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
    revision_before: input.revision_before,
    revision_after: input.revision_after,
    hash_before: input.hash_before,
    hash_after: input.hash_after,
  };

  const path = prefAuditPath(vault, input.pref_id);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, renderPrefAuditLine(record), "utf8");
  return true;
}

/**
 * Read the full mutation history for one preference id, oldest first,
 * merged across every device shard.
 *
 * Two places hold shards: the per-preference directory every current
 * write lands in, and the legacy flat names beside it. Both are read; the
 * legacy ones first, so a same-timestamp tie between the two layouts
 * resolves the same way on every device. The merge order is (`ts`, shard
 * id, line), so two machines show the same history whatever order
 * Syncthing delivered the files in. Returns empty records (no warnings)
 * when no shard exists. Malformed lines and rows missing required fields
 * become warnings naming the shard they came from; unknown op kinds are
 * preserved verbatim.
 *
 * A record whose `pref_id` is not the one asked for is DROPPED with a
 * warning rather than returned: a legacy flat name is ambiguous (see the
 * module docblock), and answering with the neighbour's history is the one
 * answer a caller cannot detect.
 */
export function readPrefAudit(vault: string, prefId: string): ReadPrefAuditResult {
  const wanted = validateSlug(prefId);
  const rows: Array<ShardedRow<PrefAuditRecord>> = [];
  const warnings: PrefAuditParseWarning[] = [];
  const shards = [
    ...listShardedFiles(prefAuditDir(vault), legacyPrefAuditGrammar(wanted)),
    ...listShardedFiles(prefAuditPrefDir(vault, wanted), PREF_AUDIT_GRAMMAR),
  ];
  for (const shard of shards) {
    const path = shard.path;
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (err) {
      const message = (err as NodeJS.ErrnoException).message ?? String(err);
      warnings.push({ path, lineNumber: 0, message: `failed to read audit file: ${message}` });
      continue;
    }
    const lines = text.split(/\r?\n/);
    let index = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.trim() === "") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        warnings.push({
          path,
          lineNumber: i + 1,
          message: `malformed JSONL line: ${line.slice(0, 80)}`,
        });
        continue;
      }
      const rec = coerceRecord(parsed, path, i + 1, warnings);
      if (rec === null) continue;
      if (rec.pref_id !== wanted) {
        warnings.push({
          path,
          lineNumber: i + 1,
          message:
            `audit row belongs to ${rec.pref_id}, not ${wanted} - the legacy flat file name is ` +
            "ambiguous when a preference id contains a dot; this row was not merged",
        });
        continue;
      }
      rows.push({ value: rec, shardId: shard.shardId, line: index++ });
    }
  }
  return { records: mergeShardedRows(rows, (record) => record.ts), warnings };
}

/**
 * The name layout of one preference's shards INSIDE its own directory.
 * The base is the fixed stem, so the directory alone decides which
 * preference a file belongs to and no id can be mistaken for a shard.
 */
const PREF_AUDIT_GRAMMAR: LedgerShardGrammar = Object.freeze({
  base: literalBase(PREF_AUDIT_STEM),
  extensions: Object.freeze([PREF_AUDIT_EXT]),
});

/**
 * The legacy flat layout: `<pref-id>[.<deviceId>].jsonl` beside the
 * per-preference directories. Still read, never written, never renamed.
 * The pref id goes in as a literal so an unescaped dot cannot widen the
 * pattern - but the name remains ambiguous in the other direction, which
 * is why every row it yields is checked against `pref_id`.
 */
function legacyPrefAuditGrammar(prefId: string): LedgerShardGrammar {
  return { base: literalBase(prefId), extensions: [PREF_AUDIT_EXT] };
}

/**
 * Render an audit trail as a compact, locale-free text table (oldest
 * first). One header line plus one line per record. Used by the
 * `o2b brain audit` CLI verb; the MCP tool returns the structured
 * records directly.
 */
export function renderPrefAudit(prefId: string, records: ReadonlyArray<PrefAuditRecord>): string {
  if (records.length === 0) {
    return `${prefId}: no audit records`;
  }
  const lines = [`${prefId} - ${records.length} event${records.length === 1 ? "" : "s"}`];
  for (const r of records) {
    const rev = `${r.revision_before ?? "-"}->${r.revision_after ?? "-"}`;
    const reason = r.reason ? ` (${r.reason})` : "";
    lines.push(`${r.ts}  ${r.op.padEnd(8)} ${r.agent.padEnd(12)} rev ${rev}${reason}`);
  }
  return lines.join("\n");
}

function coerceRecord(
  raw: unknown,
  path: string,
  lineNumber: number,
  warnings: PrefAuditParseWarning[],
): PrefAuditRecord | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    warnings.push({ path, lineNumber, message: "audit row is not an object" });
    return null;
  }
  const obj = raw as Record<string, unknown>;
  const ts = obj["ts"];
  const prefId = obj["pref_id"];
  const op = obj["op"];
  const agent = obj["agent"];
  if (
    typeof ts !== "string" ||
    typeof prefId !== "string" ||
    typeof op !== "string" ||
    typeof agent !== "string"
  ) {
    warnings.push({ path, lineNumber, message: "audit row missing ts/pref_id/op/agent" });
    return null;
  }
  const reason = obj["reason"];
  return {
    ts,
    pref_id: prefId,
    op,
    agent,
    ...(typeof reason === "string" ? { reason } : {}),
    revision_before: coerceNullableNumber(obj["revision_before"]),
    revision_after: coerceNullableNumber(obj["revision_after"]),
    hash_before: coerceNullableString(obj["hash_before"]),
    hash_after: coerceNullableString(obj["hash_after"]),
  };
}

function coerceNullableNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function coerceNullableString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}
