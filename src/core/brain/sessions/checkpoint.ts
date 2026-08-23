/**
 * Per-file session-import checkpoint (nothing-writes-silently, Unit F).
 *
 * Resume is NOT introduced here. `ingest/checkpoint.ts` has shipped
 * plan-scoped resume for the source-ingest lane since the Ingestion & Import
 * Robustness suite; this module extends that substrate
 * ({@link ../checkpoint-store.ts}) to the sessions lane, which had none.
 *
 * What the sessions lane had instead was DEDUP: `importSession` rebuilt a
 * dedup index from the inbox at the start of every run, so a second run over
 * the same transcript found every hash already present and discarded its
 * writes. That is re-do-and-discard, not resume - an interrupted 50k-turn
 * import re-read and re-hashed all fifty thousand turns to conclude it had
 * nothing to write. This checkpoint records the turn boundary instead, so the
 * next run skips straight past the turns a previous one finished.
 *
 * ## The key: (file identity, turn boundary)
 *
 * The turn boundary is a count of turns the adapter has already yielded and
 * the import has already processed. The file identity is what makes that
 * count meaningful, and it is two cheap facts rather than a content hash: the
 * SHA-256 of the transcript's first line, and its size in bytes at the moment
 * the boundary was taken. Hashing the whole file would defeat the purpose -
 * re-reading every byte is the cost being avoided - and would invalidate the
 * checkpoint on every append to a log that is append-only by construction.
 *
 * Stated precisely, because the guarantee is narrower than "the file is
 * unchanged": a transcript whose first line differs, or which has SHRUNK
 * since the boundary, is a different log and is refused. A log rewritten in
 * place to the same-or-greater length with the same first line would not be
 * caught. Every session adapter this build ships reads an append-only JSONL
 * whose first line carries the session's own identifiers, so that case is not
 * one the format produces; the limit is written down rather than implied.
 *
 * ## Scoped to the import's question, not just the file
 *
 * The id folds the import's filters in - role and text filters, `since`,
 * event-time preservation, recall, the ingest scope label, the agent. Two
 * runs asking different questions of one transcript reach different turn sets
 * and must never resume off each other's boundary; giving them different ids
 * is what makes that structural rather than remembered.
 *
 * Language-agnostic: the id is a hex digest over paths and option values; no
 * natural-language content is inspected.
 */

import { createHash } from "node:crypto";

import {
  checkpointFilePath,
  checkpointingEnabled,
  readCheckpointObject,
  removeCheckpointFile,
  withCheckpointLock,
  writeCheckpointObject,
} from "../checkpoint-store.ts";
import { isoSecond } from "../time.ts";

/** Only schema version currently understood. Unknown versions are refused. */
const SCHEMA_VERSION = 1 as const;

/** Subdirectory holding one JSON checkpoint per scoped session import. */
const CHECKPOINT_DIR = "session-import-checkpoints";

/** How a refusal names this lane's id and its file. */
const ID_LABEL = "session import";
const FILE_LABEL = "session import checkpoint";

/**
 * Turns between boundary writes.
 *
 * A boundary per turn would take the sync lock and land an atomic write fifty
 * thousand times on a large transcript, which costs more than the extraction
 * it protects. A boundary every 250 turns bounds an interruption's lost work
 * to at most 250 turns while keeping the whole run to a couple of hundred
 * checkpoint writes.
 */
export const SESSION_CHECKPOINT_TURN_INTERVAL = 250;

/** The persisted per-import checkpoint. */
export interface SessionImportCheckpoint {
  readonly schema_version: typeof SCHEMA_VERSION;
  /** Stable id derived from the session file and the import's scope. */
  readonly import_id: string;
  /**
   * The session log this boundary belongs to, as this machine addressed it.
   * Machine-local by design and for the same reason the session import ledger
   * is: a transcript lives outside the vault, under a per-runtime root that
   * differs on every device, so there is no portable spelling of it.
   */
  readonly session_file: string;
  /** SHA-256 of the transcript's first line when the boundary was taken. */
  readonly head_hash: string;
  /** Size of the transcript in bytes when the boundary was taken. */
  readonly bytes: number;
  /** Turns the import had fully processed at the boundary. */
  readonly turns_completed: number;
  readonly updated_at: string;
}

