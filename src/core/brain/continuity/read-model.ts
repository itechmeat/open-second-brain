/**
 * Continuity read-model (Memory Observability Suite kernel).
 *
 * The single normalization layer between the raw JSONL continuity
 * store and every read-side consumer (ATOF/ATIF export, bench
 * harness). It absorbs three concerns exactly once so consumers
 * cannot disagree on them:
 *
 *   - schema-version dispatch: records written before the stamp
 *     existed carry no `schema` field and read as v1 (`legacy: true`);
 *   - masking policy: `private` records are DROPPED by default and
 *     kept only on explicit request; payload text is already
 *     redaction-masked at write time and is never un-masked here;
 *   - fail-soft reads: malformed rows normalize to null and unknown
 *     kinds stay readable (the evolution rule is additive).
 *
 * Read-only by construction - this module never writes to the store.
 */

import { listContinuityRecords } from "./store.ts";
import { CONTINUITY_SCHEMA_VERSION } from "./types.ts";

export interface NormalizedContinuityRecord {
  /** Effective schema version - legacy records report v1. */
  readonly schema: string;
  /** True when the on-disk record predates the version stamp. */
  readonly legacy: boolean;
  readonly id: string;
  readonly kind: string;
  readonly createdAt: string;
  readonly sourceRefs: ReadonlyArray<Readonly<Record<string, unknown>>>;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly private: boolean;
  readonly redacted: boolean;
  /** Correlation ids lifted out of the payload when present. */
  readonly sessionId?: string;
  readonly turnId?: string;
  /** Generation-report handoff lifted to a first-class join field. */
  readonly handoffKind?: string;
  readonly handoffRef?: string;
}

export interface ContinuityReadModelFilter {
  readonly kind?: string;
  readonly sessionId?: string;
  readonly since?: string;
  readonly until?: string;
  /** Keep records flagged `private` (default: drop them). */
  readonly keepPrivate?: boolean;
}

/** Normalize one raw record (parsed JSONL row). Fail-soft: null on malformed input. */
export function normalizeContinuityRecord(raw: unknown): NormalizedContinuityRecord | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const id = readString(record["id"]);
  const kind = readString(record["kind"]);
  const createdAt = readString(record["createdAt"]);
  if (id === undefined || kind === undefined || createdAt === undefined) return null;
  const schema = readString(record["schema"]);
  const payload = isPlainObject(record["payload"])
    ? (record["payload"] as Record<string, unknown>)
    : {};
  const sourceRefs = Array.isArray(record["sourceRefs"])
    ? (record["sourceRefs"] as unknown[]).filter(isPlainObject)
    : [];
  const sessionId = readString(payload["session_id"]);
  const turnId = readString(payload["turn_id"]);
  const handoff = isPlainObject(payload["handoff"]) ? payload["handoff"] : undefined;
  const handoffKind = handoff !== undefined ? readString(handoff["kind"]) : undefined;
  const handoffRef = handoff !== undefined ? readString(handoff["ref"]) : undefined;
  return Object.freeze({
    schema: schema ?? CONTINUITY_SCHEMA_VERSION,
    legacy: schema === undefined,
    id,
    kind,
    createdAt,
    sourceRefs: Object.freeze(sourceRefs.map((ref) => Object.freeze({ ...ref }))),
    payload: Object.freeze({ ...payload }),
    private: record["private"] === true,
    redacted: record["redacted"] === true,
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(turnId !== undefined ? { turnId } : {}),
    ...(handoffKind !== undefined ? { handoffKind } : {}),
    ...(handoffRef !== undefined ? { handoffRef } : {}),
  });
}

/** Load, normalize, and filter the whole store. Private records drop unless kept. */
export function loadNormalizedContinuityRecords(
  vault: string,
  filter: ContinuityReadModelFilter = {},
): ReadonlyArray<NormalizedContinuityRecord> {
  const records = listContinuityRecords(vault, {
    ...(filter.since !== undefined ? { since: filter.since } : {}),
    ...(filter.until !== undefined ? { until: filter.until } : {}),
  });
  const normalized: NormalizedContinuityRecord[] = [];
  for (const record of records) {
    const entry = normalizeContinuityRecord(record);
    if (entry === null) continue;
    if (entry.private && filter.keepPrivate !== true) continue;
    if (filter.kind !== undefined && entry.kind !== filter.kind) continue;
    if (filter.sessionId !== undefined && entry.sessionId !== filter.sessionId) continue;
    normalized.push(entry);
  }
  return Object.freeze(normalized);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
