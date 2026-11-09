/**
 * The signal fold (design D14 item 5, task 2.10): each captured signal's
 * current lifecycle state and frontmatter, computed from its records.
 *
 * Input records (in the `events` stream):
 *
 *  - `signal` `{ id, path, staged, frontmatter, raw }`: the capture. A
 *    signal starts `active` (in the inbox) or, when `staged`, `staged`
 *    (waiting for write approval).
 *  - `signal-state` `{ authority, signal, state?, fields? }`: one lifecycle
 *    move of the signal `signal`, a change of some of its frontmatter
 *    fields, or both. `state` is one of {@link SIGNAL_STATE_VALUES};
 *    `fields` maps a frontmatter field to its new value, `null` removing
 *    the field. At least one of the two is present.
 *
 * The state is one register per signal and each field is one register per
 * signal and field, resolved by the clock alone: the record later in fold
 * order wins. A lifecycle is a sequence of moves (staged, approved,
 * consumed), so a later move replaces an earlier one whoever made it; the
 * record's `authority` says who decided and is kept for the history, as
 * every mutable-entity record carries one. A record without a valid
 * `authority`, signal id, state or fields is not applied and is reported.
 *
 * `approved` makes a staged signal active again; `rejected` takes it out
 * of the brain. A state record for a signal whose capture has not arrived
 * is kept until it does (`orphans`).
 *
 *  - `signal-removed` `{ authority, signal }`: the signal is forgotten (a
 *    user's request, `delete-by-source`). Every record of the signal before
 *    it in fold order stops counting: the fold drops the signal, its
 *    frontmatter and its raw text, so no reader shows it. A capture later
 *    in fold order is a new signal under the same id. The append-only
 *    shards still hold the earlier lines until store compaction exists;
 *    `removed` counts them for the doctor.
 */

import { SIGNAL_KIND } from "./constants.ts";
import type { StoreRecord } from "./envelope.ts";
import { prepareRecords, recordAuthority, type RejectedRecord } from "./fold.ts";

/** Kind of a signal lifecycle record. */
export const SIGNAL_STATE_KIND = "signal-state";

/** Kind of a signal's tombstone: the signal is forgotten. */
export const SIGNAL_REMOVED_KIND = "signal-removed";

/** The values the `state` field of a `signal-state` record takes. */
export const SIGNAL_STATE_VALUES = Object.freeze([
  "consumed",
  "archived",
  "retired",
  "expired",
  "staged",
  "approved",
  "rejected",
] as const);
export type SignalStateValue = (typeof SIGNAL_STATE_VALUES)[number];

/** Where a signal is in its lifecycle, as the fold resolves it. */
export type SignalLifecycle =
  | "active"
  | "staged"
  | "consumed"
  | "archived"
  | "retired"
  | "expired"
  | "rejected";

/** The states a reader sees by default: the inbox and the approval staging area. */
export const LIVE_SIGNAL_STATES: ReadonlySet<SignalLifecycle> = new Set(["active", "staged"]);

/** One signal of the fold. */
export interface SignalFoldEntry {
  readonly id: string;
  /** The latest `signal` record of this id (a re-capture replaces the body). */
  readonly signal: StoreRecord;
  readonly state: SignalLifecycle;
  /** The `signal-state` record that set the state, or `null` when none did. */
  readonly stateRecord: StoreRecord | null;
  /** The captured frontmatter with every field change applied. */
  readonly frontmatter: Readonly<Record<string, unknown>>;
  /** Every record of this signal in fold order. */
  readonly history: ReadonlyArray<StoreRecord>;
}

export interface SignalsFold {
  readonly signals: ReadonlyMap<string, SignalFoldEntry>;
  /**
   * Every signal id a `signal-removed` record forgot, with the number of
   * its records (captures, moves) the tombstones made void: the lines the
   * shards still hold until compaction. An id captured again after its
   * tombstone is in `signals` too, as the new signal.
   */
  readonly removed: ReadonlyMap<string, number>;
  /** Ids of the records the tombstones made void (never shown, awaiting compaction). */
  readonly voided: ReadonlySet<string>;
  /** `signal-state` records whose signal has no capture record (yet). */
  readonly orphans: ReadonlyArray<StoreRecord>;
  readonly rejected: ReadonlyArray<RejectedRecord>;
}

const STATE_SET: ReadonlySet<string> = new Set(SIGNAL_STATE_VALUES);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The lifecycle a `state` value moves the signal into. */
export function lifecycleOf(state: SignalStateValue): SignalLifecycle {
  return state === "approved" ? "active" : state;
}

