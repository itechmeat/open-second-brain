/**
 * The preference fold (design D4, task 1.6): the state of every
 * preference computed from its records, in any delivery order.
 *
 * Input records (kinds from `constants.ts`, usually in the `events` stream):
 *
 *  - `preference-set` `{ authority, preference, fields: { <name>: <json> } }`:
 *    proposes a value for each named field. Every field is its own
 *    register, resolved by authority, then clock, so a human retire
 *    (`status: "retired"`) is not undone by a later agent edit while an
 *    agent may still refine a field no human has touched. A set also
 *    proposes that the preference exists.
 *  - `preference-remove` `{ authority, preference }`: a tombstone on the
 *    preference's existence, resolved by the same rule. The records and
 *    the last field values stay; the preference simply no longer exists.
 *  - `preference-evidence` `{ preference, result, artifact? }`: one
 *    application of the rule. The counters `applied_count`,
 *    `violated_count` and `outdated_count` are derived from these records
 *    and are never written back; a set that names a counter field is
 *    ignored for that field, and a set that names only counters is
 *    rejected (it would otherwise propose existence with no field). Evidence never changes a field or the
 *    existence, so a retired preference stays retired however much
 *    evidence later arrives; the evidence is kept in its history.
 *
 * Output: one {@link PreferenceState} per preference id, with the winning
 * values, the record that won each, the derived counters and the full
 * history, plus the records rejected as malformed.
 */

import {
  EVIDENCE_RESULTS,
  PREFERENCE_COUNTER_FIELDS,
  PREFERENCE_EVIDENCE_KIND,
  PREFERENCE_REMOVE_KIND,
  PREFERENCE_SET_KIND,
  type EvidenceResult,
} from "./constants.ts";
import type { StoreRecord } from "./envelope.ts";
import {
  prepareRecords,
  recordAuthority,
  RegisterSet,
  TOMBSTONE,
  type RejectedRecord,
} from "./fold.ts";

/** Field names: lowercase words joined by underscores. */
export const PREFERENCE_FIELD_RE = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_ID_LENGTH = 200;

export type PreferenceCounters = {
  readonly [K in (typeof PREFERENCE_COUNTER_FIELDS)[number]]: number;
};

export interface PreferenceState {
  readonly id: string;
  /** Whether a set won the existence register (no removal beat it). */
  readonly exists: boolean;
  /** Whether a removal won the existence register. */
  readonly removed: boolean;
  /** Winning field values, keys in code unit order. */
  readonly fields: Readonly<Record<string, unknown>>;
  /** Id of the record that won each field. */
  readonly fieldWinners: Readonly<Record<string, string>>;
  /** Id of the record that won the existence register, or `null` with evidence only. */
  readonly existenceWinner: string | null;
  /** Counters derived from evidence; never written back. */
  readonly counters: PreferenceCounters;
  /** Every set, removal and evidence record of this preference, in fold order. */
  readonly history: ReadonlyArray<StoreRecord>;
}

export interface PreferencesFold {
  /** Preference states by id, inserted in code unit order of the id. */
  readonly preferences: ReadonlyMap<string, PreferenceState>;
  readonly rejected: ReadonlyArray<RejectedRecord>;
}

const COUNTER_OF: Readonly<Record<EvidenceResult, keyof PreferenceCounters>> = {
  applied: "applied_count",
  violated: "violated_count",
  outdated: "outdated_count",
};

const COUNTERS = new Set<string>(PREFERENCE_COUNTER_FIELDS);
const KINDS = new Set<string>([
  PREFERENCE_SET_KIND,
  PREFERENCE_REMOVE_KIND,
  PREFERENCE_EVIDENCE_KIND,
]);

