/**
 * The brain store records the search index must not hold: every record an
 * entity reader leaves out of what it shows (design D5, FORMAT.md
 * "Removal"), and every record of a signal still waiting for write
 * approval. The ingest (`catch-up.ts`) and the query
 * (`entity-filter.ts`) both ask {@link forgottenRecordIds}, so they agree.
 *
 * A record counts as forgotten in two ways, and the index agrees with the
 * readers on both:
 *
 *  - A tombstone voided it (`signal-removed`, `preference-remove`,
 *    `lane-entry-remove`): {@link voidedRecordIds}.
 *  - Its entity carries the lifecycle mark `_status: tombstoned` (or the
 *    normalised `status: tombstoned`) in its current frontmatter or fields:
 *    a signal whose captured frontmatter, with every field change applied,
 *    is tombstoned (a signal the legacy `o2b brain lifecycle tombstone`
 *    marked before the migration carries the mark in its capture), a
 *    preference whose winning fields are tombstoned, a lane entry whose
 *    current fields are. Recall, the briefs, the active preferences and
 *    the dream pass leave such an entity out (`isTombstoned`), so every
 *    record of its history leaves the index.
 *
 * A staged signal (captured while write approval is on, state `staged`)
 * is kept out too, as the legacy index kept `Brain/pending/` out
 * (`admitToIndex`): no operator has admitted it yet. Once approved it is
 * an inbox signal and becomes searchable.
 *
 * A signal moved to another lifecycle state (consumed, archived, retired,
 * rejected) is not forgotten: its page stayed searchable in the legacy
 * tree, and its records stay searchable in the store.
 */

import { isTombstoned } from "../../brain/lifecycle/tombstone-read.ts";
import {
  PREFERENCE_EVIDENCE_KIND,
  PREFERENCE_REMOVE_KIND,
  PREFERENCE_SET_KIND,
  SIGNAL_KIND,
} from "../../store/constants.ts";
import type { StoreRecord } from "../../store/envelope.ts";
import { foldPreferences } from "../../store/fold-preferences.ts";
import { foldSignals, SIGNAL_REMOVED_KIND, SIGNAL_STATE_KIND } from "../../store/fold-signals.ts";
import {
  foldLaneEntries,
  LANE_ENTRY_KIND,
  LANE_ENTRY_REMOVE_KIND,
} from "../../store/lane-records.ts";
import { isVoidingFoldInput, voidedRecordIds } from "../../store/removal-backlog.ts";

export { isVoidingFoldInput as isForgettingFoldInput };

const FOLD_KINDS: ReadonlySet<string> = new Set([
  SIGNAL_KIND,
  SIGNAL_STATE_KIND,
  SIGNAL_REMOVED_KIND,
  LANE_ENTRY_KIND,
  LANE_ENTRY_REMOVE_KIND,
  PREFERENCE_SET_KIND,
  PREFERENCE_REMOVE_KIND,
  PREFERENCE_EVIDENCE_KIND,
]);

/** Whether records of `kind` are read by the forgetting folds (`isVoidingFoldInput` by kind). */
export function isForgettingFoldKind(kind: string): boolean {
  return FOLD_KINDS.has(kind);
}

const SIGNAL_KINDS: ReadonlySet<string> = new Set([
  SIGNAL_KIND,
  SIGNAL_STATE_KIND,
  SIGNAL_REMOVED_KIND,
]);
const LANE_KINDS: ReadonlySet<string> = new Set([LANE_ENTRY_KIND, LANE_ENTRY_REMOVE_KIND]);

/** The on-disk frontmatter key of the lifecycle status (`tombstone-read.ts`). */
const LIFECYCLE_STATUS_KEY = "_status";

/** The normalised key a preference's fields carry it under. */
const NORMALISED_STATUS_KEY = "status";

/** The lifecycle status that forgets an entity. */
const TOMBSTONED = "tombstoned";

/** The `signal-state` moves that put a signal into, or take it out of, write approval. */
const APPROVAL_STATES: ReadonlySet<unknown> = new Set(["staged", "approved", "rejected"]);

/** The two body fields an entity's frontmatter travels in: a capture's and a change's. */
const FRONTMATTER_FIELDS = ["frontmatter", "fields"] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether `record` sets or clears a lifecycle status of its entity: its
 * captured frontmatter or its changed fields name `_status` (any value,
 * a `null` clearing it included), or carry `status: tombstoned`. A pass
 * that reads one must fold the entity again, as a pass that reads a
 * tombstone does: it may forget the entity, or bring a forgotten one back.
 * A preference's ordinary `status` changes (confirmed, retired) are not
 * marks, or every preference write would fold the store again. A staged
 * capture and a move into or out of write approval are marks too.
 */
export function carriesLifecycleMark(record: StoreRecord): boolean {
  if (!isVoidingFoldInput(record)) return false;
  if (record.kind === SIGNAL_KIND && record.body["staged"] === true) return true;
  if (record.kind === SIGNAL_STATE_KIND && APPROVAL_STATES.has(record.body["state"])) return true;
  for (const field of FRONTMATTER_FIELDS) {
    const value = record.body[field];
    if (!isPlainObject(value)) continue;
    if (LIFECYCLE_STATUS_KEY in value || value[NORMALISED_STATUS_KEY] === TOMBSTONED) return true;
  }
  return false;
}

/**
 * Ids of the records among `records` the index must not hold: the voided
 * ones, every record of an entity marked tombstoned and every record of a
 * staged signal (see the module docblock). Any order, duplicates allowed.
 */
export function forgottenRecordIds(records: ReadonlyArray<StoreRecord>): ReadonlySet<string> {
  const out = new Set<string>(voidedRecordIds(records));
  const signals = foldSignals(records.filter((r) => SIGNAL_KINDS.has(r.kind)));
  for (const entry of signals.signals.values()) {
    if (entry.state !== "staged" && !isTombstoned(entry.frontmatter)) continue;
    for (const r of entry.history) out.add(r.id);
  }
  for (const state of foldPreferences(records).preferences.values()) {
    if (!state.exists || !isTombstoned(state.fields)) continue;
    for (const r of state.history) out.add(r.id);
  }
  const lanes = foldLaneEntries(records.filter((r) => LANE_KINDS.has(r.kind)));
  for (const state of lanes.entries.values()) {
    if (state.value === null || !isPlainObject(state.value.fields)) continue;
    if (!isTombstoned(state.value.fields)) continue;
    for (const h of state.history) out.add(h.record.id);
  }
  return out;
}
