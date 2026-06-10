import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

import { appendAuditRecord } from "../reliability/audit.ts";
import { appendLogEvent } from "./log.ts";
import { brainDirs } from "./paths.ts";
import { buildCaptureBoundary, type SessionCaptureDecision } from "./capture-boundary.ts";
import { extractFacts, routeExtractedFacts } from "./fact-extract.ts";
import { buildDedupIndex, computeDedupHash, type DedupIndexEntry } from "./dedup-hash.ts";
import { discoverMarkersDetailed } from "./inline.ts";
import { writeSignal } from "./signal.ts";
import { isoDate, isoSecond } from "./time.ts";
import { BRAIN_LOG_EVENT_KIND, BRAIN_SIGNAL_SOURCE_TYPE } from "./types.ts";
import { validateBrainFeedbackInput } from "./sessions/validate-feedback.ts";
import { resolveSearchConfig } from "../search/index.ts";
import { clearSessionFocus, sessionFocusPath } from "../search/session-focus.ts";
import { resolveSessionHandoff } from "../config.ts";
import { writeHandoffNote, type HandoffNoteResult } from "./handoff.ts";
import { detectAdapter } from "./sessions/registry.ts";
import type { SessionTurn } from "./sessions/types.ts";
import { readLineageLedger, recordLineageObservation } from "./lineage/ledger.ts";
import { resolveSessionLineage } from "./lineage/resolve.ts";
import { isCompressionEvidenceEvent, type SessionLineage } from "./lineage/types.ts";
import { refreshAnticipatoryCache } from "./anticipatory-cache.ts";

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
  /** Capture-boundary verdict for this event (Memory Integrity Suite). */
  readonly boundary_decision: SessionCaptureDecision;
  /** Messages whose text was suppressed before any extraction. */
  readonly suppressed_messages: number;
  readonly facts_extracted: number;
  readonly facts_deduped: number;
  readonly audit_path: string;
  readonly log_path?: string;
  /** True when a SessionEnd event cleared that session's bound focus. */
  readonly focus_cleared?: boolean;
  /** Path of the handoff note a SessionEnd event produced (gated). */
  readonly handoff_path?: string;
  /**
   * Session lineage when the session is part of a compression chain
   * (continuity-hygiene-freshness suite). Absent for flat sessions so
   * the pre-lineage result shape stays byte-identical.
   */
  readonly lineage?: SessionLineage;
}

