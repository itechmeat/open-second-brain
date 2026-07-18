/**
 * Session-import orchestrator (§16).
 *
 * Public surface:
 *
 *   - {@link importSession} — single-file import. Returns per-file
 *     counters and the resolved adapter id.
 *   - {@link importSessionPath} — convenience wrapper that walks a
 *     directory, calling importSession on every `*.jsonl` inside.
 *     Files whose autodetect fails surface as `warnings` rather than
 *     killing the run; valid files still get processed.
 *
 * Extraction pipeline per turn:
 *
 *   1. `discoverMarkers(turn.text)` → for each marker, build a
 *      payload via {@link computeDedupHash}; create a signal with
 *      `source_type: 'session'` unless the hash already exists in
 *      `Brain/inbox/` or `processed/`.
 *   2. For each `tool_use` block named `brain_feedback`: validate
 *      input via {@link validateBrainFeedbackInput}, compute the
 *      same hash; dedup-check; create signal.
 *
 * Idempotency: dedup index is built once at the start of each
 * `importSession` run by reading the inbox and processed dirs. A
 * second run on the same file finds every hash already present.
 */

import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import { buildDedupIndex, computeDedupHash, type DedupIndexEntry } from "../dedup-hash.ts";
import { appendContinuityRecord } from "../continuity/store.ts";
import { discoverMarkersDetailed, isFeedbackMarker } from "../inline.ts";
import { writeSignal } from "../signal.ts";
import { importSessionRecall } from "../session-recall.ts";
import { isoDate, isoSecond } from "../time.ts";
import { BRAIN_SIGNAL_SOURCE_TYPE } from "../types.ts";
import { detectAdapter, getAdapter } from "./registry.ts";
import {
  SessionImportError,
  type SessionAdapter,
  type SessionAdapterId,
  type SessionToolCall,
  type SessionTurn,
} from "./types.ts";
import { validateBrainFeedbackInput } from "./validate-feedback.ts";
import { buildCaptureBoundary, type SessionCaptureDecision } from "../capture-boundary.ts";
import { extractFacts, routeExtractedFacts } from "../fact-extract.ts";
import { readLineageLedger } from "../lineage/ledger.ts";
import { resolveSessionLineage } from "../lineage/resolve.ts";
import type { SessionLineage } from "../lineage/types.ts";

export interface ImportSessionOptions {
  /** Agent identity stamped on signals when the turn has no own agent. */
  readonly agent: string;
  /** Force a specific adapter, bypassing autodetect. */
  readonly format?: SessionAdapterId;
  /** ISO timestamp — process only turns at or after this. */
  readonly since?: Date;
  /** When true, don't write any signal. Counters still populate. */
  readonly dryRun?: boolean;
  /** Wall clock for stamping `created_at`. Tests pin this. */
  readonly now?: Date;
  /**
   * Optional pre-built dedup index. When importing a directory of
   * session files, the orchestrator builds the index once and
   * threads it through every per-file call so the inbox isn't
   * re-scanned per file. Internal contract; CLI does not pass it.
   */
  readonly dedupIndex?: Map<string, DedupIndexEntry>;
  /**
   * Vault portability suite (v0.22.0). When true, session-imported
   * signals store their raw body through the deterministic codec
   * (`writeSignal({ rawCodec: true })`). Default off -> verbatim bodies.
   */
  readonly rawCodec?: boolean;
  /** When true, also store normalized turns in the continuity-backed session recall DAG. */
  readonly recall?: boolean;
  readonly recallSessionId?: string;
  readonly recallSummaryGroupSize?: number;
  /**
   * Lineage of the imported segment (continuity-hygiene-freshness
   * suite). When omitted, a link persisted in the lineage ledger for
   * the recall session id is used; flat sessions import unchanged.
   */
  readonly recallLineage?: SessionLineage;
  /** Optional ingest scope label stamped into imported signal notes. */
  readonly ingestScope?: string;
  /** Optional role filter for write-side extraction. */
  readonly filterRoles?: ReadonlyArray<SessionTurn["role"]>;
  /** Optional case-insensitive substring filter on turn text. */
  readonly filterTextIncludes?: string;
  /**
   * Per-row event-time backfill (A2 / t_7526e8d3). When true, each
   * emitted signal is stamped with its turn's ORIGINAL
   * `SessionTurn.timestamp` (`created_at` / `recorded_at` / `valid_from`
   * and the filename calendar day) instead of the import wall-clock, so
   * backfilling an old session log stays historically faithful and
   * recency-based reconciliation can trust the timestamps. A turn whose
   * timestamp is absent, unparseable, at/before the Unix epoch (the
   * adapter's "no timestamp" sentinel), or future-dated relative to
   * `now` falls back to `now` deterministically — no throw, no
   * future-dated or epoch signal. Default off → byte-identical to the
   * wall-clock path.
   */
  readonly preserveEventTime?: boolean;
}

