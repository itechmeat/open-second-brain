/**
 * JSONL conversation records built from recorded session transcripts.
 *
 * Two capabilities already existed and were not connected: five adapters
 * that read a runtime's session log, and an export surface that writes
 * vault-derived bytes through the egress guard. Nothing carried the
 * transcript corpus to anything a training or evaluation harness can read.
 * This module is that carriage, and nothing else - it is reached only
 * through `o2b brain export --format transcripts-jsonl`, never as a
 * pipeline of its own, because the corpus serves a secondary operator
 * persona and this product's thesis is preference distillation.
 *
 * ## The record shape, and why it is this one
 *
 * One JSON object per line, one object per CONVERSATION: a session
 * identity plus its ordered messages. The alternative - one
 * instruction/response PAIR per line, the shape a supervised fine-tuning
 * harness eats directly - was considered and rejected, and the reason is
 * worth stating because picking either silently is how a guess becomes an
 * authoritative fact downstream.
 *
 * A pair set is a LOSSY PROJECTION of a conversation. Producing it means
 * deciding which turn is the instruction, what to do with system and tool
 * turns, and where a multi-turn exchange breaks into pairs - three
 * judgements the runtime never recorded and this exporter cannot recover.
 * A harness that wants pairs can derive them from a conversation; nothing
 * can derive the conversation back from the pairs. So the superset is what
 * leaves, and the pairing decision stays with the reader who knows which
 * one they want.
 *
 * The cost, stated rather than discovered: one conversation is held in
 * memory while its record is built. The line reader underneath never
 * materialises the file (`sessions/read-lines.ts`), so the bound is the size of
 * one session's text, not of the corpus or of the largest file.
 *
 * ## What a message carries
 *
 * Role, timestamp, turn id, text, and the NAMES of the tools the turn
 * called. Not the tool inputs: those are host paths, command lines and
 * pasted payloads, and this is a conversation dataset rather than a
 * tool-trace one. A turn with neither text nor a tool call - a runtime
 * queue event, a payload-less meta line - is not a message and is counted
 * rather than emitted.
 *
 * ## What it refuses
 *
 * A `.jsonl` under the named source that no adapter recognises stops the
 * export, naming the file. This is the same answer `collectExportRows`
 * gives an unparseable preference, for the same reason: a corpus that
 * quietly omits a transcript reads exactly like a machine that never
 * recorded it, and the file that would say otherwise is the one the
 * recipient does not have.
 *
 * Redaction is NOT this module's job - it composes records, and the export
 * verb hands each one to `redactForEgress` before any byte is written. The
 * split is deliberate: the guard call belongs at the boundary that names
 * the destination, which is where the egress census can see it.
 */

import { basename } from "node:path";

import { readFirstLine } from "./sessions/read-lines.ts";
import { detectAdapter, getAdapter, SESSION_ADAPTER_REGISTRY } from "./sessions/registry.ts";
import type { SessionAdapterRegistry } from "./sessions/registry.ts";
import { sessionFilesUnder } from "./sessions/session-files.ts";
import { SessionImportError, type SessionTurn } from "./sessions/types.ts";

/**
 * Versions the RECORD, not the corpus. A field added later is additive and
 * needs no bump - a reader written against version 1 keeps working, the
 * same contract `BRAIN_EXPORT_SCHEMA_VERSION` states for the
 * preference envelope. A field that changes meaning is what would force it.
 */
export const TRANSCRIPT_EXPORT_SCHEMA_VERSION = 1 as const;

/** One turn of a conversation, as a dataset row sees it. */
export interface TranscriptMessage {
  /** The adapter's own turn id - the join back to the source transcript. */
  readonly turn_id: string;
  readonly role: SessionTurn["role"];
  readonly timestamp: string;
  /** Flat text of the turn. Empty when the turn was only a tool call. */
  readonly text: string;
  /** Tool names, in call order. Absent when the turn called none. */
  readonly tools?: ReadonlyArray<string>;
}

/** One session transcript, as one JSONL line. */
export interface TranscriptConversation {
  readonly schema: typeof TRANSCRIPT_EXPORT_SCHEMA_VERSION;
  /** Adapter id the file was detected as (`claude`, `codex`, …). */
  readonly runtime: string;
  /**
   * The transcript's basename, never its absolute path: the same portable
   * identity `sessionRefIdentity` uses for imported provenance, so a
   * dataset row and a vault signal join on one key and neither bakes in a
   * host directory.
   */
  readonly session_id: string;
  readonly started_at: string;
  readonly ended_at: string;
  readonly message_count: number;
  readonly messages: ReadonlyArray<TranscriptMessage>;
}

export interface TranscriptExportOptions {
  /** A transcript file, or a directory walked for `*.jsonl`. */
  readonly source: string;
  /** Keep only conversations recorded by this adapter id. */
  readonly runtime?: string;
  /** Keep conversations that STARTED at or after this instant. */
  readonly since?: Date;
  /** Keep conversations that STARTED strictly before this instant. */
  readonly until?: Date;
  /** Adapter set to detect against. Defaults to the shipped registry. */
  readonly registry?: SessionAdapterRegistry;
}

/**
 * What the walk did, returned when the stream ends.
 *
 * Every scanned file is accounted for by exactly one counter, so an empty
 * export can say which filter emptied it. "No records" and "no transcripts
 * to begin with" are different facts, and a caller that cannot tell them
 * apart reports a filter typo as an idle machine.
 */
