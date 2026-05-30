import { join } from "node:path";

import { appendAuditRecord } from "../reliability/audit.ts";
import { appendLogEvent } from "./log.ts";
import { brainDirs } from "./paths.ts";
import { buildDedupIndex, computeDedupHash, type DedupIndexEntry } from "./dedup-hash.ts";
import { discoverMarkersDetailed } from "./inline.ts";
import { writeSignal } from "./signal.ts";
import { isoDate, isoSecond } from "./time.ts";
import { BRAIN_LOG_EVENT_KIND, BRAIN_SIGNAL_SOURCE_TYPE } from "./types.ts";
import { validateBrainFeedbackInput } from "./sessions/validate-feedback.ts";

export interface CaptureSessionLifecycleOptions {
  readonly agent: string;
  readonly now?: Date;
  readonly dryRun?: boolean;
}

export interface CaptureSessionLifecycleResult {
  readonly event: string;
  readonly session_id?: string;
  readonly signals_created: number;
  readonly signals_deduped: number;
  readonly tool_replays: number;
  readonly malformed: number;
  readonly audit_path: string;
  readonly log_path?: string;
}

interface NormalizedPayload {
  readonly event: string;
  readonly sessionId?: string;
  readonly promptText?: string;
  readonly toolName?: string;
  readonly toolInput?: unknown;
  readonly malformed: number;
}

export async function captureSessionLifecycleEvent(
  vault: string,
  payload: unknown,
  opts: CaptureSessionLifecycleOptions,
): Promise<CaptureSessionLifecycleResult> {
  const now = opts.now ?? new Date();
  const normalized = normalizePayload(payload);
  let dedup: Map<string, DedupIndexEntry> | undefined;
  const ensureDedup = (): Map<string, DedupIndexEntry> => {
    dedup ??= buildDedupIndex(vault);
    return dedup;
  };
  const counters = {
    signals_created: 0,
    signals_deduped: 0,
    tool_replays: 0,
    malformed: normalized.malformed,
  };

  if (normalized.promptText !== undefined) {
    captureMarkers(vault, normalized, normalized.promptText, opts, now, ensureDedup(), counters);
  }

  if (normalized.toolName === "brain_feedback") {
    captureToolFeedback(vault, normalized, opts, now, ensureDedup(), counters);
  }

  let logPath: string | undefined;
  if (!opts.dryRun) {
    logPath = appendLifecycleLog(vault, normalized, opts.agent, now, counters);
  }

  const auditPath = appendAuditRecord(join(brainDirs(vault).log, "session-lifecycle"), {
    timestamp: now.toISOString(),
    actor: opts.agent,
    action: "session_lifecycle_capture",
    target: "Brain/session-lifecycle",
    ok: true,
    details: {
      event: normalized.event,
      ...(normalized.sessionId ? { session_id: normalized.sessionId } : {}),
      dry_run: opts.dryRun === true,
      ...counters,
    },
  });

  return {
    event: normalized.event,
    ...(normalized.sessionId ? { session_id: normalized.sessionId } : {}),
    signals_created: counters.signals_created,
    signals_deduped: counters.signals_deduped,
    tool_replays: counters.tool_replays,
    malformed: counters.malformed,
    audit_path: auditPath,
    ...(logPath ? { log_path: logPath } : {}),
  };
}

function normalizePayload(payload: unknown): NormalizedPayload {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { event: "unknown", malformed: 1 };
  }
  const record = payload as Record<string, unknown>;
  const event =
    readNonEmptyString(record["hook_event_name"]) ??
    readNonEmptyString(record["event"]) ??
    "unknown";
  const sessionId = readNonEmptyString(record["session_id"]);
  return {
    event,
    ...(sessionId ? { sessionId } : {}),
    ...(extractPromptText(record) ? { promptText: extractPromptText(record)! } : {}),
    ...(readNonEmptyString(record["tool_name"])
      ? { toolName: readNonEmptyString(record["tool_name"])! }
      : {}),
    ...("tool_input" in record ? { toolInput: record["tool_input"] } : {}),
    malformed: 0,
  };
}

function extractPromptText(record: Record<string, unknown>): string | undefined {
  const direct = readNonEmptyString(record["prompt"]);
  if (direct) return direct;
  const message = record["message"];
  if (typeof message === "string" && message.trim().length > 0) return message;
  if (message !== null && typeof message === "object") {
    const content = (message as Record<string, unknown>)["content"];
    if (typeof content === "string" && content.trim().length > 0) return content;
  }
  return undefined;
}

