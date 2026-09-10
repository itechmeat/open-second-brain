/**
 * The note-write reader (who-wrote-what, Task A / t_662f4e82).
 *
 * `recordNoteWrite` appends one `note-write` event per write; this is the
 * only module that reads them back, and it exists so that `o2b brain
 * writes`, the `brain_writes` MCP tool and the per-agent revert
 * (t_924129c5) all answer from one projection rather than three parsers
 * of the same payload.
 *
 * It reads through {@link readLogDay}, which merges every device shard of
 * a day in a deterministic order and reports malformed lines as warnings
 * instead of aborting. Two consequences the callers rely on:
 *
 *   - the DEVICE comes off the shard the entry was read from, not off the
 *     payload. No writer stamps its device id into a note-write body, and
 *     one that did would be asserting a fact the file name already
 *     records - a caller naming its own provenance, which is the shape
 *     the origin-channel stamp exists not to be.
 *   - a warning is carried out rather than swallowed. A day whose JSONL
 *     lost a line is a day whose write history is incomplete, and an
 *     operator deciding what to revert has to be told that.
 *
 * Order is newest-first, because every surface over this reader answers
 * "what just happened" before it answers "what happened once".
 */

import { listLogDates, listLogShardFiles, readLogDay, type LogShardFile } from "../log-jsonl.ts";
import type { BrainLogEntry, BrainLogParseWarning } from "../log.ts";
import { BRAIN_LOG_EVENT_KIND } from "../types.ts";
import { ORIGIN_CHANNEL_FIELD } from "../../origin-channel.ts";
import { isNoteWriteOp, type NoteWriteOp } from "./write-record.ts";

/** One recorded note write, projected from its log event. */
export interface NoteWriteRecord {
  readonly write_id: string;
  /** ISO-8601 UTC second the event carries. */
  readonly timestamp: string;
  readonly op: NoteWriteOp;
  /** Vault-relative POSIX path of the note. */
  readonly target: string;
  /** sha256 of the replaced bytes, or `absent` when there were none. */
  readonly hash_before: string;
  readonly hash_after: string;
  readonly bytes_before: number;
  readonly bytes_after: number;
  readonly agent: string;
  /**
   * Device that recorded the write, read off the log shard. The empty
   * string is the legacy un-sharded pair, which is a real answer ("the
   * machine that wrote this had no device id configured") and not a
   * missing one.
   */
  readonly device: string;
  /** Channel the appender stamped, or null on a line written before it. */
  readonly origin_channel: string | null;
}

/** How a caller narrows {@link listNoteWrites}. */
export interface ListNoteWritesFilter {
  /** Exact agent identity. */
  readonly agent?: string;
  /** Exact device id; the empty string selects the legacy un-sharded pair. */
  readonly device?: string;
  /** Exact vault-relative target path. */
  readonly path?: string;
  /** Inclusive lower bound: an ISO date or an ISO-8601 UTC timestamp. */
  readonly since?: string;
  /** Inclusive upper bound, same two spellings. */
  readonly until?: string;
  readonly op?: NoteWriteOp;
}

export interface ListNoteWritesResult {
  /** Matching writes, newest first. */
  readonly writes: ReadonlyArray<NoteWriteRecord>;
  /** Every parse warning the underlying log days reported. */
  readonly warnings: ReadonlyArray<BrainLogParseWarning>;
}

/** Characters of an ISO-8601 timestamp that spell its date. */
const DATE_LENGTH = 10;

/** A bare `YYYY-MM-DD`, which both bounds accept as shorthand for a day. */
const ISO_DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** How a bare date is completed at each end of the window. */
const DAY_START_SUFFIX = "T00:00:00Z";
const DAY_END_SUFFIX = "T23:59:59Z";

/**
 * Complete a bound to a comparable timestamp.
 *
 * A bare `--until 2026-03-04` means "through the end of the fourth", not
 * "up to midnight starting it" - the second reading would return nothing
 * for the very day an operator just named, which is the kind of empty
 * that reads as "no writes" rather than as "wrong bound".
 */
function completeBound(value: string, suffix: string): string {
  return ISO_DATE_ONLY_RE.test(value) ? `${value}${suffix}` : value;
}

