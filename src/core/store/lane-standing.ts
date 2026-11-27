/**
 * The standing of a lane write on a store-only machine (change
 * `tool-lane-write-keeps-standing`): a lane entry is a register resolved by
 * authority, then clock, and a write takes the authority of the process
 * that made it, so an agent's rewrite of an entry a person wrote used to
 * lose to the version it replaced, and the next read showed the old one.
 *
 * The kept standing (design D1): a write that replaces, removes, moves or
 * re-creates an entry is stored at the stronger of the writer's own
 * authority and the authority of the record that holds the key, live or a
 * removal, read from the fold the write builds its records from. The
 * record names the writer's own authority in `acted_by` when the two
 * differ (design D4). A version another device wrote apart is still
 * arbitrated by the authority order, then the clock.
 *
 * The base of a read-modify-write (design D2): a writer that computed its
 * write from an entry it read passes that read (`readLaneBase`) as
 * `replaces`, and the write is refused with a {@link LaneEntryChangedError}
 * when the store no longer holds it or could not be read whole, before any
 * record is built, so the refusal reaches the caller as itself with its own
 * remedy.
 *
 * Reach before the base (design D7): below local reach a holder held in
 * `private` is never named. The reach guard of the write runs first; the
 * base check then judges the fold it reads itself, and answers the fixed
 * answer (`LaneEntryWithheldError`) instead of a refusal that would say the
 * entry changed or the store has a gap.
 *
 * The read-back (design D3): after the store write returns, the entry is
 * read again from a fresh fold, and a write the store does not apply (a
 * value it does not hold, an entry still there after a removal) fails
 * with a {@link LaneWriteNotAppliedError} that names the record holding
 * the entry, so no answer reports a state the next read does not show.
 * Below local reach, where that holder is held in `private` or the fold
 * may miss a record, the fixed answer is given instead.
 *
 * `lane-pages.ts` calls in here; this module holds the rule and nothing
 * that writes. The record builders (`lane-entry-store.ts`,
 * `lane-dual-moves.ts`) take the authority order from the leaf
 * `lane-authority.ts` and never import this module, which imports them.
 */

import type { AppendResult } from "./appender.ts";
import { privateWithheld } from "./caller-reach.ts";
import {
  LaneEntryChangedError,
  LaneWriteNotAppliedError,
  LaneWriteUnverifiedError,
  strongerAuthority,
} from "./lane-authority.ts";
import {
  brainRelOf,
  heldInStore,
  holderAuthority,
  insideBrain,
  lanePagesInStore,
  readLaneEntrySnapshot,
  sameEntry,
  storeEntryRead,
  type LaneEntrySnapshot,
} from "./lane-entry-store.ts";
import {
  freshLaneStoreFold,
  laneFoldIncomplete,
  wholeLaneStoreFold,
  type LaneFolded,
} from "./lane-fold-cache.ts";
import { assertHolderReadableAtReach, winnerHeldInPrivate } from "./lane-reach-guard.ts";
import { brainRelOfEntry, lanePlaceOf } from "./lane-paths.ts";
import { laneTextParts, rawToKeep } from "./lane-raw.ts";
import { LANE_ENTRY_KIND, LANE_ENTRY_REMOVE_KIND, laneEntryKey } from "./lane-records.ts";
import type { Authority } from "./constants.ts";

// The authority order and the refusals live in the leaf `lane-authority.ts`,
// and the holder of a key in `lane-entry-store.ts`, so the record builders
// take them without importing this module (which reads the fold and the
// reach guard); this module keeps naming them for its callers.
export {
  LaneEntryChangedError,
  LaneWriteNotAppliedError,
  LaneWriteUnverifiedError,
  strongerAuthority,
  type LaneEntryChangedReason,
} from "./lane-authority.ts";
export { holderAuthority } from "./lane-entry-store.ts";

/**
 * The standing a moved entry keeps: the stronger of the holders of its
 * source and of its destination (a live entry or a removal there), both
 * read from `fold`.
 */