function captureMarkers(
  vault: string,
  payload: NormalizedPayload,
  text: string,
  opts: CaptureSessionLifecycleOptions,
  now: Date,
  dedup: Map<string, DedupIndexEntry>,
  counters: MutableCounters,
): void {
  const discovery = discoverMarkersDetailed(text);
  counters.malformed += discovery.malformed;
  for (const marker of discovery.markers) {
    const dedupHash = computeDedupHash({
      topic: marker.topic,
      signal: marker.signal,
      principle: marker.principle,
      ...(marker.scope ? { scope: marker.scope } : {}),
    });
    emitSignal(vault, payload, opts, now, dedup, counters, {
      topic: marker.topic,
      signal: marker.signal,
      principle: marker.principle,
      ...(marker.scope ? { scope: marker.scope } : {}),
      agent: marker.agent ?? opts.agent,
      ...(marker.note ? { raw: marker.note } : {}),
      dedupHash,
    });
  }
}

function captureToolFeedback(
  vault: string,
  payload: NormalizedPayload,
  opts: CaptureSessionLifecycleOptions,
  now: Date,
  dedup: Map<string, DedupIndexEntry>,
  counters: MutableCounters,
): void {
  const validated = validateBrainFeedbackInput(payload.toolInput);
  if (!validated.ok) {
    counters.malformed++;
    return;
  }
  counters.tool_replays++;
  const input = validated.value;
  const dedupHash = computeDedupHash({
    topic: input.topic,
    signal: input.signal,
    principle: input.principle,
    ...(input.scope ? { scope: input.scope } : {}),
  });
  emitSignal(vault, payload, opts, now, dedup, counters, {
    topic: input.topic,
    signal: input.signal,
    principle: input.principle,
    ...(input.scope ? { scope: input.scope } : {}),
    agent: input.agent ?? opts.agent,
    ...(input.raw ? { raw: input.raw } : {}),
    dedupHash,
  });
}

interface SignalPayload {
  readonly topic: string;
  readonly signal: "positive" | "negative";
  readonly principle: string;
  readonly scope?: string;
  readonly agent: string;
  readonly raw?: string;
  readonly dedupHash: string;
}

interface MutableCounters {
  signals_created: number;
  signals_deduped: number;
  tool_replays: number;
  malformed: number;
}

function emitSignal(
  vault: string,
  payload: NormalizedPayload,
  opts: CaptureSessionLifecycleOptions,
  now: Date,
  dedup: Map<string, DedupIndexEntry>,
  counters: MutableCounters,
  signal: SignalPayload,
): void {
  if (dedup.has(signal.dedupHash)) {
    counters.signals_deduped++;
    return;
  }
  if (opts.dryRun) return;
  const sessionRef = sessionReference(payload);
  const result = writeSignal(vault, {
    topic: signal.topic,
    signal: signal.signal,
    agent: signal.agent,
    principle: signal.principle,
    created_at: isoSecond(now),
    date: isoDate(now),
    slug: signal.topic,
    ...(signal.scope ? { scope: signal.scope } : {}),
    source: [`[[${sessionRef}]]`],
    source_type: BRAIN_SIGNAL_SOURCE_TYPE.session,
    dedup_hash: signal.dedupHash,
    session_ref: sessionRef,
    ...(signal.raw ? { raw: signal.raw } : {}),
  });
  dedup.set(signal.dedupHash, { id: result.id, path: result.path });
  counters.signals_created++;
}

function appendLifecycleLog(
  vault: string,
  payload: NormalizedPayload,
  agent: string,
  now: Date,
  counters: MutableCounters,
): string {
  return appendLogEvent(vault, {
    timestamp: isoSecond(now),
    eventType: BRAIN_LOG_EVENT_KIND.sessionLifecycle,
    body: {
      agent,
      event: payload.event,
      ...(payload.sessionId ? { session_id: payload.sessionId } : {}),
      signals_created: String(counters.signals_created),
      signals_deduped: String(counters.signals_deduped),
      tool_replays: String(counters.tool_replays),
      malformed: String(counters.malformed),
    },
  }).logPath;
}

function sessionReference(payload: NormalizedPayload): string {
  return `session:${payload.sessionId ?? "unknown"}#${payload.event}`;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
