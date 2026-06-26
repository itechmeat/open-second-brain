/**
 * Event → context-trace join reader.
 *
 * The Brain log (`Brain/log/<date>.md` + JSONL sidecar) records WHAT
 * happened; the continuity store (`Brain/log/continuity/<month>.jsonl`)
 * records WHICH CONTEXT was supplied to those operations. The two
 * surfaces are written independently and, until now, were read
 * independently — an operator asking "why did the agent do this?" had
 * to query the log, copy a correlation id, and then query each
 * continuity reader by hand.
 *
 * This module is the single reader that joins them: given a selector
 * for one (or several) logged events, it resolves the continuity
 * records attached to each via the stable correlation ids the
 * observability contract already guarantees (`docs/observability.md`
 * §Correlation IDs):
 *
 *   - `session_id` — the cross-surface session join. Log events written
 *     by the write-session chokepoint and session-lifecycle capture
 *     carry `session_id` in their body; recall_telemetry /
 *     context_receipt / session_turn / generation_report payloads carry
 *     the same id (lifted to `sessionId` by the read-model).
 *   - `turn_id`    — the finer within-session join.
 *   - artifact refs — wikilinks / vault paths in the event body (e.g.
 *     `apply-evidence`'s `artifact`, write-session's `target`) matched
 *     against a record's `sourceRefs[].id` / `.path` (or the record id
 *     itself when the body links a continuity id directly).
 *
 * Read-only and fail-soft by construction: it composes `readLogDay`
 * (tolerant shard merge) and `loadNormalizedContinuityRecords` (schema
 * dispatch + masking policy), so it inherits their guarantees — malformed
 * rows are skipped, unknown kinds stay readable, and `private` records
 * are dropped unless explicitly kept. It never writes to either surface.
 */

import { readLogDay } from "./log-jsonl.ts";
import type { BrainLogEntry, BrainLogEntryPayload } from "./log.ts";
import { loadNormalizedContinuityRecords } from "./continuity/read-model.ts";
import type { NormalizedContinuityRecord } from "./continuity/read-model.ts";
import { validateIsoDate } from "./paths.ts";
import { BRAIN_LOG_EVENT_KIND_SET, type BrainLogEventKind } from "./types.ts";

/**
 * A selector-validation failure: a bad `--date` / `--at` / `--kind`, detected
 * BEFORE any IO. Entry points map this to a usage error (CLI exit 2 / MCP
 * `INVALID_PARAMS`); ANY OTHER throw from {@link resolveLogEventTraces} is a
 * runtime IO failure (e.g. an existing-but-unreadable log dir: EACCES / EIO /
 * ENOTDIR) and must surface as a runtime error (CLI exit 1 / MCP
 * `INTERNAL_ERROR`), never as a usage error. (t_27ea0daa)
 */
export class EventTraceSelectorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EventTraceSelectorError";
  }
}

/** Why a continuity record was attached to a given log event. */
export type TraceJoinReason = "session" | "turn" | "artifact";

/** Body keys whose values are treated as artifact references. */
const ARTIFACT_BODY_KEYS = Object.freeze([
  "artifact",
  "target",
  "preference",
  "signal",
  "source",
  "note_ref",
  "ref",
]);

const WIKILINK_RE = /\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g;

export interface EventTraceSelector {
  /** Log day to read (`YYYY-MM-DD`, UTC). Defaults to today when omitted. */
  readonly date?: string;
  /** Pin a single event by its `HH:MM:SS` UTC stamp. */
  readonly at?: string;
  /** Restrict to one event kind. */
  readonly kind?: BrainLogEventKind;
  /** Restrict to events bound to this session id. */
  readonly sessionId?: string;
  /** Cap the number of events returned (after filtering). */
  readonly limit?: number;
  /** Keep continuity records flagged `private` (default: drop them). */
  readonly keepPrivate?: boolean;
}

/** One continuity record attached to a log event, with the join provenance. */
export interface AttachedTrace {
  readonly id: string;
  readonly kind: string;
  readonly createdAt: string;
  /** Distinct join reasons that matched, in fixed order session→turn→artifact. */
  readonly joinedBy: ReadonlyArray<TraceJoinReason>;
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly handoffKind?: string;
  readonly handoffRef?: string;
  readonly sourceCount: number;
  readonly private: boolean;
  readonly redacted: boolean;
}