export interface TranscriptExportSummary {
  readonly scanned: number;
  readonly exported: number;
  /** Recognised, but written by a runtime the filter excluded. */
  readonly other_runtime: number;
  /** Recognised, but started outside the requested window. */
  readonly outside_window: number;
  /** Recognised, and carrying no turn a dataset can learn from. */
  readonly no_messages: number;
}

/** Tool names of a turn, in call order. */
function toolNames(turn: SessionTurn): ReadonlyArray<string> {
  return (turn.toolCalls ?? []).map((call) => call.name);
}

/** A turn as a message, or `null` when it carries nothing to learn from. */
function messageOf(turn: SessionTurn): TranscriptMessage | null {
  const text = typeof turn.text === "string" ? turn.text : "";
  const tools = toolNames(turn);
  if (text.trim() === "" && tools.length === 0) return null;
  return Object.freeze({
    turn_id: turn.turnId,
    role: turn.role,
    timestamp: turn.timestamp,
    text,
    ...(tools.length > 0 ? { tools: Object.freeze([...tools]) } : {}),
  });
}

/**
 * The conversation's start as an instant, for the window comparison only.
 *
 * A timestamp that will not parse is refused rather than treated as either
 * inside or outside the window: both readings are a guess, and one of them
 * silently drops a transcript from the corpus. Only reached when a window
 * is actually set - with no `--since` / `--until` nothing depends on the
 * value, and refusing an export over a field nobody read would be a
 * refusal for its own sake.
 */
function startInstant(record: TranscriptMessage, path: string): number {
  const ms = Date.parse(record.timestamp);
  if (!Number.isFinite(ms)) {
    throw new SessionImportError(
      "PARSE",
      `cannot read the first timestamp of ${path} ('${record.timestamp}'), so --since / ` +
        "--until cannot say whether this conversation is in the window; repair the " +
        "transcript or drop the window flags",
    );
  }
  return ms;
}

function inWindow(startedAtMs: number, options: TranscriptExportOptions): boolean {
  if (options.since !== undefined && startedAtMs < options.since.getTime()) return false;
  if (options.until !== undefined && startedAtMs >= options.until.getTime()) return false;
  return true;
}

/** Why a scanned file produced no record, when it produced none. */
type SkipKind = "outside_window" | "no_messages";

async function conversationOf(
  path: string,
  runtime: string,
  iterate: AsyncIterable<SessionTurn>,
  options: TranscriptExportOptions,
): Promise<TranscriptConversation | SkipKind> {
  const windowed = options.since !== undefined || options.until !== undefined;
  const messages: TranscriptMessage[] = [];
  for await (const turn of iterate) {
    const message = messageOf(turn);
    if (message === null) continue;
    if (windowed && messages.length === 0 && !inWindow(startInstant(message, path), options)) {
      // The window selects whole conversations by their start, so the rest
      // of this file cannot change the answer and is never read.
      return "outside_window";
    }
    messages.push(message);
  }
  if (messages.length === 0) return "no_messages";
  return Object.freeze({
    schema: TRANSCRIPT_EXPORT_SCHEMA_VERSION,
    runtime,
    session_id: basename(path),
    started_at: messages[0]!.timestamp,
    ended_at: messages[messages.length - 1]!.timestamp,
    message_count: messages.length,
    messages: Object.freeze(messages),
  });
}

/**
 * Stream one conversation record per recognised transcript under
 * `options.source`, then return {@link TranscriptExportSummary}.
 *
 * A generator rather than an array: the caller writes each record as it
 * arrives, so the corpus is never held whole. The summary rides out as the
 * generator's RETURN value, which is why a caller that needs it drives
 * `next()` itself instead of using `for await` - `for await` discards it,
 * and a counter nobody can read is not a report.
 *
 * @throws SessionImportError when the source is unreadable, a file matches
 * no adapter, or a window comparison meets an unparseable timestamp.
 */
export async function* streamTranscriptConversations(
  options: TranscriptExportOptions,
): AsyncGenerator<TranscriptConversation, TranscriptExportSummary> {
  const registry = options.registry ?? SESSION_ADAPTER_REGISTRY;
  // Resolved for its refusal, which names the registered set: an unknown
  // `--runtime` would otherwise match nothing and report an empty corpus.
  if (options.runtime !== undefined) getAdapter(options.runtime, registry);

  const files = sessionFilesUnder(options.source);
  let exported = 0;
  let otherRuntime = 0;
  let outsideWindow = 0;
  let noMessages = 0;

  for (const path of files) {
    // oxlint-disable-next-line no-await-in-loop
    const adapter = detectAdapter(await readFirstLine(path), registry);
    if (adapter === null) {
      throw new SessionImportError(
        "DETECT_FAIL",
        `could not autodetect a session format for ${path}; every *.jsonl under the ` +
          "exported source must be a session transcript, so move this file out of the " +
          "source directory or point --transcripts at one that holds only transcripts",
      );
    }
    if (options.runtime !== undefined && adapter.id !== options.runtime) {
      otherRuntime += 1;
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop
    const record = await conversationOf(path, adapter.id, adapter.iterate(path), options);
    if (record === "outside_window") {
      outsideWindow += 1;
      continue;
    }
    if (record === "no_messages") {
      noMessages += 1;
      continue;
    }
    exported += 1;
    yield record;
  }

  return Object.freeze({
    scanned: files.length,
    exported,
    other_runtime: otherRuntime,
    outside_window: outsideWindow,
    no_messages: noMessages,
  });
}