export function movedStanding(
  vault: string,
  fold: LaneFolded,
  from: string,
  to: string,
): Authority | null {
  return strongerAuthority(holderAuthority(vault, fold, from), holderAuthority(vault, fold, to));
}

// ----- The base of a read-modify-write (design D2) ------------------------------

/**
 * The base of a read-modify-write of the lane entry at `path`: the entry
 * read once ({@link readLaneEntrySnapshot}) on a store-held path, `null`
 * otherwise (no entry there, or a machine whose lane pages are files).
 * Take it under the entry's lane lock, before the read the write is
 * computed from.
 */
export function readLaneBase(
  vault: string,
  path: string,
  configPath?: string,
): LaneEntrySnapshot | null {
  return heldInStore(vault, path, configPath)
    ? readLaneEntrySnapshot(vault, path, configPath)
    : null;
}

/**
 * Below local reach, refuse with the fixed answer a write whose key the
 * fold of every partition, read now, holds in `private` (a live entry or a
 * removal) or that fold may miss a record: the answer that follows would
 * otherwise speak of a holder the caller may not read. Nothing at local
 * reach or for a path that names no lane entry.
 */
function assertHolderAtReach(vault: string, path: string, configPath?: string): void {
  if (!privateWithheld() || !insideBrain(vault, path)) return;
  const place = lanePlaceOf(brainRelOf(vault, path));
  if (place === null) return;
  const fold = wholeLaneStoreFold(configPath);
  assertHolderReadableAtReach(
    laneFoldIncomplete(fold) || winnerHeldInPrivate(place.lane, place.entry, configPath),
  );
}

/**
 * Refuse a write computed from `replaces` when the store no longer holds
 * that version (`changed`) or could not be read whole, when the base was
 * read or now (`incomplete`: a gap that opened after the base is a gap,
 * not a change). Below local reach a key held in `private`, or a fold that
 * may miss a record, gets the fixed answer first ({@link
 * assertHolderAtReach}). Nothing for a null base or a path the store does
 * not hold. Runs before the store write, after the write's reach guard,
 * never inside its record builder.
 */
export function checkLaneBase(
  vault: string,
  path: string,
  replaces: LaneEntrySnapshot | null | undefined,
  configPath?: string,
): void {
  if (replaces === null || replaces === undefined || !heldInStore(vault, path, configPath)) return;
  assertHolderAtReach(vault, path, configPath);
  const rel = brainRelOf(vault, path);
  if (!replaces.whole) throw new LaneEntryChangedError(rel, "incomplete");
  if (replaces.unchanged()) return;
  const now = storeEntryRead(vault, path, configPath);
  throw new LaneEntryChangedError(
    rel,
    !now.whole ? "incomplete" : now.removed ? "removed" : "changed",
  );
}

// ----- The read-back (design D3) ------------------------------------------------

/** What a write left at one key: the value it wrote, or `null` for no live entry. */
interface WrittenEntry {
  readonly lane: string;
  readonly entry: string;
  readonly value: {
    readonly fields: Readonly<Record<string, unknown>>;
    readonly text: string;
    readonly raw?: string;
  } | null;
}

/** The fields as a record carries them (`laneEntryRecord` stores them as plain JSON). */
function asStored(fields: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return JSON.parse(JSON.stringify(fields ?? null)) as Record<string, unknown>;
}

/**
 * Read the written keys back from a fresh fold of every partition (read
 * anew, not stored: `freshLaneStoreFold`) and refuse the call when one
 * does not hold what the write left there. {@link LaneWriteNotAppliedError}
 * only when that fold was read in full and shows another winner for the
 * key; a read-back that could not be made (the read failed, the fold may
 * miss a record, or it holds no record of the key) is
 * {@link LaneWriteUnverifiedError}: the record was appended. Below local
 * reach a holder held in `private`, or a fold that may miss a record, gets
 * the fixed answer instead.
 */