/**
 * Resolve the effective stamp instant for an emitted signal under the
 * per-row event-time backfill (A2). Returns whether the instant came
 * from the turn (so the caller stamps the bi-temporal slots) or fell
 * back to `now` (so the file stays byte-identical to the wall-clock
 * path — no `recorded_at` / `valid_from` keys).
 *
 * The usable window is `epoch < ts <= now`: a timestamp at or before the
 * Unix epoch is the adapter's synthesized "no timestamp" sentinel
 * (`new Date(0)`), a future timestamp would mint a nonsensical
 * forward-dated signal during backfill, and an unparseable value is
 * `NaN` — all three fall back to `now`.
 */
export function resolveEventInstant(
  turnTimestamp: string | undefined,
  now: Date,
  preserve: boolean,
): { readonly instant: Date; readonly fromTurn: boolean } {
  if (!preserve || !turnTimestamp) return { instant: now, fromTurn: false };
  const ms = Date.parse(turnTimestamp);
  if (!Number.isFinite(ms) || ms <= 0 || ms > now.getTime()) {
    return { instant: now, fromTurn: false };
  }
  return { instant: new Date(ms), fromTurn: true };
}

export interface ImportSessionResult {
  readonly file: string;
  readonly format: SessionAdapterId;
  readonly turns_scanned: number;
  readonly signals_created: number;
  readonly signals_deduped: number;
  readonly tool_replays: number;
  /** Per-skill invocations captured as skill_invoked continuity records. */
  readonly skill_invocations: number;
  readonly malformed: number;
  readonly filtered_turns: number;
  /** Capture-boundary verdict for this file (Memory Integrity Suite). */
  readonly boundary_decision: SessionCaptureDecision;
  /** Turns whose text was suppressed before any extraction. */
  readonly suppressed_turns: number;
  readonly facts_extracted: number;
  readonly facts_deduped: number;
  readonly recall_turns_imported: number;
  readonly recall_summary_nodes: number;
  readonly errors: ReadonlyArray<{ path: string; message: string }>;
}

export interface ImportSessionPathResult {
  readonly files: ReadonlyArray<ImportSessionResult>;
  /** Per-file warnings (autodetect failures, IO errors). */
  readonly warnings: ReadonlyArray<{ path: string; message: string }>;
}

function firstLineOfFile(path: string): string {
  // Read the file and slice up to the first newline. Cheaper than a
  // streaming reader for our small fixtures, fine for production
  // session files that are typically 50-500 KB.
  const text = readFileSync(path, "utf8");
  const nl = text.indexOf("\n");
  return nl < 0 ? text : text.slice(0, nl);
}

/**
 * Portable session identity for provenance refs (Vault portability suite).
 *
 * A session file's absolute path is machine-local, so persisting it into a
 * synced signal's `source` / `session_ref` bakes in a host path (e.g.
 * `/root/vault/...` vs a Mac/Android home) that no Syncthing peer can
 * resolve. We key provenance by the session file's basename instead — the
 * same identity the recall DAG uses — so signal provenance and recall
 * records join on one portable id. An explicit `recallSessionId` wins so a
 * caller can pin a stable logical id.
 */
