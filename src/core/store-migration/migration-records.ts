/**
 * The store records that tell every machine where the migration of the
 * legacy layout stands (design D11, D11a, D14 item 1), all in the
 * `settings` stream of `shared` with `authority` `human` (the user ran the
 * migration):
 *
 *  - `migration-cohort` `{ authority, vault_id, devices }`: every device id
 *    found in the legacy tree at preflight, with no age limit. The legacy
 *    tree leaves the vault only once each of them has switched or retired,
 *    by a human or by silence (`cohort-status.ts`).
 *  - `migration-done` `{ authority, vault_id, device, cuts, imported }`: the
 *    first machine finished; `cuts` holds, per partition it holds, the
 *    digest cut (`state-digest.ts`) of the store right after the import.
 *  - `device-switched` `{ authority, vault_id, device, cuts? }`: this
 *    device moved to the store. A device holding its own record is
 *    store-only (D14). A later machine's record carries `cuts`, the digest
 *    cut of its own shards right before the switch.
 *
 * Every record the migration imports carries `migrated: { key, sum }` in
 * its body: the legacy item it came from (vault-relative path, and the
 * line for an append-only file) and the checksum of that item's content.
 * It is what makes a resumed migration skip what it already imported.
 */

import { isRecordRelPath } from "../record-path.ts";
import {
  AUTHORITY_FIELD,
  DEVICE_RETIRE_KIND,
  SETTING_SILENT_DEVICE_DAYS,
  type StorePartition,
} from "../store/constants.ts";
import { latestRetirements, returnedAfterRetirement } from "../store/device-retirement.ts";
import { foldSettings, settingValue } from "../store/fold-settings.ts";
import { parseHlc } from "../store/hlc.ts";
import { compareRecords, type StoreRecord } from "../store/envelope.ts";
import { forEachPartitionRecord, type CutEntry } from "../store/state-digest.ts";
import type { StoreHandle } from "../store/store-open.ts";
import { readStreamRecords } from "../store/read/stream-read.ts";
import { newestRecordOfEachDevice, type NewestRecords } from "../store/newest-records.ts";
import { partitionDir } from "../store/store-paths.ts";

export const MIGRATION_COHORT_KIND = "migration-cohort";
export const MIGRATION_DONE_KIND = "migration-done";
export const DEVICE_SWITCHED_KIND = "device-switched";
/** A rollback took the device back to the legacy layout (task 2.6). */
export const DEVICE_UNSWITCHED_KIND = "device-unswitched";
/** The legacy tree left the vault into a device-local archive (task 2.5). */
export const LEGACY_TREE_REMOVED_KIND = "legacy-tree-removed";

/** The record kinds of the migration, for the format document. */
export const MIGRATION_RECORD_KINDS = Object.freeze([
  MIGRATION_COHORT_KIND,
  MIGRATION_DONE_KIND,
  DEVICE_SWITCHED_KIND,
  DEVICE_UNSWITCHED_KIND,
  LEGACY_TREE_REMOVED_KIND,
] as const);

/** The body field an imported record names its legacy item in. */
export const MIGRATED_FIELD = "migrated";

/** The stream the migration records go to. */
export const MIGRATION_STREAM = "settings";

/** The body field naming the device whose legacy shard an item came from. */
export const LEGACY_DEVICE_FIELD = "legacy_device";

/** A vault as the journal and a `migrated` mark record it (`journal-scope.ts`). */
export interface JournalVault {
  readonly vault_id: string | null;
  readonly path_sum: string;
}

/** A journal identity read from untrusted JSON, or null. */
export function parseJournalVault(value: unknown): JournalVault | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const { vault_id, path_sum } = value as Record<string, unknown>;
  if (typeof path_sum !== "string") return null;
  return { vault_id: typeof vault_id === "string" ? vault_id : null, path_sum };
}

/**
 * The `migrated` field of an imported record: the item key, its content
 * checksum, and which of the item's records this is (`part` of `parts`),
 * so an item whose records were only partly written is completed.
 */
export interface MigratedMark {
  readonly key: string;
  readonly sum: string;
  readonly part: number;
  readonly parts: number;
  /** The vault the item came from (`journal-scope.ts`); null in a mark written before it was recorded. */
  readonly vault: JournalVault | null;
}

/** The cut of one partition, as `migration-done` carries it. */
export interface PartitionCut {
  readonly cut: ReadonlyArray<CutEntry>;
  readonly cut_hash: string;
}