function assertWriteApplied(written: ReadonlyArray<WrittenEntry>, configPath?: string): void {
  if (written.length === 0) return;
  let fold: LaneFolded;
  try {
    fold = freshLaneStoreFold(configPath);
  } catch {
    const first = written[0]!;
    throw new LaneWriteUnverifiedError(brainRelOfEntry(first.lane, first.entry));
  }
  for (const want of written) {
    const key = laneEntryKey(want.lane, want.entry);
    const value = fold.entries.get(key) ?? null;
    const applied =
      want.value === null
        ? value === null
        : sameEntry(value, want.value.fields, want.value.text, want.value.raw);
    if (applied) continue;
    const incomplete = laneFoldIncomplete(fold);
    assertHolderReadableAtReach(
      incomplete || winnerHeldInPrivate(want.lane, want.entry, configPath),
    );
    const heldBy = fold.authorities.get(key) ?? null;
    const path = brainRelOfEntry(want.lane, want.entry);
    if (incomplete || heldBy === null) throw new LaneWriteUnverifiedError(path);
    throw new LaneWriteNotAppliedError(path, heldBy, value === null);
  }
}

/** The lane entry the store-held path `path` names, or null. */
function placeAt(
  vault: string,
  path: string,
  configPath?: string,
): { lane: string; entry: string } | null {
  if (!heldInStore(vault, path, configPath)) return null;
  return lanePlaceOf(brainRelOf(vault, path));
}

/**
 * The read-back of `writeLaneText(vault, path, text)`: the entry holds the
 * fields, text and kept raw text the write's record carried. Nothing on a
 * path the store does not hold.
 */
export function readBackLaneText(vault: string, path: string, text: string): void {
  const place = placeAt(vault, path);
  if (place === null) return;
  const { fields, body } = laneTextParts(path, text);
  const raw = rawToKeep(path, rawToKeep(path, text, fields, body), fields, body);
  assertWriteApplied([
    {
      ...place,
      value: {
        fields: asStored(fields),
        text: body,
        ...(raw !== undefined ? { raw } : {}),
      },
    },
  ]);
}

/**
 * The read-back of `writeLanePage(vault, path, frontmatter, body)`: the
 * entry holds that frontmatter and body. Nothing on a path the store does
 * not hold.
 */
export function readBackLanePage(
  vault: string,
  path: string,
  frontmatter: Readonly<Record<string, unknown>>,
  body: string,
  configPath?: string,
): void {
  const place = placeAt(vault, path, configPath);
  if (place === null) return;
  assertWriteApplied(
    [{ ...place, value: { fields: asStored(frontmatter), text: body } }],
    configPath,
  );
}

/**
 * The read-back of a store write that removed or moved lane entries (a
 * page or a folder): for every key its records touched, the last of them
 * decides what the key must hold now, the value a `lane-entry` carried or
 * no live entry after a `lane-entry-remove`. Returns `results`, so the
 * call wraps the store write it reads back.
 */
export function readBackAppended<T extends ReadonlyArray<AppendResult>>(
  vault: string,
  results: T,
  configPath?: string,
): T {
  if (!lanePagesInStore(vault, configPath)) return results;
  const byKey = new Map<string, WrittenEntry>();
  for (const { record } of results) {
    if (record.kind !== LANE_ENTRY_KIND && record.kind !== LANE_ENTRY_REMOVE_KIND) continue;
    const lane = String(record.body["lane"]);
    const entry = String(record.body["entry"]);
    const raw = record.body["raw"];
    byKey.set(laneEntryKey(lane, entry), {
      lane,
      entry,
      value:
        record.kind === LANE_ENTRY_REMOVE_KIND
          ? null
          : {
              fields: record.body["fields"] as Record<string, unknown>,
              text: String(record.body["text"]),
              ...(typeof raw === "string" ? { raw } : {}),
            },
    });
  }
  assertWriteApplied([...byKey.values()], configPath);
  return results;
}