export function sessionRefIdentity(absPath: string, recallSessionId?: string): string {
  const explicit = recallSessionId?.trim();
  return explicit && explicit.length > 0 ? explicit : basename(absPath);
}

/** Pick an adapter — by explicit format, or autodetect. */
function chooseAdapter(path: string, format?: SessionAdapterId): SessionAdapter {
  if (format !== undefined) {
    return getAdapter(format);
  }
  const first = firstLineOfFile(path);
  const a = detectAdapter(first);
  if (!a) {
    throw new SessionImportError(
      "DETECT_FAIL",
      `could not autodetect session format for ${path}; pass --format to override`,
    );
  }
  return a;
}

export async function importSession(
  vault: string,
  path: string,
  opts: ImportSessionOptions,
): Promise<ImportSessionResult> {
  if (!existsSync(path)) {
    throw new SessionImportError("IO", `session file does not exist: ${path}`);
  }
  const adapter = chooseAdapter(path, opts.format);
  // Reuse the caller-supplied index when present (directory walk lifts
  // the build out of the per-file loop). Otherwise build our own.
  const dedup = opts.dedupIndex ?? buildDedupIndex(vault);

  const now = opts.now ?? new Date();
  const sinceMs = opts.since ? opts.since.getTime() : undefined;
  const absPath = resolve(path);
  // Portable provenance key for signal/fact `source` + `session_ref` and the
  // recall DAG id — never the machine-local `absPath`. See sessionRefIdentity.
  const sessionKey = sessionRefIdentity(absPath, opts.recallSessionId);
  const errors: { path: string; message: string }[] = [];

  let turnsScanned = 0;
  let signalsCreated = 0;
  let signalsDeduped = 0;
  let toolReplays = 0;
  let skillInvocations = 0;
  let malformed = 0;
  let filteredTurns = 0;
  let suppressedTurns = 0;
  let factsExtracted = 0;
  let factsDeduped = 0;
  const recallTurns: SessionTurn[] = [];
  const filterRoles =
    opts.filterRoles && opts.filterRoles.length > 0 ? new Set(opts.filterRoles) : null;
  const filterNeedle = opts.filterTextIncludes?.trim().toLowerCase() ?? null;

  // Inline helper that wraps the writeSignal call with the consistent
  // shape every session-imported signal shares.
  const emit = (input: {
    topic: string;
    signal: "positive" | "negative";
    principle: string;
    scope?: string;
    agent: string;
    note?: string;
    turnId: string;
    /** Origin turn's ISO timestamp; used for per-row event-time backfill. */
    eventTimestamp?: string;
    dedupHash: string;
  }): void => {
    if (dedup.has(input.dedupHash)) {
      signalsDeduped++;
      return;
    }
    if (opts.dryRun) {
      // Mirror scan-inline: dry-run reports the dedup hit count and
      // turns scanned, but `signals_created` stays 0 — nothing was
      // actually written.
      return;
    }
    const sessionRef = `${sessionKey}#${input.turnId}`;
    // Per-row event-time (A2): stamp the turn's original instant when
    // preservation is on and the timestamp is usable; otherwise fall
    // back to `now` and emit NO bi-temporal slots (byte-identical path).
    const { instant, fromTurn } = resolveEventInstant(
      input.eventTimestamp,
      now,
      opts.preserveEventTime === true,
    );
    try {
      const res = writeSignal(vault, {
        topic: input.topic,
        signal: input.signal,
        agent: input.agent,
        principle: input.principle,
        created_at: isoSecond(instant),
        date: isoDate(instant),
        slug: input.topic,
        ...(fromTurn
          ? {
              recorded_at: isoSecond(instant),
              valid_from: isoSecond(instant),
              // Conversation chronology (S1): carry the turn instant as
              // the authoring time so the search layer can expose it and
              // break exact hybrid-score ties toward more recent turns.
              authored_at: isoSecond(instant),
            }
          : {}),
        ...(input.scope ? { scope: input.scope } : {}),
        source: [`[[${sessionRef}]]`],
        source_type: BRAIN_SIGNAL_SOURCE_TYPE.session,
        dedup_hash: input.dedupHash,
        session_ref: sessionRef,
        ...(input.note || opts.ingestScope
          ? {
              raw: [opts.ingestScope ? `[ingest_scope:${opts.ingestScope}]` : "", input.note ?? ""]
                .filter((chunk) => chunk.length > 0)
                .join("\n"),
            }
          : {}),
        ...(opts.rawCodec === true ? { rawCodec: true } : {}),
      });
      dedup.set(input.dedupHash, { id: res.id, path: res.path });
      signalsCreated++;
    } catch (err) {
      errors.push({
        path: absPath,
        message: `writeSignal failed: ${(err as Error).message ?? String(err)}`,
      });
    }
  };

  // Capture boundary (Memory Integrity Suite): classify the session
  // FIRST. An ignored file imports nothing; a stateless file is
  // scanned read-only (no signals, no recall records, no facts).
  const boundary = buildCaptureBoundary(vault);
  const boundaryDecision = boundary.sessionDecision(opts.recallSessionId, absPath);
  const mayWrite = boundaryDecision === "capture";
  const emptyResult = (): ImportSessionResult =>
    Object.freeze({
      file: absPath,
      format: adapter.id,
      turns_scanned: 0,
      signals_created: 0,
      signals_deduped: 0,
      tool_replays: 0,
      skill_invocations: 0,
      malformed: 0,
      filtered_turns: 0,
      boundary_decision: boundaryDecision,
      suppressed_turns: 0,
      facts_extracted: 0,
      facts_deduped: 0,
      recall_turns_imported: 0,
      recall_summary_nodes: 0,
      errors: Object.freeze([]),
    });
  if (boundaryDecision === "ignore") return emptyResult();

  for await (const turn of adapter.iterate(path)) {
    turnsScanned++;
    if (sinceMs !== undefined) {
      const t = Date.parse(turn.timestamp);
      if (Number.isFinite(t) && t < sinceMs) continue;
    }
    if (filterRoles !== null && !filterRoles.has(turn.role)) {
      filteredTurns++;
      continue;
    }
    if (filterNeedle !== null) {
      const haystack = turn.text?.toLowerCase() ?? "";
      if (!haystack.includes(filterNeedle)) {
        filteredTurns++;
        continue;
      }
    }
    // Message-level boundary: suppressed text never reaches marker or
    // fact extraction (and is not stored for recall).
    if (turn.text && boundary.suppressMessage(turn.text)) {
      suppressedTurns++;
      continue;
    }
    if (opts.recall === true && mayWrite) recallTurns.push(turn);

    // Facts from USER turns only (the HANDOFF carve-out's conservative
    // core: bare assistant output is never auto-extracted).
    if (mayWrite && turn.text && turn.role === "user") {
      const routed = routeExtractedFacts(vault, {
        facts: extractFacts(turn.text),
        agent: agentLabelForTurn(turn, adapter.id, opts.agent),
        now,
        sessionRef: `${sessionKey}#${turn.turnId}`,
        dedup,
        ...(opts.dryRun === true ? { dryRun: true } : {}),
      });
      factsExtracted += routed.created;
      factsDeduped += routed.deduped;
    }

    // Path A — markers in text.
    if (mayWrite && turn.text && (turn.role === "user" || turn.role === "assistant")) {
      const discovery = discoverMarkersDetailed(turn.text);
      malformed += discovery.malformed;
      const markers = discovery.markers;
      for (const m of markers) {
        // Feedback markers only: loop / set markers are never imported
        // as signals (loops live-derive, set markers apply via write-back).
        if (!isFeedbackMarker(m)) continue;
        const hash = computeDedupHash({
          topic: m.topic,
          signal: m.signal,
          principle: m.principle,
          ...(m.scope ? { scope: m.scope } : {}),
        });
        emit({
          topic: m.topic,
          signal: m.signal,
          principle: m.principle,
          ...(m.scope ? { scope: m.scope } : {}),
          agent: m.agent ?? agentLabelForTurn(turn, adapter.id, opts.agent),
          ...(m.note ? { note: m.note } : {}),
          turnId: turn.turnId,
          eventTimestamp: turn.timestamp,
          dedupHash: hash,
        });
      }
    }

    // Path B — brain_feedback tool_use replay.
    if (!mayWrite) continue;
    for (const call of turn.toolCalls ?? []) {
      // Per-skill invocation telemetry (t_56a12bde): count real skill
      // invocations across runtimes as append-only skill_invoked records.
      // Deterministic and idempotent across re-imports (the source ref keys on
      // the session + call id + skill, so re-running dedupes rather than
      // double-counts). Skipped on a dry run.
      const invokedSkill = resolveInvokedSkill(call);
      if (invokedSkill !== null && opts.dryRun !== true) {
        try {
          appendContinuityRecord(vault, {
            kind: "skill_invoked",
            createdAt: invocationTimestamp(turn.timestamp, now),
            sourceRefs: [{ id: `${sessionKey}:${call.id ?? turn.turnId}:${invokedSkill}` }],
            payload: {
              skill: invokedSkill,
              agent: agentLabelForTurn(turn, adapter.id, opts.agent),
              tool: call.name,
              runtime: adapter.id,
            },
          });
          skillInvocations++;
        } catch {
          // Telemetry is best-effort; a failed append never fails the import.
        }
      }
      if (call.name !== "brain_feedback") continue;
      const validated = validateBrainFeedbackInput(call.input);
      if (!validated.ok) {
        malformed++;
        continue;
      }
      const v = validated.value;
      const hash = computeDedupHash({
        topic: v.topic,
        signal: v.signal,
        principle: v.principle,
        ...(v.scope ? { scope: v.scope } : {}),
      });
      toolReplays++;
      emit({
        topic: v.topic,
        signal: v.signal,
        principle: v.principle,
        ...(v.scope ? { scope: v.scope } : {}),
        agent: v.agent ?? agentLabelForTurn(turn, adapter.id, opts.agent),
        ...(v.raw ? { note: v.raw } : {}),
        turnId: call.id ?? turn.turnId,
        eventTimestamp: turn.timestamp,
        dedupHash: hash,
      });
    }
  }

  let recallTurnsImported = 0;
  let recallSummaryNodes = 0;
  if (opts.recall === true && opts.dryRun !== true && recallTurns.length > 0) {
    try {
      // Same portable identity used for signal/fact provenance above, so
      // the recall DAG and the emitted signals key this session identically.
      const recallSessionId = sessionKey;
      // Persisted-link resolution only: without a clock the crutch
      // never infers a new link, so an unknown session imports flat.
      const lineage =
        opts.recallLineage ??
        resolveSessionLineage({ sessionId: recallSessionId }, { ledger: readLineageLedger(vault) });
      const recalled = importSessionRecall(vault, {
        sessionId: recallSessionId,
        turns: recallTurns,
        createdAt: isoSecond(now),
        ...(opts.recallSummaryGroupSize !== undefined
          ? { summaryGroupSize: opts.recallSummaryGroupSize }
          : {}),
        ...(lineage.source !== "flat" ? { lineage } : {}),
      });
      recallTurnsImported = recalled.rawTurns.length;
      recallSummaryNodes = recalled.summaryNodes.length;
    } catch (err) {
      errors.push({
        path: absPath,
        message: `importSessionRecall failed: ${(err as Error).message ?? String(err)}`,
      });
    }
  }

  return Object.freeze({
    file: absPath,
    format: adapter.id,
    turns_scanned: turnsScanned,
    signals_created: signalsCreated,
    signals_deduped: signalsDeduped,
    tool_replays: toolReplays,
    skill_invocations: skillInvocations,
    malformed,
    boundary_decision: boundaryDecision,
    suppressed_turns: suppressedTurns,
    facts_extracted: factsExtracted,
    facts_deduped: factsDeduped,
    filtered_turns: filteredTurns,
    recall_turns_imported: recallTurnsImported,
    recall_summary_nodes: recallSummaryNodes,
    errors: Object.freeze(errors),
  });
}