/**
 * The legacy item an imported record came from, or null. A key that is no
 * record path (`record-path.ts`: `..`, absolute, backslashes and the rest)
 * is no mark: the rollback writes an imported record back at its key, and
 * a synced peer can write any key.
 */
export function migratedMark(record: StoreRecord): MigratedMark | null {
  const mark = record.body[MIGRATED_FIELD];
  if (mark === null || typeof mark !== "object" || Array.isArray(mark)) return null;
  const { key, sum, part, parts, vault } = mark as Record<string, unknown>;
  if (!isRecordRelPath(key) || typeof sum !== "string") return null;
  const count = Number.isInteger(parts) && (parts as number) > 0 ? (parts as number) : 1;
  const index = Number.isInteger(part) && (part as number) >= 0 ? (part as number) : 0;
  return {
    key,
    sum,
    part: Math.min(index, count - 1),
    parts: count,
    vault: parseJournalVault(vault),
  };
}

/**
 * Every record of the `settings` stream of `shared`, as this machine holds
 * it. Only that stream is read: the store-only predicate asks this on
 * every write of a machine that is not (yet) switched, and reading the
 * whole partition to keep one stream made every write cost as much as the
 * whole store (every continuity row verified, per call).
 */
function sharedSettings(store: Pick<StoreHandle, "root" | "partitions">): StoreRecord[] {
  if (!store.partitions.has("shared")) return [];
  return [...readStreamRecords(store.root, "shared", { stream: MIGRATION_STREAM }).records];
}

/** The `settings` shards of `shared` whose records this machine cannot all see. */
export interface UnseenSettingsShards {
  /**
   * Shards it cannot read at all (an I/O error, something that is no file
   * where a shard should be) or read before and cannot find now, as
   * `shared/<rel>`.
   */
  readonly unreadable: ReadonlyArray<string>;
  /**
   * Shards it read only in part (a record whose blob has not arrived, a
   * bad line in the middle, a newer format), as `shared/<rel>`.
   */
  readonly partial: ReadonlyArray<string>;
}

/**
 * The `settings` shards of `shared` that may hide a record. A record in
 * one (a cohort, a peer's switch) is invisible to every reader above, so
 * a decision that would lose data when such a record is missed (the
 * removal of the legacy tree) refuses while any is listed.
 */
export function unseenSettingsShards(
  store: Pick<StoreHandle, "root" | "partitions">,
): UnseenSettingsShards {
  if (!store.partitions.has("shared")) return { unreadable: [], partial: [] };
  const unreadable: string[] = [];
  const partial: string[] = [];
  // Record by record, keeping none: only what cannot be read is named.
  forEachPartitionRecord(
    partitionDir(store.root, "shared"),
    {
      onUnreadable: ({ rel, incomplete }) => {
        if (rel.split("/")[0] !== MIGRATION_STREAM) return;
        (incomplete === true ? partial : unreadable).push(`shared/${rel}`);
      },
    },
    {},
  );
  return { unreadable: unreadable.toSorted(), partial: partial.toSorted() };
}

/**
 * The retired devices this machine sees writing again after their latest
 * human retirement, over every held partition (the doctor's
 * `store-device-retired-returned` reads the same rule,
 * `store/device-retirement.ts`).
 */
function returnedRetiredDeviceIds(
  settings: ReadonlyArray<StoreRecord>,
  read: NewestRecords,
): Set<string> {
  // The rule reads each device's last record and the retirements: the
  // retirements are records of the shared settings, and each device's last
  // record is the one a fold of every record finds (`newest-records.ts`).
  // A device whose last record this machine cannot tell (a shard it could
  // not read) counts as returned: it stays in the cohort and holds the
  // legacy tree in place, never "retired" on a read that may be short.
  const retirements = settings.filter((r) => r.kind === DEVICE_RETIRE_KIND);
  const returned = new Set(
    returnedAfterRetirement([...retirements, ...read.newest.values()]).map((r) => r.device),
  );
  // Only a human retirement takes a device out of the cohort, so only one
  // is held in it by a read that may be short.
  for (const r of retirements) {
    if (!isHuman(r)) continue;
    const device = r.body["device"];
    if (typeof device === "string" && read.uncertain.has(device)) returned.add(device);
  }
  return returned;
}

function isHuman(record: StoreRecord): boolean {
  return record.body[AUTHORITY_FIELD] === "human";
}

/**
 * The devices `records` show as switched to the store: for each device,
 * the latest of its own human `device-switched` and `device-unswitched`
 * records (written by the device, about itself) is a switch. A rollback
 * writes `device-unswitched` after the switch it undoes. Pure, so a
 * caller that already read the records answers for every device at once.
 */
