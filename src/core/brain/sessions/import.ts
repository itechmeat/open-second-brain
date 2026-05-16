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

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  buildDedupIndex,
  computeDedupHash,
  type DedupIndexEntry,
} from "../dedup-hash.ts";
import { discoverMarkersDetailed } from "../inline.ts";
import { writeSignal } from "../signal.ts";
import { isoDate, isoSecond } from "../time.ts";
import { BRAIN_SIGNAL_SOURCE_TYPE } from "../types.ts";
import { detectAdapter, getAdapter } from "./registry.ts";
import {
  SessionImportError,
  type SessionAdapter,
  type SessionAdapterId,
  type SessionTurn,
} from "./types.ts";
import { validateBrainFeedbackInput } from "./validate-feedback.ts";

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
}

export interface ImportSessionResult {
  readonly file: string;
  readonly format: SessionAdapterId;
  readonly turns_scanned: number;
  readonly signals_created: number;
  readonly signals_deduped: number;
  readonly tool_replays: number;
  readonly malformed: number;
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
  const errors: { path: string; message: string }[] = [];

  let turnsScanned = 0;
  let signalsCreated = 0;
  let signalsDeduped = 0;
  let toolReplays = 0;
  let malformed = 0;

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
    const sessionRef = `${absPath}#${input.turnId}`;
    try {
      const res = writeSignal(vault, {
        topic: input.topic,
        signal: input.signal,
        agent: input.agent,
        principle: input.principle,
        created_at: isoSecond(now),
        date: isoDate(now),
        slug: input.topic,
        ...(input.scope ? { scope: input.scope } : {}),
        source: [`[[${sessionRef}]]`],
        source_type: BRAIN_SIGNAL_SOURCE_TYPE.session,
        dedup_hash: input.dedupHash,
        session_ref: sessionRef,
        ...(input.note ? { raw: input.note } : {}),
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

  for await (const turn of adapter.iterate(path)) {
    turnsScanned++;
    if (sinceMs !== undefined) {
      const t = Date.parse(turn.timestamp);
      if (Number.isFinite(t) && t < sinceMs) continue;
    }

    // Path A — markers in text.
    if (turn.text && (turn.role === "user" || turn.role === "assistant")) {
      const discovery = discoverMarkersDetailed(turn.text);
      malformed += discovery.malformed;
      const markers = discovery.markers;
      for (const m of markers) {
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
          dedupHash: hash,
        });
      }
    }

    // Path B — brain_feedback tool_use replay.
    for (const call of turn.toolCalls ?? []) {
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
        dedupHash: hash,
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
    malformed,
    errors: Object.freeze(errors),
  });
}

/**
 * Compose the `agent` field for a session-imported signal. Order of
 * preference: the marker / tool-input's explicit agent (handled by
 * the caller, not here), then a per-adapter default, finally
 * `opts.agent`.
 */
function agentLabelForTurn(
  turn: SessionTurn,
  adapter: SessionAdapterId,
  fallback: string,
): string {
  void turn; // reserved for future per-turn role-aware fallback
  switch (adapter) {
    case "claude":
      return "claude";
    case "codex":
      return "codex";
    case "hermes":
      return "hermes";
    default:
      return fallback;
  }
}

export async function importSessionPath(
  vault: string,
  path: string,
  opts: ImportSessionOptions,
): Promise<ImportSessionPathResult> {
  const stat = statSync(path);
  if (stat.isFile()) {
    const res = await importSession(vault, path, opts);
    return Object.freeze({ files: Object.freeze([res]), warnings: Object.freeze([]) });
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
        st = statSync(full);
      } catch {
        continue;
      }
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
  const perFileOpts: ImportSessionOptions = { ...opts, dedupIndex: sharedDedup };

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
