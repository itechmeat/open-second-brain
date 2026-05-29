/**
 * Per-preference mutation audit log (Brain lifecycle suite, Feature 1).
 *
 * Every mutation to a preference is captured at the mutation chokepoint
 * (`writePreferenceTxn`, `moveToRetired`, `mergePreferences`) as one
 * append-only JSONL line under `Brain/log/pref-audit/<pref-id>.jsonl`.
 * Because the trail is written where the content hash is computed, it is
 * authoritative (true before/after) and also catches manual edits routed
 * through the same primitives.
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

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import { prefAuditPath } from "./paths.ts";
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
 * Read the full mutation history for one preference id, oldest first.
 * Returns empty records (no warnings) when the file does not exist.
 * Malformed lines and rows missing required fields become warnings;
 * unknown op kinds are preserved verbatim.
 */
export function readPrefAudit(vault: string, prefId: string): ReadPrefAuditResult {
  const path = prefAuditPath(vault, prefId);
  if (!existsSync(path)) return { records: [], warnings: [] };

  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    const message = (err as NodeJS.ErrnoException).message ?? String(err);
    return {
      records: [],
      warnings: [{ path, lineNumber: 0, message: `failed to read audit file: ${message}` }],
    };
  }

  const records: PrefAuditRecord[] = [];
  const warnings: PrefAuditParseWarning[] = [];
  const lines = text.split(/\r?\n/);
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
    if (rec !== null) records.push(rec);
  }
  return { records, warnings };
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