/** Payload value as a string, or null when the key is absent or a list. */
function stringField(
  body: Readonly<Record<string, string | ReadonlyArray<string>>>,
  key: string,
): string | null {
  const value = body[key];
  return typeof value === "string" ? value : null;
}

/**
 * A byte count as recorded. The payload contract carries strings only, so
 * the count is rendered on the way in and parsed back here; a value that
 * is not a non-negative integer is reported as `-1` rather than silently
 * becoming zero, because a zero-length note and an unreadable count are
 * different facts.
 */
const UNREADABLE_BYTE_COUNT = -1;

function byteField(
  body: Readonly<Record<string, string | ReadonlyArray<string>>>,
  key: string,
): number {
  const raw = stringField(body, key);
  if (raw === null) return UNREADABLE_BYTE_COUNT;
  const value = Number.parseInt(raw, 10);
  return Number.isInteger(value) && value >= 0 && String(value) === raw
    ? value
    : UNREADABLE_BYTE_COUNT;
}

/**
 * Project one log entry into a record, or null when it is not a
 * note-write event this build can read.
 *
 * A `note-write` line missing its `write_id`, `target` or `op` is not
 * projected: those three are what every surface over this reader keys on,
 * and a record with a blank one would be a row an operator could select
 * and never act on.
 */
function projectRecord(entry: BrainLogEntry, device: string): NoteWriteRecord | null {
  if (entry.eventType !== BRAIN_LOG_EVENT_KIND.noteWrite) return null;
  const writeId = stringField(entry.body, "write_id");
  const target = stringField(entry.body, "target");
  const op = stringField(entry.body, "op");
  if (writeId === null || target === null || op === null || !isNoteWriteOp(op)) return null;
  return {
    write_id: writeId,
    timestamp: entry.timestamp,
    op,
    target,
    hash_before: stringField(entry.body, "hash_before") ?? "",
    hash_after: stringField(entry.body, "hash_after") ?? "",
    bytes_before: byteField(entry.body, "bytes_before"),
    bytes_after: byteField(entry.body, "bytes_after"),
    agent: stringField(entry.body, "agent") ?? "",
    device,
    origin_channel: stringField(entry.body, ORIGIN_CHANNEL_FIELD),
  };
}

/**
 * Every recorded note write matching the filter, newest first.
 *
 * The date range narrows which log days are opened at all, so a filter
 * with both bounds does not pay for the whole history; the remaining
 * predicates run per record because they key on payload fields the file
 * layout cannot answer.
 */
export function listNoteWrites(
  vault: string,
  filter: ListNoteWritesFilter = {},
): ListNoteWritesResult {
  const since = filter.since === undefined ? null : completeBound(filter.since, DAY_START_SUFFIX);
  const until = filter.until === undefined ? null : completeBound(filter.until, DAY_END_SUFFIX);
  const shards: ReadonlyArray<LogShardFile> = listLogShardFiles(vault);
  const warnings: BrainLogParseWarning[] = [];
  const writes: NoteWriteRecord[] = [];

  for (const date of listLogDates(vault)) {
    if (since !== null && date < since.slice(0, DATE_LENGTH)) continue;
    if (until !== null && date > until.slice(0, DATE_LENGTH)) continue;
    const day = readLogDay(vault, date, shards);
    warnings.push(...day.warnings);
    day.entries.forEach((entry, index) => {
      const record = projectRecord(entry, day.entryShardIds[index] ?? "");
      if (record === null) return;
      if (filter.agent !== undefined && record.agent !== filter.agent) return;
      if (filter.device !== undefined && record.device !== filter.device) return;
      if (filter.path !== undefined && record.target !== filter.path) return;
      if (filter.op !== undefined && record.op !== filter.op) return;
      if (since !== null && record.timestamp < since) return;
      if (until !== null && record.timestamp > until) return;
      writes.push(record);
    });
  }

  // Newest first, by REVERSING the order the log already merged rather
  // than re-sorting on the timestamp. Timestamps are second-precision, so
  // a sort would tie for every pair of writes made inside one second and
  // any tiebreak invented here - the write id, the path - would order
  // them by something that is not when they happened. `readLogDay`
  // already merges shards by (timestamp, shard id, line), and line order
  // inside a shard IS the order the appends landed, so reversing keeps
  // the causal order within a second and stays deterministic across
  // devices reading one synced vault.
  writes.reverse();
  return { writes, warnings };
}
