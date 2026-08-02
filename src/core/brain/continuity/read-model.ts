/**
 * Continuity read-model (Memory Observability Suite kernel).
 *
 * The normalization layer between the raw JSONL continuity store and the
 * read-side consumers that go through it. It absorbs four concerns
 * exactly once so those consumers cannot disagree on them:
 *
 *   - schema-version dispatch: records written before the stamp
 *     existed carry no `schema` field and read as v1 (`legacy: true`);
 *   - masking policy: `private` records are DROPPED by default and
 *     kept only on explicit request; payload text is already
 *     redaction-masked at write time and is never un-masked here;
 *   - declared scope: a record whose author declared a scope is retained
 *     only for a filter that asks for that scope, so a declaration can
 *     never widen what an existing caller already sees (t_77efc212);
 *   - fail-soft reads: malformed rows normalize to null and unknown
 *     kinds stay readable (the evolution rule is additive).
 *
 * It is NOT the only door onto the store, and the docblock used to imply
 * it was. Four modules read through here; twenty call
 * `listContinuityRecords` directly and see raw records with none of the
 * above applied. `tests/core/brain/continuity/reader-census.test.ts`
 * holds both lists and fails when either changes; auditing the direct
 * readers is a separate task, by design.
 *
 * Read-only by construction - this module never writes to the store.
 */

import { listContinuityRecords } from "./store.ts";
import {
  CONTINUITY_AGENT_ID_KEY,
  CONTINUITY_SCHEMA_VERSION,
  CONTINUITY_SESSION_ID_KEY,
  CONTINUITY_TURN_ID_KEY,
} from "./types.ts";

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
  /**
   * Scope the record's author declared, absent when none was declared.
   * Kept as a plain string rather than the write-side union: a token from
   * a newer version stays readable here (and stays excluded from every
   * filter that did not name it) instead of being lost as malformed.
   */
  readonly scope?: string;
  /** Correlation ids lifted out of the payload when present. */
  readonly sessionId?: string;
  readonly turnId?: string;
  /** Authoring agent id lifted out of the payload when present (t_5be0654d). */
  readonly agentId?: string;
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
  /**
   * Retain records declaring this scope. Records that declare NO scope
   * are unaffected and always retained - that is the whole of today's
   * behaviour. Records declaring any other scope stay excluded, so this
   * is a widening request for one named scope and never a blanket one.
   * Independent of {@link ContinuityReadModelFilter.keepPrivate}: asking
   * for a scope is not a way around the masking drop.
   */
  readonly scope?: string;
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
  const sessionId = readString(payload[CONTINUITY_SESSION_ID_KEY]);
  const turnId = readString(payload[CONTINUITY_TURN_ID_KEY]);
  const agentId = readString(payload[CONTINUITY_AGENT_ID_KEY]);
  const handoff = isPlainObject(payload["handoff"]) ? payload["handoff"] : undefined;
  const handoffKind = handoff !== undefined ? readString(handoff["kind"]) : undefined;
  const handoffRef = handoff !== undefined ? readString(handoff["ref"]) : undefined;
  // A non-string `scope` is not a declaration - junk must read as absent
  // rather than as "declared something", which would hide the record
  // from every filter at once.
  const scope = readString(record["scope"]);
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
    ...(scope !== undefined ? { scope } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(turnId !== undefined ? { turnId } : {}),
    ...(agentId !== undefined ? { agentId } : {}),
    ...(handoffKind !== undefined ? { handoffKind } : {}),
    ...(handoffRef !== undefined ? { handoffRef } : {}),
  });
}

/**
 * Load, normalize, and filter the whole store. Private records drop
 * unless kept; a record declaring a scope drops unless that exact scope
 * was requested. An unscoped record - every record any writer produces
 * today - passes both gates untouched.
 */
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
    if (entry.scope !== undefined && entry.scope !== filter.scope) continue;
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