function preferenceId(record: StoreRecord): string | null {
  const id = record.body["preference"];
  if (typeof id !== "string" || id.trim() === "" || id.length > MAX_ID_LENGTH) return null;
  return /[\r\n]/.test(id) ? null : id;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Why a record of a preference kind cannot be applied, or `null` when it can. */
function rejection(record: StoreRecord): string | null {
  if (preferenceId(record) === null) return "missing or invalid preference id";
  if (record.kind === PREFERENCE_EVIDENCE_KIND) {
    const result = record.body["result"];
    return (EVIDENCE_RESULTS as ReadonlyArray<unknown>).includes(result)
      ? null
      : `evidence result must be one of ${EVIDENCE_RESULTS.join(", ")}`;
  }
  if (recordAuthority(record) === null) return "missing or invalid authority";
  if (record.kind === PREFERENCE_REMOVE_KIND) return null;
  const fields = record.body["fields"];
  if (!isPlainObject(fields) || Object.keys(fields).length === 0) {
    return "fields must be a non-empty object";
  }
  const bad = Object.keys(fields).find((name) => !PREFERENCE_FIELD_RE.test(name));
  if (bad !== undefined) return `invalid field name "${bad}"`;
  // A set that names only derived counters would change no field yet still
  // propose that the preference exists (and could undo a removal).
  return Object.keys(fields).some((name) => !COUNTERS.has(name))
    ? null
    : "fields name only derived counters";
}

const fieldKey = (id: string, field: string): string => `${id}\u0000${field}`;

/** Counters of a preference with no evidence yet, one per counter field. */
function zeroCounters(): Record<keyof PreferenceCounters, number> {
  return Object.fromEntries(PREFERENCE_COUNTER_FIELDS.map((name) => [name, 0])) as Record<
    keyof PreferenceCounters,
    number
  >;
}

/** Fold preference records (any order, duplicates allowed) into preference states. */
export function foldPreferences(input: Iterable<StoreRecord>): PreferencesFold {
  const { records } = prepareRecords(input);
  const existence = new RegisterSet<true>();
  const fields = new RegisterSet<unknown>();
  const fieldNames = new Map<string, Set<string>>();
  const history = new Map<string, StoreRecord[]>();
  const counters = new Map<string, Record<keyof PreferenceCounters, number>>();
  const rejected: RejectedRecord[] = [];
  // Fold-order position of every record, and of each preference's tombstones.
  const position = new Map<string, number>();
  const removes = new Map<string, number[]>();

  for (const [index, record] of records.entries()) {
    position.set(record.id, index);
    if (!KINDS.has(record.kind)) continue;
    const reason = rejection(record);
    if (reason !== null) {
      rejected.push({ id: record.id, kind: record.kind, reason });
      continue;
    }
    const id = preferenceId(record)!;
    const own = history.get(id) ?? [];
    own.push(record);
    history.set(id, own);
    if (record.kind === PREFERENCE_EVIDENCE_KIND) {
      const count = counters.get(id) ?? zeroCounters();
      count[COUNTER_OF[record.body["result"] as EvidenceResult]] += 1;
      counters.set(id, count);
      continue;
    }
    const authority = recordAuthority(record)!;
    if (record.kind === PREFERENCE_REMOVE_KIND) {
      existence.offer(id, { record, authority, value: TOMBSTONE });
      removes.set(id, [...(removes.get(id) ?? []), index]);
      continue;
    }
    existence.offer(id, { record, authority, value: true });
    const names = fieldNames.get(id) ?? new Set<string>();
    for (const [name, value] of Object.entries(record.body["fields"] as Record<string, unknown>)) {
      if (COUNTERS.has(name)) continue; // derived, never written back
      names.add(name);
      fields.offer(fieldKey(id, name), { record, authority, value });
    }
    fieldNames.set(id, names);
  }

  const preferences = new Map<string, PreferenceState>();
  for (const id of [...history.keys()].toSorted()) {
    const exist = existence.get(id);
    const values: Record<string, unknown> = {};
    const winners: Record<string, string> = {};
    // A removed preference keeps no content in the fold: its fields (the
    // principle, the prose `text`, ...) are dropped from every read, so a
    // forgotten preference shows nowhere. The shards still hold the lines
    // until store compaction exists (FORMAT.md, "Removal").
    const removed = exist?.removed ?? false;
    // Re-created after a tombstone (the existence winner is a set later in
    // fold order): the forgotten preference's fields stay forgotten, so
    // only the sets after the tombstone offer field values. The cut is the
    // last tombstone BEFORE the winner: a later tombstone that lost the
    // existence register must not hide an earlier one the winner re-created
    // over.
    const winnerAt = exist === undefined ? -1 : position.get(exist.winner.record.id)!;
    const cut = (removes.get(id) ?? []).findLast((at) => at < winnerAt);
    const recreated = !removed && exist !== undefined && cut !== undefined;
    if (recreated) {
      const after = new RegisterSet<unknown>();
      const names = new Set<string>();
      for (const record of history.get(id)!) {
        if (record.kind !== PREFERENCE_SET_KIND || position.get(record.id)! < cut) continue;
        const authority = recordAuthority(record)!;
        for (const [name, value] of Object.entries(
          record.body["fields"] as Record<string, unknown>,
        )) {
          if (COUNTERS.has(name)) continue;
          names.add(name);
          after.offer(name, { record, authority, value });
        }
      }
      for (const name of [...names].toSorted()) {
        const state = after.get(name)!;
        values[name] = state.value;
        winners[name] = state.winner.record.id;
      }
    }
    for (const name of removed || recreated ? [] : [...(fieldNames.get(id) ?? [])].toSorted()) {
      const state = fields.get(fieldKey(id, name))!;
      values[name] = state.value;
      winners[name] = state.winner.record.id;
    }
    preferences.set(id, {
      id,
      exists: exist !== undefined && !exist.removed,
      removed: exist?.removed ?? false,
      fields: values,
      fieldWinners: winners,
      existenceWinner: exist?.winner.record.id ?? null,
      counters: counters.get(id) ?? zeroCounters(),
      history: history.get(id)!,
    });
  }
  return { preferences, rejected };
}

/**
 * The resolved preference state as plain JSON, for the state digest: what
 * every machine must agree on for the same records. History is left out;
 * it is the records themselves, which the digest's cut already pins.
 */
export function preferencesFingerprint(fold: PreferencesFold): unknown {
  // `Object.fromEntries` defines own properties, so an id such as
  // `__proto__` is a key like any other and is never dropped from the hash.
  const out = Object.fromEntries(
    [...fold.preferences].map(([id, state]) => [
      id,
      {
        exists: state.exists,
        removed: state.removed,
        fields: state.fields,
        field_winners: state.fieldWinners,
        existence_winner: state.existenceWinner,
        counters: state.counters,
      },
    ]),
  );
  return { preferences: out, rejected: fold.rejected.map((r) => r.id) };
}
