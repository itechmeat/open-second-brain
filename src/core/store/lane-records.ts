/**
 * Lane entries (design D14 items 2 and 4): the one generic record kind for
 * every Brain record lane that has no kind of its own (decisions,
 * obligations, pledges, entities, procedures, skill proposals, captures,
 * standing rules, exact-state pages and the rest).
 *
 *  - `lane-entry` `{ authority, lane, entry, fields, text }`, in `events`:
 *    the whole current entry. `fields` are the structured fields the page
 *    carried in its frontmatter (or the JSON object a JSON file held),
 *    `text` its Markdown body.
 *  - `lane-entry-remove` `{ authority, lane, entry }`, in `events`: the
 *    tombstone of an entry.
 *
 * Entries fold by `(lane, entry)` under design D4: one register per entry,
 * resolved by authority, then clock; a removal is a tombstone and nothing
 * is deleted. Standing rules are human-authored and carry `human`.
 *
 * This module holds the kind names, the record builder (the same
 * {@link DualWriteRecord} shape every other builder returns) and the fold.
 */

import { isRecordRelPath } from "../record-path.ts";
import { AUTHORITY_FIELD, type Authority } from "./constants.ts";
import type { DualWriteRecord } from "./dual-write.ts";
import type { StoreRecord } from "./envelope.ts";
import {
  prepareRecords,
  recordAuthority,
  RegisterSet,
  TOMBSTONE,
  type RegisterEntry,
  type RejectedRecord,
} from "./fold.ts";
import { LEDGER_NAME_RE } from "./store-paths.ts";

export const LANE_ENTRY_KIND = "lane-entry";
export const LANE_ENTRY_REMOVE_KIND = "lane-entry-remove";

/** The record kinds of lane entries, for the format document. */
export const LANE_RECORD_KINDS = Object.freeze([LANE_ENTRY_KIND, LANE_ENTRY_REMOVE_KIND] as const);

/** The lane of human-authored standing rules (design D14 item 4). */
export const STANDING_RULE_LANE = "standing-rule";

/** Lane names: lowercase words joined by hyphens, as ledger names are. */
export const LANE_NAME_RE = LEDGER_NAME_RE;

/** Longest entry id, in characters. */
export const LANE_ENTRY_ID_MAX = 512;

/**
 * An entry id: a non-empty single line of at most {@link LANE_ENTRY_ID_MAX}
 * characters that is a record path (`record-path.ts`): an entry id becomes
 * a file path under its lane folder (`brainRelOfEntry`), and a synced peer
 * can write any id, so `..`, absolute paths, backslashes, NUL, drive
 * prefixes and empty segments are refused.
 */
export function isLaneEntryId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim() !== "" &&
    value.length <= LANE_ENTRY_ID_MAX &&
    isRecordRelPath(value)
  );
}

/** A lane name from a folder name: lowercase, every other character a hyphen. */
export function laneNameOf(folder: string): string {
  const name = folder
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return LANE_NAME_RE.test(name) ? name : "lane";
}

function plainJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value ?? null)) as T;
}

/** One lane entry, as a writer (or the migration) records it. */
export function laneEntryRecord(input: {
  readonly lane: string;
  readonly entry: string;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly text: string;
  readonly authority: Authority;
  readonly agent?: string;
  readonly private: boolean;
  /** `true`: `private` when this machine holds it, else `shared`. */
  readonly privateWhenHeld?: boolean;
}): DualWriteRecord {
  if (!LANE_NAME_RE.test(input.lane)) throw new Error(`invalid lane name: ${input.lane}`);
  if (!isLaneEntryId(input.entry)) throw new Error(`invalid lane entry id: ${input.entry}`);
  const scope = input.fields["scope"];
  return {
    stream: "events",
    kind: LANE_ENTRY_KIND,
    ...(input.agent !== undefined ? { agent: input.agent } : {}),
    scope: typeof scope === "string" && scope.trim() !== "" ? scope.trim() : null,
    private: input.private,
    ...(input.privateWhenHeld === true ? { privateWhenHeld: true } : {}),
    body: {
      [AUTHORITY_FIELD]: input.authority,
      lane: input.lane,
      entry: input.entry,
      fields: plainJson(input.fields),
      text: input.text,
    },
  };
}

