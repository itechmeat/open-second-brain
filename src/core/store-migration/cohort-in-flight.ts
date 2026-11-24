/**
 * The one predicate the legacy-tree removal asks before it moves anything
 * (patch 2.0.1): whether another device of the cohort is known to have
 * switched to the brain store while its records have not arrived on this
 * machine.
 *
 * Such a device writes only to the store, so its legacy evidence stops at
 * its switch, and after `migration.silent_device_days` the cohort would
 * retire it by silence. If its store never reached this machine (it sat
 * at the 2.0.0 default outside the vault, or the sync tool skips the
 * vault's hidden store folder), the legacy tree is the only place both
 * machines' records still meet, and removing it would hide the split
 * instead of healing it. Known means one of:
 *
 *  - its migration mark (the `store-migration` snapshot event) is in the
 *    synced legacy log, and no switch record of it (`device-switched`, or
 *    the `device-unswitched` of a rollback) written at or after that mark
 *    is in this machine's store: one older than the mark is of an earlier
 *    migration that was rolled back since;
 *  - a `migration-done` record names shards this store does not hold yet
 *    (the first machine's cut has not arrived in full);
 *  - a later device's `device-switched` record names shards of its own
 *    this store does not hold yet (its switch record arrived before the
 *    other records its migration wrote);
 *  - a device whose migration mark is in the log switched as a later
 *    machine on a release that recorded no cut (before 2.0.1): which
 *    records its migration wrote cannot be told until that device, on
 *    2.0.1 or later, records its cut (`recordOwnSwitchCut`);
 *  - the log could not be read far enough to tell (counted as in flight:
 *    the removal cannot be undone, the wait can).
 *
 * A device a person retired for good is waited on by none of these
 * (`deviceStillWaitedOn`, the one rule of who is waited on); one that
 * writes after its retirement is back, and waited on again.
 *
 * The manual removal refuses on it unless `--force`; the automatic
 * removal of the other branch calls it and waits.
 */

import { resolveAppendShardId } from "../brain/ledger-shards.ts";
import type { StoreRecord } from "../store/envelope.ts";
import { parseHlc } from "../store/hlc.ts";
import type { StoreHandle } from "../store/store-open.ts";
import { otherDeviceMigrationMarks, type OtherDeviceMark } from "./auto-probe.ts";
import { migrationCutWait } from "./later.ts";
import {
  deviceStillWaitedOn,
  devicesSwitchedWithoutCut,
  newestSwitchRecords,
} from "./migration-records.ts";
import { MOVE_INTO_VAULT_COMMAND } from "../store/constants.ts";

export interface CohortRecordsInFlight {
  /** Devices known to have switched whose records are not all here. */
  readonly devices: ReadonlyArray<string>;
  /** One sentence per finding, for the refusal and the report. */
  readonly reasons: ReadonlyArray<string>;
}

/**
 * Which cohort devices switched to the store while their records have not
 * arrived on this machine (module docblock). Empty when none. Never throws:
 * a read that fails is a reason.
 */
export function cohortRecordsInFlight(
  vault: string,
  store: StoreHandle,
  device: string = resolveAppendShardId(),
): CohortRecordsInFlight {
  const devices = new Set<string>();
  const reasons: string[] = [];
  const scan = otherDeviceMigrationMarks(vault, device);
  let waitedOn: (device: string) => boolean;
  let switches: Map<string, StoreRecord>;
  let uncut: Set<string>;
  try {
    waitedOn = deviceStillWaitedOn(store);
    switches = newestSwitchRecords(store);
    uncut = devicesSwitchedWithoutCut(store, waitedOn);
  } catch {
    waitedOn = () => true;
    switches = new Map();
    uncut = new Set();
  }
  for (const mark of scan.marks) {
    // A person retired it for good (and nothing of it was written since):
    // what its store holds arrives or never will, and waiting changes
    // nothing. One that wrote again after the retirement is back.
    if (!waitedOn(mark.device)) continue;
    if (uncut.has(mark.device)) {
      devices.add(mark.device);
      reasons.push(
        `device ${mark.device} switched on a release that did not record which records its ` +
          "migration wrote, so their arrival cannot be told; it records them at its first " +
          "start on Open Second Brain 2.0.1 or later (for a machine that is gone for good, " +
          `run o2b store device retire ${mark.device})`,
      );
      continue;
    }
    // Its switch record of this migration, or a later one (a rollback
    // since still wrote its switch record), is here: its records arrived.
    if (answersMark(switches.get(mark.device), mark)) continue;
    devices.add(mark.device);
    reasons.push(
      `device ${mark.device} moved this vault's brain into its store, and its switch record ` +
        "has not arrived on this machine (if it switched on Open Second Brain 2.0.0, its store " +
        `stays outside the vault until ${MOVE_INTO_VAULT_COMMAND} runs on it; for a machine ` +
        `that is gone for good, run o2b store device retire ${mark.device})`,
    );
  }
  if (scan.incomplete !== null) {
    reasons.push(`${scan.incomplete}, so this machine cannot tell which devices switched`);
  }
  try {
    // The first machine's cut, and each later device's: a switch record
    // can arrive before the other records its migration wrote (another
    // shard each), and its cut names them.
    for (const [late, count] of migrationCutWait(store).missingByDevice ?? []) {
      if (!waitedOn(late)) continue;
      devices.add(late);
      reasons.push(`${count} shard(s) of the migration of device ${late} have not arrived`);
    }
  } catch (err) {
    reasons.push(`the store's migration records cannot be read (${String(err)})`);
  }
  return { devices: [...devices].toSorted(), reasons };
}

/**
 * Whether `record`, the device's newest switch record here, answers its
 * migration `mark`: it was written at or after the mark (the device's own
 * clock stamps both, and a migration writes its mark before its switch).
 * One written before it is of an earlier migration, rolled back since. A
 * mark with no readable time is answered by any switch record.
 */
function answersMark(record: StoreRecord | undefined, mark: OtherDeviceMark): boolean {
  if (record === undefined) return false;
  if (mark.at === null) return true;
  const physical = parseHlc(record.hlc)?.physical;
  return physical !== undefined && physical >= mark.at;
}

/** Whether {@link cohortRecordsInFlight} finds anything that holds the removal off. */
export function legacyRemovalHeldByCohort(vault: string, store: StoreHandle): boolean {
  return cohortRecordsInFlight(vault, store, store.device).reasons.length > 0;
}