export function switchedDevices(records: Iterable<StoreRecord>): Set<string> {
  const latest = new Map<string, StoreRecord>();
  for (const record of records) {
    if (record.kind !== DEVICE_SWITCHED_KIND && record.kind !== DEVICE_UNSWITCHED_KIND) continue;
    if (record.body["device"] !== record.device || !isHuman(record)) continue;
    const seen = latest.get(record.device);
    if (seen === undefined || compareRecords(record, seen) > 0) latest.set(record.device, record);
  }
  const out = new Set<string>();
  for (const [device, record] of latest) if (record.kind === DEVICE_SWITCHED_KIND) out.add(device);
  return out;
}

/**
 * A predicate over records: whether the device that wrote one was switched
 * to the store when it wrote it (its latest own human `device-switched` or
 * `device-unswitched` before the record, in fold order, is a switch). A
 * record written while switched is native to the store, never a
 * dual-written copy of a legacy item.
 */
export function writtenWhileSwitched(
  store: Pick<StoreHandle, "root" | "partitions">,
): (record: StoreRecord) => boolean {
  const marks = new Map<string, StoreRecord[]>();
  for (const record of sharedSettings(store)) {
    if (record.kind !== DEVICE_SWITCHED_KIND && record.kind !== DEVICE_UNSWITCHED_KIND) continue;
    if (record.body["device"] !== record.device || !isHuman(record)) continue;
    marks.set(record.device, [...(marks.get(record.device) ?? []), record]);
  }
  for (const list of marks.values()) list.sort(compareRecords);
  return (record) => {
    let last: StoreRecord | undefined;
    for (const mark of marks.get(record.device) ?? []) {
      if (compareRecords(mark, record) >= 0) break;
      last = mark;
    }
    return last?.kind === DEVICE_SWITCHED_KIND;
  };
}

/**
 * Whether `deviceId` has switched to the store: the store holds its own
 * `device-switched` record, not undone by a later `device-unswitched`.
 * The store-only write path reads this.
 */
export function isDeviceSwitched(
  store: Pick<StoreHandle, "root" | "partitions">,
  deviceId: string,
): boolean {
  return switchedDevices(sharedSettings(store)).has(deviceId);
}

/**
 * Each device's newest own switch record this store holds (a human
 * `device-switched`, or the `device-unswitched` of a rollback, written by
 * the device about itself), in fold order. Whether it answers a migration
 * mark found in the legacy log is a question of age (`cohort-in-flight.ts`):
 * a record older than the mark is of an earlier migration of the device.
 */
export function newestSwitchRecords(
  store: Pick<StoreHandle, "root" | "partitions">,
): Map<string, StoreRecord> {
  const out = new Map<string, StoreRecord>();
  for (const record of sharedSettings(store)) {
    if (record.kind !== DEVICE_SWITCHED_KIND && record.kind !== DEVICE_UNSWITCHED_KIND) continue;
    if (record.body["device"] !== record.device || !isHuman(record)) continue;
    const seen = out.get(record.device);
    if (seen === undefined || compareRecords(record, seen) > 0) out.set(record.device, record);
  }
  return out;
}

/** The `legacy-tree-removed` records this machine holds. */
export function legacyTreeRemovedRecords(store: StoreHandle): StoreRecord[] {
  return sharedSettings(store).filter((r) => r.kind === LEGACY_TREE_REMOVED_KIND && isHuman(r));
}

/** Whether any device recorded the migration cohort (it is recorded once). */
export function hasCohortRecord(store: StoreHandle): boolean {
  return sharedSettings(store).some((r) => r.kind === MIGRATION_COHORT_KIND && isHuman(r));
}

/**
 * The devices still on the legacy layout (design D11a): every device of
 * the migration cohort, and every device id `seen` in legacy shard names,
 * minus the devices that recorded `device-switched` and the devices a
 * human retired (`device-retire`).
 */
export function legacyDevices(
  store: Pick<StoreHandle, "root" | "partitions">,
  seen: ReadonlyArray<string>,
  read: NewestRecords = newestRecordOfEachDevice(store),
): string[] {
  const records = sharedSettings(store);
  const devices = new Set(seen);
  for (const r of records) {
    if (r.kind !== MIGRATION_COHORT_KIND || !isHuman(r)) continue;
    const listed = r.body["devices"];
    if (Array.isArray(listed)) for (const d of listed) if (typeof d === "string") devices.add(d);
  }
  // A retired device leaves the cohort, unless it wrote again after its
  // latest retirement: then it is back, and holds the gate until it
  // switches or is retired again.
  const returned = returnedRetiredDeviceIds(records, read);
  for (const r of records) {
    if (!isHuman(r)) continue;
    const device = r.body["device"];
    if (typeof device !== "string") continue;
    if (r.kind === DEVICE_RETIRE_KIND && !returned.has(device)) devices.delete(device);
  }
  for (const device of returned) devices.add(device);
  // A device that switched and was rolled back is on the legacy layout again.
  const switched = switchedDevices(records);
  for (const device of devices) if (switched.has(device)) devices.delete(device);
  return [...devices].toSorted();
}

