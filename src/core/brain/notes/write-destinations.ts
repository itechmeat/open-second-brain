/**
 * The destination-keyed write aggregate (actionable-now batch, A3 /
 * t_69fec179).
 *
 * "Which destinations did the recorded writes touch?" - one query-time
 * fold over the Brain log, grouping BOTH recorded write kinds by the
 * vault-relative target they name:
 *
 *   - `note-write` events (one per recorded note write, written by the
 *     note seams after the bytes land), and
 *   - `write-session` audit rows - one per TERMINAL write-session
 *     transition, of which only the `done` rows record a write (a
 *     `failed` session landed nothing); the write-session lane emits NO
 *     note-write events, which is exactly why this reader walks both
 *     kinds instead of reusing `listNoteWrites`, whose projection is
 *     note-write only.
 *
 * LOG-DERIVED ON QUERY, like every read aggregate over the log
 * (`listNoteWrites`, `buildTimelineIndex`, the today dashboard): the
 * aggregate adds no new fact, so a persisted table would be a cache with
 * a maintenance lane and a census burden. A query writes nothing.
 *
 * Coverage honesty: the write binding splits destinations three ways,
 * and slug-derived and fully-derived sites (a signal slug, a daily log)
 * emit NEITHER kind. A destination absent from this aggregate may
 * therefore still have been written; {@link WRITE_DESTINATION_COVERAGE_NOTE}
 * says so on every result instead of letting a clean answer imply a
 * complete one. Underclaiming is acceptable; overclaiming is not.
 */

import { listLogDates, listLogShardFiles, readLogDay } from "../log-jsonl.ts";
import type { BrainLogEntry, BrainLogParseWarning } from "../log.ts";
import type { WriteSessionStatus } from "../write-session/types.ts";
import { BRAIN_LOG_EVENT_KIND } from "../types.ts";
import {
  DATE_LENGTH,
  DAY_END_SUFFIX,
  DAY_START_SUFFIX,
  parseWindowBound,
  timestampInWindow,
} from "./log-window.ts";

/** Which recorded write kinds a destination's rows cover. */
export const WRITE_DESTINATION_KIND = Object.freeze({
  noteWrite: "note-write",
  writeSession: "write-session",
} as const);

export type WriteDestinationKind =
  (typeof WRITE_DESTINATION_KIND)[keyof typeof WRITE_DESTINATION_KIND];

/** The kinds, in declaration order - the order a row's `kinds` field uses. */
export const WRITE_DESTINATION_KINDS: ReadonlyArray<WriteDestinationKind> = Object.freeze(
  Object.values(WRITE_DESTINATION_KIND),
);

/**
 * Stated on every result: what this aggregate does not see. Written as a
 * constant because it is part of the answer, not a flourish a caller may
 * reword into an overclaim.
 */
export const WRITE_DESTINATION_COVERAGE_NOTE =
  "covers the destinations recorded write events name: slug-derived and fully-derived " +
  "write-binding sites (signal slugs, daily logs, telemetry) emit no note-write and no " +
  "write-session event, so a destination absent here may still have been written";

/** Default lookback window in whole UTC days, including today (the today-dashboard precedent). */
export const DEFAULT_WRITE_DESTINATION_WINDOW_DAYS = 7;

/** One destination: everything the recorded writes say about one target. */
export interface WriteDestinationRow {
  /** Vault-relative target path, exactly as the events recorded it. */
  readonly target: string;
  /**
   * Which recorded kinds contributed to this row, in declaration order.
   * A single-kind row answers honestly that the other kind said nothing
   * about this destination.
   */
  readonly kinds: ReadonlyArray<WriteDestinationKind>;
  readonly note_writes: number;
  readonly write_sessions: number;
  /** Both kinds together. */
  readonly writes: number;
  /** Contributing agents, first-seen order. */
  readonly agents: ReadonlyArray<string>;
  /**
   * Contributing devices, read off the log shards, first-seen order. The
   * empty string is the legacy un-sharded pair, which is an answer.
   */
  readonly devices: ReadonlyArray<string>;
  /** Newest recorded timestamp across both kinds. */
  readonly last_write: string;
}