/**
 * Compose the `agent` field for a session-imported signal. Order of
 * preference: the marker / tool-input's explicit agent (handled by
 * the caller, not here), then a per-adapter default, finally
 * `opts.agent`.
 */
function agentLabelForTurn(turn: SessionTurn, adapter: SessionAdapterId, fallback: string): string {
  void turn; // reserved for future per-turn role-aware fallback
  return getAdapter(adapter).defaultAgent.trim() || fallback;
}

/**
 * Extract the invoked skill name from a tool call, or null when the call is
 * not a skill invocation. Counts an actual skill fetch (`get_skill`, however
 * namespaced by the runtime) and the host-native `Skill` tool; discovery
 * (`list_skills`) and per-turn relevance scoring (`skills_attach`) are not
 * invocations and are ignored.
 */
function resolveInvokedSkill(call: SessionToolCall): string | null {
  const input = call.input ?? {};
  const pick = (key: string): string | null => {
    const value = input[key];
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
  };
  const name = call.name;
  if (name === "get_skill" || name.endsWith("__get_skill")) {
    return pick("name") ?? pick("skill");
  }
  if (name === "Skill") {
    return pick("command") ?? pick("skill") ?? pick("name");
  }
  return null;
}

/** ISO-second timestamp for an invocation: the turn's own time when valid. */
function invocationTimestamp(turnTimestamp: string | undefined, now: Date): string {
  if (turnTimestamp) {
    const ms = Date.parse(turnTimestamp);
    if (Number.isFinite(ms) && ms > 0 && ms <= now.getTime()) return isoSecond(new Date(ms));
  }
  return isoSecond(now);
}