/** The tombstone of one lane entry. */
export function laneEntryRemoveRecord(input: {
  readonly lane: string;
  readonly entry: string;
  readonly authority: Authority;
  readonly private: boolean;
  /** `true`: `private` when this machine holds it, else `shared`. */
  readonly privateWhenHeld?: boolean;
}): DualWriteRecord {
  // The fold rejects a tombstone it cannot place, so refuse it here, loudly.
  if (!LANE_NAME_RE.test(input.lane)) throw new Error(`invalid lane name: ${input.lane}`);
  if (!isLaneEntryId(input.entry)) throw new Error(`invalid lane entry id: ${input.entry}`);
  return {
    stream: "events",
    kind: LANE_ENTRY_REMOVE_KIND,
    private: input.private,
    ...(input.privateWhenHeld === true ? { privateWhenHeld: true } : {}),
    body: { [AUTHORITY_FIELD]: input.authority, lane: input.lane, entry: input.entry },
  };
}

/** The current value of one entry. */
export interface LaneEntryValue {
  readonly lane: string;
  readonly entry: string;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly text: string;
}

export interface LaneEntryState {
  readonly value: LaneEntryValue | null;
  readonly removed: boolean;
  /** Id of the winning record. */
  readonly winner: string;
  readonly history: ReadonlyArray<RegisterEntry<LaneEntryValue>>;
}

export interface LaneFold {
  /** Every entry seen, keyed by `<lane>/<entry>`, removed ones included. */
  readonly entries: ReadonlyMap<string, LaneEntryState>;
  readonly rejected: ReadonlyArray<RejectedRecord>;
}

/** The fold key of an entry. */
export function laneEntryKey(lane: string, entry: string): string {
  return `${lane}/${entry}`;
}

function rejection(record: StoreRecord): string | null {
  if (recordAuthority(record) === null) return "missing or invalid authority";
  const { lane, entry, fields, text } = record.body;
  if (typeof lane !== "string" || !LANE_NAME_RE.test(lane)) return "invalid lane";
  if (!isLaneEntryId(entry)) return "invalid entry id";
  if (record.kind === LANE_ENTRY_REMOVE_KIND) return null;
  if (fields === null || typeof fields !== "object" || Array.isArray(fields)) {
    return "fields must be an object";
  }
  if (typeof text !== "string") return "text must be a string";
  return null;
}

/** Fold lane-entry records (any order, duplicates allowed). */
export function foldLaneEntries(input: Iterable<StoreRecord>): LaneFold {
  const { records } = prepareRecords(input);
  const register = new RegisterSet<LaneEntryValue>();
  const rejected: RejectedRecord[] = [];
  for (const record of records) {
    if (record.kind !== LANE_ENTRY_KIND && record.kind !== LANE_ENTRY_REMOVE_KIND) continue;
    const reason = rejection(record);
    if (reason !== null) {
      rejected.push({ id: record.id, kind: record.kind, reason });
      continue;
    }
    const lane = record.body["lane"] as string;
    const entry = record.body["entry"] as string;
    const value =
      record.kind === LANE_ENTRY_REMOVE_KIND
        ? TOMBSTONE
        : {
            lane,
            entry,
            fields: record.body["fields"] as Record<string, unknown>,
            text: record.body["text"] as string,
          };
    register.offer(laneEntryKey(lane, entry), {
      record,
      authority: recordAuthority(record)!,
      value,
    });
  }
  const entries = new Map<string, LaneEntryState>();
  for (const key of register.keys()) {
    const state = register.get(key)!;
    entries.set(key, {
      value: state.value,
      removed: state.removed,
      winner: state.winner.record.id,
      history: state.history,
    });
  }
  return { entries, rejected };
}