/** How a caller narrows the aggregate. */
export interface WriteDestinationsFilter {
  /** Exact agent identity, as either kind recorded it. */
  readonly agent?: string;
  /** Exact device id; the empty string selects the legacy un-sharded pair. */
  readonly device?: string;
  /** Exact vault-relative target path. */
  readonly path?: string;
  /** Inclusive lower bound: an ISO date or an ISO-8601 UTC timestamp. */
  readonly since?: string;
  /** Inclusive upper bound, same two spellings; a bare date covers its day. */
  readonly until?: string;
  /** Maximum rows returned; `total_matched` still reports the full count. */
  readonly limit?: number;
  /**
   * Instant the default window is measured from; defaults to now. When
   * `until` is given, the default window is anchored on `until` instead -
   * an `--until` naming a past period asks about THAT period, and a lower
   * bound measured from the present would answer a clean, wrong empty.
   */
  readonly now?: Date;
}

export interface WriteDestinationsResult {
  /** Matching destinations, ordered by target. */
  readonly destinations: ReadonlyArray<WriteDestinationRow>;
  /** Row count before `limit` truncated the page. */
  readonly total_matched: number;
  readonly limit: number;
  /**
   * The window the walk covered, completed to timestamps. The lower
   * end is never null: a caller that sent no `--since` gets the
   * default window's computed bound, not an open walk.
   */
  readonly window: { readonly since: string; readonly until: string | null };
  /** Every parse warning the underlying log days reported. */
  readonly warnings: ReadonlyArray<BrainLogParseWarning>;
  readonly coverage_note: string;
}

/** Whole days one UTC day apart, for the default-window cutoff. */
const DAY_MS = 86_400_000;

/**
 * The only write-session audit status that records a write. The audit
 * lane emits one row per TERMINAL transition (`auditTerminal` in
 * `src/core/brain/write-session/engine.ts`, statuses spelled by
 * `WriteSessionStatus` in `src/core/brain/write-session/types.ts`), and
 * the `failed` terminal - abandon, retry cap, TTL expiry - is a session
 * that died before anything landed. Counting it would claim a write
 * that never happened; separating a failed session from a committed one
 * is exactly what a per-destination tally is for.
 */
const WRITE_SESSION_DONE_STATUS = "done" as const satisfies WriteSessionStatus;

/** The default window's lower bound as an ISO date: today minus (days - 1). */
function defaultSinceDate(days: number, now: Date): string {
  return new Date(now.getTime() - (days - 1) * DAY_MS).toISOString().slice(0, DATE_LENGTH);
}

/** Body value as a string, or null when the key is absent or a list. */
function stringField(entry: BrainLogEntry, key: string): string | null {
  const value = entry.body[key];
  return typeof value === "string" ? value : null;
}

/** The agent a recorded event carries: body first, the top-level second. */
function eventAgent(entry: BrainLogEntry): string {
  return stringField(entry, "agent") ?? entry.agent ?? "";
}

/**
 * One recorded destination touch projected from either kind, or null for
 * an event that names no target, is neither kind - or is a write-session
 * audit row for a session that never committed. The device is not
 * projected because it is not the event's to tell: it is read off the
 * shard the entry arrived in, at the call site.
 */
function projectTouch(
  entry: BrainLogEntry,
): { kind: WriteDestinationKind; target: string; agent: string } | null {
  const target = stringField(entry, "target");
  if (target === null || target.length === 0) return null;
  const agent = eventAgent(entry);
  if (entry.eventType === BRAIN_LOG_EVENT_KIND.noteWrite) {
    return { kind: WRITE_DESTINATION_KIND.noteWrite, target, agent };
  }
  if (
    entry.eventType === BRAIN_LOG_EVENT_KIND.writeSession &&
    stringField(entry, "status") === WRITE_SESSION_DONE_STATUS
  ) {
    return { kind: WRITE_DESTINATION_KIND.writeSession, target, agent };
  }
  return null;
}

/** Accumulator behind one destination row; frozen into the row at the end. */
interface DestinationAccumulator {
  target: string;
  noteWrites: number;
  writeSessions: number;
  agents: string[];
  agentSeen: Set<string>;
  devices: string[];
  deviceSeen: Set<string>;
  lastWrite: string;
}

/** Rows order by target; a named comparator because a fold owes its order a name. */
function byTargetAsc(a: DestinationAccumulator, b: DestinationAccumulator): number {
  if (a.target < b.target) return -1;
  if (a.target > b.target) return 1;
  return 0;
}

/**
 * Every destination the recorded writes touched inside the window,
 * ordered by target.
 *
 * The date range narrows which log days are opened at all (default: the
 * last seven days including today, or ending at `until` when the caller
 * names one); the remaining predicates run per
 * event because they key on payload fields the file layout cannot answer.
 * Both bounds accept a bare `YYYY-MM-DD`, completed to the day's start
 * and end - an `--until` naming a day means "through the end of it".
 *
 * Rows order by target with a stable sort, and everything inside a row
 * keeps first-seen order: `readLogDay` already merges shards by
 * (timestamp, shard id, line), so two same-second touches from one shard
 * stay in the order the appends landed, and the fold adds nothing that
 * would reorder them.
 */