/** The subset of import options that changes which turns a run processes. */
export interface SessionImportScope {
  readonly agent: string;
  readonly format?: string;
  readonly since?: Date;
  readonly filterRoles?: ReadonlyArray<string>;
  readonly filterTextIncludes?: string;
  readonly preserveEventTime?: boolean;
  readonly recall?: boolean;
  readonly recallSessionId?: string;
  readonly recallSummaryGroupSize?: number;
  readonly ingestScope?: string;
  readonly rawCodec?: boolean;
}

/** Why a checkpoint that existed was refused instead of resumed from. */
export const SESSION_RESUME_DISCARD = Object.freeze({
  /** The transcript's first line is not the one the boundary was taken against. */
  headChanged: "head_changed",
  /** The transcript is smaller than it was, so the boundary is past its end. */
  fileShrank: "file_shrank",
} as const);

export type SessionResumeDiscard =
  (typeof SESSION_RESUME_DISCARD)[keyof typeof SESSION_RESUME_DISCARD];

/** What a run measured about the transcript it is about to read. */
export interface SessionFileIdentity {
  readonly headHash: string;
  readonly bytes: number;
}

/** The resume decision: where to start, and why a checkpoint was rejected. */
export interface SessionResumeDecision {
  /** Turns to skip. Zero when there is no usable checkpoint. */
  readonly turns: number;
  /** Set only when a checkpoint existed and was refused. */
  readonly discarded: SessionResumeDiscard | null;
}

/** SHA-256 hex of a transcript's first line - the cheap half of file identity. */
export function computeSessionHeadHash(firstLine: string): string {
  return createHash("sha256").update(firstLine).digest("hex");
}

/**
 * Deterministic import id: a short SHA-256 hex over the session file's path
 * and every option that changes which turns the run processes. Options are
 * folded in a fixed order with NUL separators so no two distinct scopes can
 * collide by concatenation.
 */
export function computeSessionImportId(sessionFile: string, scope: SessionImportScope): string {
  const parts: string[] = [
    sessionFile,
    scope.agent,
    scope.format ?? "",
    scope.since ? String(scope.since.getTime()) : "",
    [...(scope.filterRoles ?? [])].toSorted().join(","),
    scope.filterTextIncludes ?? "",
    scope.preserveEventTime === true ? "1" : "",
    scope.recall === true ? "1" : "",
    scope.recallSessionId ?? "",
    scope.recallSummaryGroupSize !== undefined ? String(scope.recallSummaryGroupSize) : "",
    scope.ingestScope ?? "",
    scope.rawCodec === true ? "1" : "",
  ];
  return createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 16);
}

/** Absolute path of one scoped import's checkpoint file. */
export function sessionCheckpointPath(vault: string, importId: string): string {
  return checkpointFilePath(vault, CHECKPOINT_DIR, ID_LABEL, importId);
}

function serialize(cp: SessionImportCheckpoint): string {
  return (
    JSON.stringify(
      {
        schema_version: cp.schema_version,
        import_id: cp.import_id,
        session_file: cp.session_file,
        head_hash: cp.head_hash,
        bytes: cp.bytes,
        turns_completed: cp.turns_completed,
        updated_at: cp.updated_at,
      },
      null,
      2,
    ) + "\n"
  );
}

function requireNonNegativeInteger(field: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(
      `session import checkpoint: ${field} must be a non-negative integer, got ${value}`,
    );
  }
}

function requireHex64(field: string, value: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(
      `session import checkpoint: ${field} must be a 64-character lowercase hex digest`,
    );
  }
}

