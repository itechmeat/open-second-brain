/**
 * The members of a cleanup by source below local reach (change
 * `lane-reach-residuals`, package 11, design R9): a cleanup with a member
 * held in `private` is refused whole, with the fixed answer, before its
 * first removal, and its dry run gives the same answer.
 *
 * A cleanup's derived set holds lane entries (the summary, the entity
 * pages) and memory records (signals, preferences, retired pages), which
 * are store records of their own and are judged by the partition that
 * holds them, not as lane keys. The lane entries are judged again when
 * they are removed: below local reach they go in one store write whose
 * record builder reads one fold of every partition, so an entry raised to
 * `private` between the first check and the write refuses the whole
 * removal instead of being left out (design R5). Outside that scope
 * nothing here applies and the cleanup runs as before.
 */

import { join } from "node:path";

import { privateWithheld, withPrivateShown } from "../store/caller-reach.ts";
import { LaneWriteNotAppliedError } from "../store/lane-authority.ts";
import { brainRelOf, heldInStore } from "../store/lane-entry-store.ts";
import { lanePageExists } from "../store/lane-pages.ts";
import { brainRelOfEntry, lanePlaceOf } from "../store/lane-paths.ts";
import {
  LaneEntryWithheldError,
  removalRecordsAtReach,
  storeWriteAtReach,
  treeMembersAtReach,
} from "../store/lane-reach-guard.ts";
import { readBackAppended } from "../store/lane-standing.ts";
import { storeWrite } from "../store/store-write.ts";
import { storeMemoryPageAt } from "./memory-pages.ts";

/**
 * Below local reach, refuse a cleanup whose derived members, listed by
 * `list` (vault-relative paths) on the fold of every partition, hold one
 * in `private`: a lane entry (or any lane entry while that fold may miss a
 * `private` record), or a memory record the store holds in `private`.
 * Outside that scope nothing is read.
 */
export function assertCleanupMembersAtReach(
  vault: string,
  list: () => ReadonlyArray<string>,
): void {
  if (!privateWithheld()) return;
  const members = withPrivateShown(list);
  treeMembersAtReach(vault, () => members.map((rel) => join(vault, rel)));
  const heldPrivately = withPrivateShown(() =>
    members.some((rel) => storeMemoryPageAt(vault, rel)?.private === true),
  );
  if (heldPrivately) throw new LaneEntryWithheldError();
}

/** The lane entries a cleanup removed in one store write, and the read-back of that write. */
export interface CleanupLaneRemoval {
  /** The vault-relative paths whose removal was appended. */
  readonly removed: ReadonlyArray<string>;
  /**
   * Read the write back (`readBackAppended`): throws
   * `LaneWriteUnverifiedError` when that read could not be made, the
   * removals staying in `named` (the paths the caller names as removed),
   * and `LaneWriteNotAppliedError` when another record holds a key, after
   * dropping that key's path from `named`: its removal does not hold.
   */
  readBack(named: string[]): void;
}

const NO_REMOVAL: CleanupLaneRemoval = Object.freeze({ removed: [], readBack: () => {} });

/**
 * Below local reach, remove the cleanup's derived lane entries among
 * `rels` (vault-relative paths) in one store write, each judged again from
 * the fold the write builds its records from: one raised to `private`
 * since the first check refuses the whole removal before any record. The
 * memory records and the files of an unswitched machine are left to the
 * cleanup's own removal. Answers the paths whose removal was appended and
 * the read-back still to make: the caller records them as removed first,
 * so a read-back that could not be made never leaves an appended removal
 * out of the cleanup's answer and audit, and the read-back drops from
 * that record a removal the store did not apply. Removes nothing outside
 * that scope, where every member is removed one by one as before.
 */
export function removeCleanupLaneMembersAtReach(
  vault: string,
  rels: ReadonlyArray<string>,
): CleanupLaneRemoval {
  if (!privateWithheld()) return NO_REMOVAL;
  const lane = rels.filter(
    (rel) =>
      heldInStore(vault, join(vault, rel)) &&
      storeMemoryPageAt(vault, rel) === null &&
      lanePageExists(vault, join(vault, rel)),
  );
  if (lane.length === 0) return NO_REMOVAL;
  const appended = storeWriteAtReach(() =>
    storeWrite(
      () =>
        removalRecordsAtReach(
          vault,
          lane.map((rel) => join(vault, rel)),
        ),
      { vault },
    ),
  );
  return {
    removed: appended.length > 0 ? lane : [],
    readBack: (named) => {
      try {
        readBackAppended(vault, appended);
      } catch (error) {
        if (error instanceof LaneWriteNotAppliedError) {
          const at = named.findIndex(
            (rel) => lane.includes(rel) && entryPathOf(vault, rel) === error.path,
          );
          if (at >= 0) named.splice(at, 1);
        }
        throw error;
      }
    },
  };
}

/** The `Brain/`-relative path of the lane entry at `rel`, as the read-back names it. */
function entryPathOf(vault: string, rel: string): string | null {
  const place = lanePlaceOf(brainRelOf(vault, join(vault, rel)));
  return place === null ? null : brainRelOfEntry(place.lane, place.entry);
}