export function listWriteDestinations(
  vault: string,
  filter: WriteDestinationsFilter = {},
): WriteDestinationsResult {
  const since =
    filter.since === undefined ? null : parseWindowBound(filter.since, "since", DAY_START_SUFFIX);
  const until =
    filter.until === undefined ? null : parseWindowBound(filter.until, "until", DAY_END_SUFFIX);
  // The default window's anchor is the upper bound when the caller named
  // one, and the present only when it did not: "the last seven days" of a
  // query about March is the seven days ending in March, never the seven
  // days before the question was asked.
  const windowAnchor = until !== null ? new Date(until) : (filter.now ?? new Date());
  const effectiveSince =
    since ??
    `${defaultSinceDate(DEFAULT_WRITE_DESTINATION_WINDOW_DAYS, windowAnchor)}${DAY_START_SUFFIX}`;
  const shards = listLogShardFiles(vault);
  const warnings: BrainLogParseWarning[] = [];
  const byTarget = new Map<string, DestinationAccumulator>();

  for (const date of listLogDates(vault)) {
    if (date < effectiveSince.slice(0, DATE_LENGTH)) continue;
    if (until !== null && date > until.slice(0, DATE_LENGTH)) continue;
    const day = readLogDay(vault, date, shards);
    warnings.push(...day.warnings);
    day.entries.forEach((entry, index) => {
      const device = day.entryShardIds[index] ?? "";
      if (filter.device !== undefined && device !== filter.device) return;
      const touch = projectTouch(entry);
      if (touch === null) return;
      if (filter.agent !== undefined && touch.agent !== filter.agent) return;
      if (filter.path !== undefined && touch.target !== filter.path) return;
      if (!timestampInWindow(entry.timestamp, effectiveSince, until)) return;

      let acc = byTarget.get(touch.target);
      if (acc === undefined) {
        acc = {
          target: touch.target,
          noteWrites: 0,
          writeSessions: 0,
          agents: [],
          agentSeen: new Set<string>(),
          devices: [],
          deviceSeen: new Set<string>(),
          lastWrite: entry.timestamp,
        };
        byTarget.set(touch.target, acc);
      }
      if (touch.kind === WRITE_DESTINATION_KIND.noteWrite) acc.noteWrites += 1;
      else acc.writeSessions += 1;
      if (!acc.agentSeen.has(touch.agent)) {
        acc.agentSeen.add(touch.agent);
        acc.agents.push(touch.agent);
      }
      if (!acc.deviceSeen.has(device)) {
        acc.deviceSeen.add(device);
        acc.devices.push(device);
      }
      // Newest touch by instant, not by string: the JSONL reader admits
      // foreign sub-second timestamps, and a string compare orders
      // `…56.789Z` before `…56Z` (the `log-window.ts` rule). Both sides
      // parse - `timestampInWindow` already rejected NaN against the
      // never-null effective since - so the original spelling survives.
      if (Date.parse(entry.timestamp) > Date.parse(acc.lastWrite)) acc.lastWrite = entry.timestamp;
    });
  }

  const rows = [...byTarget.values()].toSorted(byTargetAsc).map((acc) => {
    const kinds = WRITE_DESTINATION_KINDS.filter((kind) =>
      kind === WRITE_DESTINATION_KIND.noteWrite ? acc.noteWrites > 0 : acc.writeSessions > 0,
    );
    return Object.freeze({
      target: acc.target,
      kinds: Object.freeze(kinds),
      note_writes: acc.noteWrites,
      write_sessions: acc.writeSessions,
      writes: acc.noteWrites + acc.writeSessions,
      agents: Object.freeze([...acc.agents]),
      devices: Object.freeze([...acc.devices]),
      last_write: acc.lastWrite,
    });
  });

  const limit =
    filter.limit === undefined || !Number.isInteger(filter.limit) || filter.limit < 1
      ? rows.length
      : filter.limit;
  return Object.freeze({
    destinations: Object.freeze(rows.slice(0, limit)),
    total_matched: rows.length,
    limit,
    window: Object.freeze({ since: effectiveSince, until }),
    warnings: Object.freeze([...warnings]),
    coverage_note: WRITE_DESTINATION_COVERAGE_NOTE,
  });
}