/**
 * Read one scoped import's checkpoint. A missing file (or checkpointing
 * disabled) returns `null`. Corrupt bytes and an unknown `schema_version` are
 * hard errors - never a silent reset, which would present finished turns as
 * pending and re-hash every one of them.
 */
export function readSessionCheckpoint(
  vault: string,
  importId: string,
): SessionImportCheckpoint | null {
  if (!checkpointingEnabled()) return null;
  const path = sessionCheckpointPath(vault, importId);
  const obj = readCheckpointObject(path, FILE_LABEL, SCHEMA_VERSION);
  if (obj === null) return null;
  const turns = obj["turns_completed"];
  const bytes = obj["bytes"];
  return Object.freeze({
    schema_version: SCHEMA_VERSION,
    import_id: importId,
    session_file: typeof obj["session_file"] === "string" ? obj["session_file"] : "",
    head_hash: typeof obj["head_hash"] === "string" ? obj["head_hash"] : "",
    bytes: Number.isInteger(bytes) ? (bytes as number) : 0,
    turns_completed: Number.isInteger(turns) ? (turns as number) : 0,
    updated_at: typeof obj["updated_at"] === "string" ? obj["updated_at"] : "",
  });
}

/** What {@link recordSessionProgress} is told about the boundary just reached. */
export interface SessionProgressInput {
  readonly sessionFile: string;
  readonly headHash: string;
  readonly bytes: number;
  readonly turnsCompleted: number;
}

/**
 * Record the turn boundary a run has reached, atomically. Returns `true` when
 * the checkpoint was written, `false` on a no-op - checkpointing disabled, or
 * the serialized bytes unchanged.
 *
 * The read and the write are ONE critical section under the sync lock, for
 * the reason the shared substrate states: two runs over one transcript that
 * both wrote back the state they read would leave the lower boundary, silently
 * turning finished turns back into pending work.
 */
export function recordSessionProgress(
  vault: string,
  importId: string,
  input: SessionProgressInput,
  now: Date,
): boolean {
  requireNonNegativeInteger("turns_completed", input.turnsCompleted);
  requireNonNegativeInteger("bytes", input.bytes);
  requireHex64("head_hash", input.headHash);
  if (!checkpointingEnabled()) return false;
  const path = sessionCheckpointPath(vault, importId);
  return withCheckpointLock(path, () =>
    writeCheckpointObject(
      vault,
      path,
      serialize({
        schema_version: SCHEMA_VERSION,
        import_id: importId,
        session_file: input.sessionFile,
        head_hash: input.headHash,
        bytes: input.bytes,
        turns_completed: input.turnsCompleted,
        updated_at: isoSecond(now),
      }),
    ),
  );
}

/**
 * Decide where a run should start. Returns `turns: 0` with `discarded: null`
 * when there is no checkpoint at all, and `turns: 0` with a named reason when
 * one exists but was taken against a transcript this is no longer. The caller
 * surfaces that reason: a boundary quietly ignored is a full re-import the
 * operator was never told about.
 */
export function resolveSessionResume(
  vault: string,
  importId: string,
  live: SessionFileIdentity,
): SessionResumeDecision {
  const cp = readSessionCheckpoint(vault, importId);
  if (cp === null) return { turns: 0, discarded: null };
  if (cp.head_hash !== live.headHash) {
    return { turns: 0, discarded: SESSION_RESUME_DISCARD.headChanged };
  }
  if (live.bytes < cp.bytes) {
    return { turns: 0, discarded: SESSION_RESUME_DISCARD.fileShrank };
  }
  return { turns: cp.turns_completed, discarded: null };
}

/**
 * Drop one scoped import's checkpoint once the run has drained it - the same
 * settle the ingest lane performs on a fully drained plan, where the content
 * manifest (here, the dedup index) is the authoritative final state from then
 * on. Returns `true` when a file was removed.
 */
export function clearSessionCheckpoint(vault: string, importId: string): boolean {
  return removeCheckpointFile(vault, sessionCheckpointPath(vault, importId));
}