function rejection(record: StoreRecord): string | null {
  if (recordAuthority(record) === null) return "missing or invalid authority";
  const id = record.body["signal"];
  if (typeof id !== "string" || id === "") return "signal must be a non-empty string";
  const state = record.body["state"];
  const fields = record.body["fields"];
  if (state !== undefined && (typeof state !== "string" || !STATE_SET.has(state))) {
    return `state must be one of ${SIGNAL_STATE_VALUES.join(", ")}`;
  }
  if (fields !== undefined && !isPlainObject(fields)) return "fields must be an object";
  if (state === undefined && fields === undefined) return "a state or fields is required";
  return null;
}

interface Building {
  signal: StoreRecord | null;
  state: SignalLifecycle | null;
  stateRecord: StoreRecord | null;
  patches: Map<string, unknown>;
  history: StoreRecord[];
  /** A `signal-removed` record is the last word so far. */
  removed: boolean;
}

function building(map: Map<string, Building>, id: string): Building {
  let entry = map.get(id);
  if (entry === undefined) {
    entry = {
      signal: null,
      state: null,
      stateRecord: null,
      patches: new Map(),
      history: [],
      removed: false,
    };
    map.set(id, entry);
  }
  return entry;
}

/** Fold signal and signal-state records (any order, duplicates allowed). */
export function foldSignals(input: Iterable<StoreRecord>): SignalsFold {
  const { records } = prepareRecords(input);
  const byId = new Map<string, Building>();
  const rejected: RejectedRecord[] = [];
  const removedCounts = new Map<string, number>();
  const voided = new Set<string>();
  for (const record of records) {
    if (record.kind === SIGNAL_KIND) {
      const id = record.body["id"];
      if (typeof id !== "string" || id === "") {
        rejected.push({
          id: record.id,
          kind: record.kind,
          reason: "id must be a non-empty string",
        });
        continue;
      }
      const entry = building(byId, id);
      if (entry.removed) {
        // Moves between the tombstone and this capture belong to the
        // forgotten signal: void them, and start the new one clean.
        removedCounts.set(id, (removedCounts.get(id) ?? 0) + entry.history.length);
        for (const old of entry.history) voided.add(old.id);
        entry.state = null;
        entry.stateRecord = null;
        entry.patches.clear();
        entry.history = [];
      }
      entry.signal = record;
      entry.removed = false;
      entry.history.push(record);
      continue;
    }
    if (record.kind === SIGNAL_REMOVED_KIND) {
      const id = record.body["signal"];
      if (recordAuthority(record) === null || typeof id !== "string" || id === "") {
        rejected.push({
          id: record.id,
          kind: record.kind,
          reason: "authority and signal required",
        });
        continue;
      }
      const entry = building(byId, id);
      // Forget everything before the tombstone; a later capture starts over.
      removedCounts.set(id, (removedCounts.get(id) ?? 0) + entry.history.length);
      for (const old of entry.history) voided.add(old.id);
      entry.signal = null;
      entry.state = null;
      entry.stateRecord = null;
      entry.patches.clear();
      entry.history = [];
      entry.removed = true;
      continue;
    }
    if (record.kind !== SIGNAL_STATE_KIND) continue;
    const reason = rejection(record);
    if (reason !== null) {
      rejected.push({ id: record.id, kind: record.kind, reason });
      continue;
    }
    const entry = building(byId, record.body["signal"] as string);
    entry.history.push(record);
    const state = record.body["state"];
    if (typeof state === "string") {
      entry.state = lifecycleOf(state as SignalStateValue);
      entry.stateRecord = record;
    }
    const fields = record.body["fields"];
    if (isPlainObject(fields)) {
      for (const [name, value] of Object.entries(fields)) entry.patches.set(name, value);
    }
  }
  const signals = new Map<string, SignalFoldEntry>();
  const orphans: StoreRecord[] = [];
  const removed = new Map<string, number>(removedCounts);
  for (const [id, entry] of byId) {
    if (entry.removed) {
      // Moves after the tombstone with no new capture belong to nothing.
      removed.set(id, (removed.get(id) ?? 0) + entry.history.length);
      for (const old of entry.history) voided.add(old.id);
      continue;
    }
    if (entry.signal === null) {
      orphans.push(...entry.history);
      continue;
    }
    const captured = entry.signal.body["frontmatter"];
    const frontmatter: Record<string, unknown> = isPlainObject(captured) ? { ...captured } : {};
    for (const [name, value] of entry.patches) {
      if (value === null) delete frontmatter[name];
      else frontmatter[name] = value;
    }
    signals.set(id, {
      id,
      signal: entry.signal,
      state: entry.state ?? (entry.signal.body["staged"] === true ? "staged" : "active"),
      stateRecord: entry.stateRecord,
      frontmatter,
      history: entry.history,
    });
  }
  return { signals, removed, voided, orphans, rejected };
}