/** Every device a human `migration-cohort` record names. */
export function cohortDevices(store: Pick<StoreHandle, "root" | "partitions">): string[] {
  return [...cohortFirstSeen(store).keys()].toSorted();
}

/**
 * The clock (physical ms) of the earliest human `migration-cohort` record
 * naming each device: the stand-in evidence of a device that left no dated
 * trace (change stale-device-retirement, design D2).
 */
export function cohortFirstSeen(
  store: Pick<StoreHandle, "root" | "partitions">,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of sharedSettings(store)) {
    if (r.kind !== MIGRATION_COHORT_KIND || !isHuman(r)) continue;
    const physical = parseHlc(r.hlc)?.physical;
    const listed = r.body["devices"];
    if (physical === undefined || !Array.isArray(listed)) continue;
    for (const d of listed) {
      if (typeof d !== "string") continue;
      const seen = out.get(d);
      if (seen === undefined || physical < seen) out.set(d, physical);
    }
  }
  return out;
}

/** The shared silence threshold in days (`migration.silent_device_days`; 0 is off). */
export function silenceThresholdDays(store: Pick<StoreHandle, "root" | "partitions">): number {
  return settingValue(foldSettings(sharedSettings(store)), SETTING_SILENT_DEVICE_DAYS) as number;
}

/** The devices `records` show as switched, read from this machine's store. */
export function switchedDeviceIds(store: Pick<StoreHandle, "root" | "partitions">): Set<string> {
  return switchedDevices(sharedSettings(store));
}

/** The `migration-done` records this machine holds, in file order. */
export function migrationDoneRecords(store: StoreHandle): StoreRecord[] {
  return sharedSettings(store).filter((r) => r.kind === MIGRATION_DONE_KIND && isHuman(r));
}

/**
 * The `migration-done` records still standing: one a later
 * `device-unswitched` of the same device follows (a run that was rolled
 * back) no longer counts as that device's completion, so its cut is never
 * reused by a new run of the device.
 */
export function standingDoneRecords(store: StoreHandle): StoreRecord[] {
  const settings = sharedSettings(store);
  const unswitched = settings.filter((r) => r.kind === DEVICE_UNSWITCHED_KIND && isHuman(r));
  return settings.filter(
    (r) =>
      r.kind === MIGRATION_DONE_KIND &&
      isHuman(r) &&
      !unswitched.some((u) => u.device === r.device && compareRecords(u, r) > 0),
  );
}

/** Bodies of the migration records, built in one place. */
export function cohortBody(vaultId: string | null, devices: ReadonlyArray<string>) {
  return { [AUTHORITY_FIELD]: "human", vault_id: vaultId, devices: [...devices] };
}

export function migrationDoneBody(input: {
  readonly vaultId: string | null;
  readonly device: string;
  readonly cuts: Partial<Record<StorePartition, PartitionCut>>;
  readonly imported: number;
}) {
  return {
    [AUTHORITY_FIELD]: "human",
    vault_id: input.vaultId,
    device: input.device,
    cuts: input.cuts,
    imported: input.imported,
  };
}

/**
 * A later machine passes `cuts`: the digest cut of its own shards, taken
 * right before its switch record, so a machine that removes the legacy
 * tree can tell that the records its migration wrote have arrived, not
 * only the switch record (`cohort-in-flight.ts`). The first machine's
 * `migration-done` cut covers its import; a first machine whose run was
 * resumed after that record passes its own cut too, for what it imported
 * since. A device that switched on a release that wrote no cut records
 * one more switch with its cut at its next start (`recordOwnSwitchCut`).
 */
export function deviceSwitchedBody(
  vaultId: string | null,
  device: string,
  cuts?: Partial<Record<StorePartition, PartitionCut>>,
) {
  return {
    [AUTHORITY_FIELD]: "human",
    vault_id: vaultId,
    device,
    ...(cuts !== undefined ? { cuts } : {}),
  };
}