export async function importSessionPath(
  vault: string,
  path: string,
  opts: ImportSessionOptions,
): Promise<ImportSessionPathResult> {
  const stat = statSync(path);
  if (stat.isFile()) {
    const res = await importSession(vault, path, opts);
    return Object.freeze({
      files: Object.freeze([res]),
      warnings: Object.freeze([]),
    });
  }
  // Directory walk: build the dedup index ONCE and thread it through
  // every per-file `importSession` call. emit() mutates the shared map
  // as new signals are written, so cross-file dedup happens too.
  const files: ImportSessionResult[] = [];
  const warnings: { path: string; message: string }[] = [];
  const queue: string[] = [];
  const collect = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      let st;
      try {
        // lstat (not stat) so symlink cycles can't drive the walker
        // into infinite recursion. Symlink-following session-exports
        // are atypical; if real demand surfaces we can switch to a
        // visited-inode set instead.
        st = lstatSync(full);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        collect(full);
        continue;
      }
      if (name.endsWith(".jsonl")) queue.push(full);
    }
  };
  collect(path);
  queue.sort();

  const sharedDedup = opts.dedupIndex ?? buildDedupIndex(vault);
  const perFileOpts: ImportSessionOptions = {
    ...opts,
    dedupIndex: sharedDedup,
  };

  // Sequential — writes go to the same Brain/inbox/ and share the
  // dedup map; parallelising would race on both.
  for (const file of queue) {
    try {
      const res = await importSession(vault, file, perFileOpts);
      files.push(res);
    } catch (err) {
      if (err instanceof SessionImportError) {
        warnings.push({ path: file, message: err.message });
        continue;
      }
      throw err;
    }
  }
  return Object.freeze({
    files: Object.freeze(files),
    warnings: Object.freeze(warnings),
  });
}