interface NormalizedPayload {
  readonly event: string;
  readonly sessionId?: string;
  readonly transcriptPath?: string;
  readonly promptText?: string;
  readonly toolName?: string;
  readonly toolInput?: unknown;
  readonly cwd?: string;
  readonly parentSessionId?: string;
  readonly rootSessionId?: string;
  readonly compressionDepth?: number;
  /** SessionStart discriminator (`startup|resume|clear|compact`). */
  readonly sessionStartSource?: string;
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
    suppressed_messages: 0,
    facts_extracted: 0,
    facts_deduped: 0,
  };

  // Capture boundary (Memory Integrity Suite): classify FIRST, before
  // any extraction. Ignored sessions produce nothing but the audit
  // row; stateless sessions read but never write; suppressed message
  // text never reaches marker or fact extraction.
  const boundary = buildCaptureBoundary(vault);
  const decision = boundary.sessionDecision(normalized.sessionId, normalized.transcriptPath);
  const mayWrite = decision === "capture";

  // Session lineage (continuity-hygiene-freshness): resolve BEFORE
  // recording this session's own ledger observation - the crutch
  // treats prior unlinked history as proof of a parallel session.
  // Read-only resolution runs for every session; the ledger only
  // grows for captured, non-dry runs. Fail-soft throughout.
  let lineage: SessionLineage | undefined;
  if (normalized.sessionId !== undefined) {
    try {
      lineage = resolveSessionLineage(
        {
          sessionId: normalized.sessionId,
          ...(normalized.parentSessionId !== undefined
            ? { parentSessionId: normalized.parentSessionId }
            : {}),
          ...(normalized.rootSessionId !== undefined
            ? { rootSessionId: normalized.rootSessionId }
            : {}),
          ...(normalized.compressionDepth !== undefined
            ? { compressionDepth: normalized.compressionDepth }
            : {}),
          ...(normalized.cwd !== undefined ? { cwd: normalized.cwd } : {}),
        },
        { ledger: readLineageLedger(vault), nowMs: now.getTime() },
      );
      if (mayWrite && !opts.dryRun) {
        recordLineageObservation(vault, {
          sessionId: normalized.sessionId,
          at: now.toISOString(),
          ...(normalized.cwd !== undefined ? { cwd: normalized.cwd } : {}),
          event: normalized.event,
          ...(isCompressionEvidenceEvent(normalized.event, normalized.sessionStartSource)
            ? { compressionEvidence: true }
            : {}),
          ...(lineage.source !== "flat" ? { lineage } : {}),
        });
      }
    } catch {
      lineage = undefined; // lineage is an enhancement, never a blocker
    }
  }
  const chainLineage = lineage !== undefined && lineage.source !== "flat" ? lineage : undefined;

  let promptText = normalized.promptText;
  if (mayWrite && promptText !== undefined && boundary.suppressMessage(promptText)) {
    counters.suppressed_messages++;
    promptText = undefined;
  }

  if (mayWrite && promptText !== undefined) {
    captureMarkers(vault, normalized, promptText, opts, now, ensureDedup(), counters);
    // Fact extraction runs strictly AFTER the boundary: only captured,
    // unsuppressed user text reaches the pattern table.
    const routed = routeExtractedFacts(vault, {
      facts: extractFacts(promptText),
      agent: opts.agent,
      now,
      sessionRef: sessionReference(normalized),
      dedup: ensureDedup(),
      ...(opts.dryRun ? { dryRun: true } : {}),
    });
    counters.facts_extracted += routed.created;
    counters.facts_deduped += routed.deduped;
  }

  if (mayWrite && normalized.toolName === "brain_feedback") {
    captureToolFeedback(vault, normalized, opts, now, ensureDedup(), counters);
  }

  // Session-scoped focus lifecycle (Agent Surface Suite, t_5b478e47):
  // a finished session's bound focus must not leak into the next one.
  // Deliberately NOT gated on the capture boundary (unlike the handoff
  // below): removing the session's own steering state is cleanup, not
  // memory capture, so it applies even for stateless sessions.
  // Fail-soft - focus cleanup can never block lifecycle capture.
  let focusCleared = false;
  if (normalized.event === "SessionEnd" && normalized.sessionId !== undefined && !opts.dryRun) {
    try {
      const searchConfig = resolveSearchConfig({ vault });
      // Clear by file presence, not by activity: an already-expired
      // focus file is still stale state worth removing.
      if (existsSync(sessionFocusPath(searchConfig, normalized.sessionId))) {
        clearSessionFocus(searchConfig, normalized.sessionId);
        focusCleared = true;
      }
    } catch {
      // ignore - lifecycle capture must survive a broken search config
    }
  }

  // Handoff note on SessionEnd (Agent Surface Suite, t_28afa4d2):
  // gated by the session_handoff config key (default off) and the
  // capture boundary; reads the recorded transcript through the
  // session adapters. Fail-soft like the rest of lifecycle capture.
  let handoffPath: string | undefined;
  if (
    normalized.event === "SessionEnd" &&
    normalized.transcriptPath !== undefined &&
    mayWrite &&
    !opts.dryRun &&
    resolveSessionHandoff()
  ) {
    try {
      handoffPath = (await writeHandoffNoteFromTranscript(vault, normalized, opts.agent, now))
        ?.path;
    } catch {
      // ignore - a malformed transcript never blocks lifecycle capture
    }
  }

  // Anticipatory context cache (continuity-hygiene-freshness,
  // t_4cee9df5): piggyback on events that already fire - no daemon, no
  // watcher. TTL debounce lives inside the refresh; suppressed prompt
  // text never reaches the cache (promptText is already cleared above).
  if (
    mayWrite &&
    !opts.dryRun &&
    normalized.sessionId !== undefined &&
    (normalized.event === "UserPromptSubmit" || normalized.event === "PostToolUse")
  ) {
    try {
      refreshAnticipatoryCache(vault, {
        sessionId: normalized.sessionId,
        ...(promptText !== undefined ? { signalText: promptText } : {}),
        now,
      });
    } catch {
      // The cache is an enhancement, never a capture blocker.
    }
  }

  let logPath: string | undefined;
  if (mayWrite && !opts.dryRun) {
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
      boundary_decision: decision,
      ...(chainLineage !== undefined
        ? {
            lineage_root: chainLineage.rootId,
            ...(chainLineage.parentId !== null ? { lineage_parent: chainLineage.parentId } : {}),
            lineage_depth: chainLineage.depth,
            lineage_source: chainLineage.source,
          }
        : {}),
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
    boundary_decision: decision,
    suppressed_messages: counters.suppressed_messages,
    facts_extracted: counters.facts_extracted,
    facts_deduped: counters.facts_deduped,
    audit_path: auditPath,
    ...(logPath ? { log_path: logPath } : {}),
    ...(focusCleared ? { focus_cleared: true } : {}),
    ...(handoffPath !== undefined ? { handoff_path: handoffPath } : {}),
    ...(chainLineage !== undefined ? { lineage: chainLineage } : {}),
  };
}