/** Correlation ids lifted out of a log event body. */
export interface EventCorrelation {
  readonly sessionId?: string;
  readonly turnId?: string;
  /** Distinct artifact identifiers (wikilink targets + path/id-shaped values). */
  readonly artifacts: ReadonlyArray<string>;
}

export interface LogEventTrace {
  readonly event: {
    readonly timestamp: string;
    readonly eventType: string;
    readonly agent?: string;
    readonly sessionId?: string;
    readonly turnId?: string;
    readonly artifacts: ReadonlyArray<string>;
    readonly body: BrainLogEntryPayload;
  };
  readonly traces: ReadonlyArray<AttachedTrace>;
  readonly traceCount: number;
}

/**
 * Extract the join keys from a single log entry body. Pure and
 * defensive: it never throws on an odd payload shape.
 */
export function extractEventCorrelation(event: BrainLogEntry): EventCorrelation {
  const body = event.body;
  const sessionId = readBodyString(body["session_id"]);
  const turnId = readBodyString(body["turn_id"]);
  const artifacts = new Set<string>();
  for (const key of ARTIFACT_BODY_KEYS) {
    collectArtifacts(body[key], artifacts);
  }
  return {
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(turnId !== undefined ? { turnId } : {}),
    artifacts: Object.freeze([...artifacts]),
  };
}

/**
 * Compute the continuity records attached to one event, given the
 * already-normalized store. Returned records are sorted by
 * (createdAt, id) — the same stable order the store guarantees.
 */
export function attachTracesToEvent(
  records: ReadonlyArray<NormalizedContinuityRecord>,
  correlation: EventCorrelation,
): ReadonlyArray<AttachedTrace> {
  const artifactSet = new Set(correlation.artifacts);
  const attached: AttachedTrace[] = [];
  for (const record of records) {
    const reasons = joinReasons(record, correlation, artifactSet);
    if (reasons.length === 0) continue;
    attached.push({
      id: record.id,
      kind: record.kind,
      createdAt: record.createdAt,
      joinedBy: reasons,
      ...(record.sessionId !== undefined ? { sessionId: record.sessionId } : {}),
      ...(record.turnId !== undefined ? { turnId: record.turnId } : {}),
      ...(record.handoffKind !== undefined ? { handoffKind: record.handoffKind } : {}),
      ...(record.handoffRef !== undefined ? { handoffRef: record.handoffRef } : {}),
      sourceCount: record.sourceRefs.length,
      private: record.private,
      redacted: record.redacted,
    });
  }
  attached.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  return Object.freeze(attached);
}

/**
 * Resolve logged events for `selector.date` and attach the continuity
 * trace to each. Events are returned in log order (timestamp, then
 * shard/line) after filtering; an event with no attached records is
 * still returned with an empty `traces` list so the operator sees that
 * the join produced nothing rather than that the event is missing.
 */
