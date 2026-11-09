/**
 * What the store's tombstones made void and the append-only shards still
 * hold (FORMAT.md, "Removal"). A tombstone (`signal-removed`,
 * `preference-remove`, `lane-entry-remove`) takes its entity out of every
 * read at once, but the earlier lines stay in the shards, on this machine
 * and on every machine the shards sync to, until store compaction exists
 * (a later phase). This module counts those lines, so the doctor can say
 * how much removed content still awaits compaction.
 */

import { canonicalJson } from "../integrity/digest.ts";
import { PREFERENCE_REMOVE_KIND, SIGNAL_KIND } from "./constants.ts";
import type { StoreRecord } from "./envelope.ts";
import { foldPreferences } from "./fold-preferences.ts";
import { foldSignals, SIGNAL_REMOVED_KIND, SIGNAL_STATE_KIND } from "./fold-signals.ts";
import { foldLaneEntries, LANE_ENTRY_KIND, LANE_ENTRY_REMOVE_KIND } from "./lane-records.ts";

/** Lines of removed content the shards still hold, by what was removed. */
export interface RemovalBacklog {
  readonly signals: number;
  readonly preferences: number;
  readonly laneEntries: number;
  readonly total: number;
}

const SIGNAL_KINDS = new Set([SIGNAL_KIND, SIGNAL_STATE_KIND, SIGNAL_REMOVED_KIND]);
const LANE_KINDS = new Set([LANE_ENTRY_KIND, LANE_ENTRY_REMOVE_KIND]);

/** Count the voided lines among `records` (any order, duplicates allowed). */
export function removalBacklog(records: ReadonlyArray<StoreRecord>): RemovalBacklog {
  const signalFold = foldSignals(records.filter((r) => SIGNAL_KINDS.has(r.kind)));
  let signals = 0;
  for (const count of signalFold.removed.values()) signals += count;

  let preferences = 0;
  for (const state of foldPreferences(records).preferences.values()) {
    if (!state.removed) continue;
    preferences += state.history.filter((r) => r.kind !== PREFERENCE_REMOVE_KIND).length;
  }

  // A lane tombstone is also the old half of a move (an archive move writes
  // the tombstone and the new entry together): an entry whose last content
  // lives on under another entry was moved, not removed, and is not counted.
  const lanes = foldLaneEntries(records.filter((r) => LANE_KINDS.has(r.kind)));
  const live = new Set<string>();
  for (const state of lanes.entries.values()) {
    if (state.value !== null) {
      live.add(contentKey(state.value.lane, state.value.fields, state.value.text));
    }
  }
  let laneEntries = 0;
  for (const state of lanes.entries.values()) {
    if (!state.removed) continue;
    const contents = state.history.filter((h) => h.record.kind === LANE_ENTRY_KIND);
    const last = contents.at(-1)?.record.body;
    if (last !== undefined && live.has(contentKey(last["lane"], last["fields"], last["text"]))) {
      continue;
    }
    laneEntries += contents.length;
  }
  return { signals, preferences, laneEntries, total: signals + preferences + laneEntries };
}

/**
 * A move stays in its lane (an archive folder, a bundle applied), so the
 * key names the lane; the serialisation ignores key order, so a move whose
 * fields were written back in another order is still a move.
 */
function contentKey(lane: unknown, fields: unknown, text: unknown): string {
  return canonicalJson([lane ?? null, fields ?? null, text ?? null]);
}

/** The kinds of the tombstones whose voided records leave every reader. */
export const TOMBSTONE_KINDS: ReadonlySet<string> = new Set([
  SIGNAL_REMOVED_KIND,
  PREFERENCE_REMOVE_KIND,
  LANE_ENTRY_REMOVE_KIND,
]);

/**
 * Ids of the records the tombstones among `records` made void: a forgotten
 * signal's earlier records, a removed preference's records (its tombstone
 * aside), and a removed lane entry's content records. Readers that index
 * records one by one (the search index) drop these.
 */
export function voidedRecordIds(records: ReadonlyArray<StoreRecord>): ReadonlySet<string> {
  const out = new Set<string>(foldSignals(records.filter((r) => SIGNAL_KINDS.has(r.kind))).voided);
  for (const state of foldPreferences(records).preferences.values()) {
    if (!state.removed) continue;
    for (const r of state.history) if (r.kind !== PREFERENCE_REMOVE_KIND) out.add(r.id);
  }
  const lanes = foldLaneEntries(records.filter((r) => LANE_KINDS.has(r.kind)));
  for (const state of lanes.entries.values()) {
    if (!state.removed) continue;
    for (const h of state.history) if (h.record.kind === LANE_ENTRY_KIND) out.add(h.record.id);
  }
  return out;
}