/**
 * Whether the device's current migration left no evidence of what it
 * wrote: no switch record of its own with a cut, and no `migration-done`
 * of its own (whose cut covers its import). Only evidence of the current
 * migration counts: a rollback (`device-unswitched`) ends the one before,
 * and its completion and cuts say nothing of what the switch after it
 * wrote. A first migration never rolled back keeps all of its evidence.
 */
function lacksCutEvidence(settings: ReadonlyArray<StoreRecord>, device: string): boolean {
  const own = (r: StoreRecord): boolean =>
    r.device === device && r.body["device"] === device && isHuman(r);
  const rollback = settings
    .filter((r) => r.kind === DEVICE_UNSWITCHED_KIND && own(r))
    .reduce<StoreRecord | null>(
      (latest, r) => (latest === null || compareRecords(r, latest) > 0 ? r : latest),
      null,
    );
  const current = (r: StoreRecord): boolean =>
    own(r) && (rollback === null || compareRecords(r, rollback) > 0);
  const cut = settings.some(
    (r) => r.kind === DEVICE_SWITCHED_KIND && current(r) && r.body["cuts"] !== undefined,
  );
  const done = settings.some((r) => r.kind === MIGRATION_DONE_KIND && current(r));
  return !cut && !done;
}

/**
 * The devices that switched as a later machine without saying which of
 * their records their migration wrote ({@link lacksCutEvidence}), among
 * those still waited on ({@link deviceStillWaitedOn}). A release before
 * 2.0.1 wrote such switch records; such a device records its cut at its
 * first start on 2.0.1 or later ({@link deviceSwitchedBody},
 * `recordOwnSwitchCut`, which asks {@link ownSwitchLacksCut}).
 */
export function devicesSwitchedWithoutCut(
  store: Pick<StoreHandle, "root" | "partitions">,
  waitedOn: (device: string) => boolean = deviceStillWaitedOn(store),
): Set<string> {
  const settings = sharedSettings(store);
  const out = new Set<string>();
  for (const device of switchedDevices(settings)) {
    if (lacksCutEvidence(settings, device) && waitedOn(device)) out.add(device);
  }
  return out;
}

/**
 * Whether `store.device` itself switched without a cut of what its
 * migration wrote. A retirement does not change the answer: the device
 * that asks is running, and the record it writes brings it back
 * (`device-retirement.ts`), so the other machines wait for its cut again.
 */
export function ownSwitchLacksCut(store: StoreHandle): boolean {
  const settings = sharedSettings(store);
  return switchedDevices(settings).has(store.device) && lacksCutEvidence(settings, store.device);
}

/**
 * The one answer to "is this device still waited on" for everything that
 * holds the legacy tree for another device's records (the wait for its
 * switch record, the wait for the shards its cut names, and the wait for
 * the cut itself, `cohort-in-flight.ts`): every device is, except one a
 * human retired for good, a `device-retire` record and no record of the
 * device after it (the one "retired, then wrote again" rule,
 * `device-retirement.ts`; a device whose last record cannot be told counts
 * as returned). What a device gone for good wrote arrives or never will,
 * and waiting for it changes nothing; one that writes again is back and
 * waited on. Reads each device's newest record only when there is a
 * retirement to judge.
 */
export function deviceStillWaitedOn(
  store: Pick<StoreHandle, "root" | "partitions">,
  read?: NewestRecords,
): (device: string) => boolean {
  const settings = sharedSettings(store);
  const retired = latestRetirements(settings);
  if (retired.size === 0) return () => true;
  const returned = returnedRetiredDeviceIds(settings, read ?? newestRecordOfEachDevice(store));
  return (device) => !retired.has(device) || returned.has(device);
}

/** The latest human `device-switched` record `store.device` wrote about itself, or null. */
export function latestOwnSwitch(store: StoreHandle): StoreRecord | null {
  let latest: StoreRecord | null = null;
  for (const r of sharedSettings(store)) {
    if (r.kind !== DEVICE_SWITCHED_KIND || !isHuman(r)) continue;
    if (r.device !== store.device || r.body["device"] !== store.device) continue;
    if (latest === null || compareRecords(r, latest) > 0) latest = r;
  }
  return latest;
}

/** The human `device-switched` records, each about its own device, that carry a cut. */
export function switchRecordsWithCuts(store: StoreHandle): StoreRecord[] {
  return sharedSettings(store).filter(
    (r) =>
      r.kind === DEVICE_SWITCHED_KIND &&
      isHuman(r) &&
      r.body["device"] === r.device &&
      r.body["cuts"] !== undefined,
  );
}