/**
 * Read the recorded transcript via the session adapters and write a
 * handoff note. Trust model: `transcript_path` is produced by the host
 * runtime itself (Claude Code / Hermes hand their own transcript path
 * to their own hook); it is not user-typed input, which is why no
 * inside-vault check applies - transcripts live in host directories.
 */
async function writeHandoffNoteFromTranscript(
  vault: string,
  normalized: NormalizedPayload,
  agent: string,
  now: Date,
): Promise<HandoffNoteResult | null> {
  const path = normalized.transcriptPath!;
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8");
  const nl = text.indexOf("\n");
  const adapter = detectAdapter(nl < 0 ? text : text.slice(0, nl));
  if (adapter === null) return null;
  const turns: SessionTurn[] = [];
  for await (const turn of adapter.iterate(path)) turns.push(turn);
  if (turns.length === 0) return null;
  return writeHandoffNote(vault, {
    turns,
    sessionId: normalized.sessionId ?? basename(path),
    agent,
    now,
    sourcePaths: [path],
  });
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
  const transcriptPath = readNonEmptyString(record["transcript_path"]);
  const cwd = readNonEmptyString(record["cwd"]);
  const parentSessionId = readNonEmptyString(record["parent_session_id"]);
  const rootSessionId = readNonEmptyString(record["root_session_id"]);
  const compressionDepthRaw = record["compression_depth"];
  const compressionDepth =
    typeof compressionDepthRaw === "number" &&
    Number.isInteger(compressionDepthRaw) &&
    compressionDepthRaw >= 0
      ? compressionDepthRaw
      : undefined;
  const sessionStartSource = readNonEmptyString(record["source"]);
  return {
    event,
    ...(sessionId ? { sessionId } : {}),
    ...(transcriptPath ? { transcriptPath } : {}),
    ...(cwd ? { cwd } : {}),
    ...(parentSessionId ? { parentSessionId } : {}),
    ...(rootSessionId ? { rootSessionId } : {}),
    ...(compressionDepth !== undefined ? { compressionDepth } : {}),
    ...(sessionStartSource ? { sessionStartSource } : {}),
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
  suppressed_messages: number;
  facts_extracted: number;
  facts_deduped: number;
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
      suppressed_messages: String(counters.suppressed_messages),
      facts_extracted: String(counters.facts_extracted),
      facts_deduped: String(counters.facts_deduped),
    },
  }).logPath;
}

function sessionReference(payload: NormalizedPayload): string {
  return `session:${payload.sessionId ?? "unknown"}#${payload.event}`;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