export function resolveLogEventTraces(
  vault: string,
  selector: EventTraceSelector = {},
): ReadonlyArray<LogEventTrace> {
  const date = selector.date !== undefined ? validateSelectorDate(selector.date) : todayUtc();
  if (selector.at !== undefined && !/^\d{2}:\d{2}:\d{2}$/.test(selector.at)) {
    throw new EventTraceSelectorError(
      `event-trace: --at must be HH:MM:SS (UTC); got ${JSON.stringify(selector.at)}`,
    );
  }
  if (selector.kind !== undefined && !BRAIN_LOG_EVENT_KIND_SET.has(selector.kind)) {
    throw new EventTraceSelectorError(`event-trace: unknown event kind '${selector.kind}'`);
  }

  const { entries } = readLogDay(vault, date);
  const records = loadNormalizedContinuityRecords(
    vault,
    selector.keepPrivate === true ? { keepPrivate: true } : {},
  );

  const wantStamp = selector.at !== undefined ? `${date}T${selector.at}Z` : undefined;
  // Cap is evaluated BEFORE the push, so `limit: 0` yields an empty list and a
  // limit of N never collects N+1 events (the cap is the count returned, not
  // the count plus one).
  const cap = selector.limit !== undefined ? Math.max(0, Math.floor(selector.limit)) : undefined;
  const results: LogEventTrace[] = [];
  for (const entry of entries) {
    if (selector.kind !== undefined && entry.eventType !== selector.kind) continue;
    if (wantStamp !== undefined && entry.timestamp !== wantStamp) continue;
    const correlation = extractEventCorrelation(entry);
    if (selector.sessionId !== undefined && correlation.sessionId !== selector.sessionId) continue;
    if (cap !== undefined && results.length >= cap) break;
    const traces = attachTracesToEvent(records, correlation);
    results.push({
      event: {
        timestamp: entry.timestamp,
        eventType: entry.eventType,
        ...(entry.agent !== undefined ? { agent: entry.agent } : {}),
        ...(correlation.sessionId !== undefined ? { sessionId: correlation.sessionId } : {}),
        ...(correlation.turnId !== undefined ? { turnId: correlation.turnId } : {}),
        artifacts: correlation.artifacts,
        body: entry.body,
      },
      traces,
      traceCount: traces.length,
    });
  }
  return Object.freeze(results);
}

// ----- internals ------------------------------------------------------------

function joinReasons(
  record: NormalizedContinuityRecord,
  correlation: EventCorrelation,
  artifactSet: ReadonlySet<string>,
): ReadonlyArray<TraceJoinReason> {
  const reasons: TraceJoinReason[] = [];
  if (correlation.sessionId !== undefined && record.sessionId === correlation.sessionId) {
    reasons.push("session");
  }
  if (correlation.turnId !== undefined && record.turnId === correlation.turnId) {
    reasons.push("turn");
  }
  if (artifactSet.size > 0 && recordMatchesArtifact(record, artifactSet)) {
    reasons.push("artifact");
  }
  return reasons;
}

function recordMatchesArtifact(
  record: NormalizedContinuityRecord,
  artifactSet: ReadonlySet<string>,
): boolean {
  if (artifactSet.has(record.id)) return true;
  for (const ref of record.sourceRefs) {
    const id = ref["id"];
    if (typeof id === "string" && artifactSet.has(id)) return true;
    const path = ref["path"];
    if (typeof path === "string" && artifactSet.has(path)) return true;
  }
  return false;
}

function collectArtifacts(value: unknown, out: Set<string>): void {
  if (typeof value === "string") {
    addArtifactToken(value, out);
  } else if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === "string") addArtifactToken(item, out);
    }
  }
}

function addArtifactToken(raw: string, out: Set<string>): void {
  const value = raw.trim();
  if (value.length === 0) return;
  let sawWikilink = false;
  for (const match of value.matchAll(WIKILINK_RE)) {
    const inner = match[1]?.trim();
    if (inner) {
      out.add(inner);
      // A wikilink target may itself be a vault path (`Brain/foo.md`);
      // its basename without extension is the artifact id most readers use.
      const base = basenameNoExt(inner);
      if (base !== inner) out.add(base);
      sawWikilink = true;
    }
  }
  if (sawWikilink) return;
  // Bare path or id-shaped value (no wikilink syntax). Record both the
  // raw value and its basename so a `target: Brain/x.md` body joins a
  // sourceRef carrying either form.
  out.add(value);
  const base = basenameNoExt(value);
  if (base !== value) out.add(base);
}

function basenameNoExt(value: string): string {
  const slash = value.lastIndexOf("/");
  const tail = slash >= 0 ? value.slice(slash + 1) : value;
  return tail.endsWith(".md") ? tail.slice(0, -3) : tail;
}

function readBodyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Validate the `--date` selector. `validateIsoDate` throws a generic `Error`;
 * re-tag a bad date as a selector error so callers route it to the usage path,
 * not the runtime-failure path. (t_27ea0daa)
 */
function validateSelectorDate(date: string): string {
  try {
    return validateIsoDate(date);
  } catch (err) {
    throw new EventTraceSelectorError((err as Error).message);
  }
}
