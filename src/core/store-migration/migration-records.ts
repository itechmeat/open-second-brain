/**
 * The store records that tell every machine where the migration of the
 * legacy layout stands (design D11, D11a, D14 item 1), all in the
 * `settings` stream of `shared` with `authority` `human` (the user ran the
 * migration):
 *
 *  - `migration-cohort` `{ authority, vault_id, devices }`: every device id
 *    found in the legacy tree at preflight, with no age limit. The legacy
 *    tree leaves the vault only once each of them has switched or retired.
 *  - `migration-done` `{ authority, vault_id, device, cuts, imported }`: the
 *    first machine finished; `cuts` holds, per partition it holds, the
 *    digest cut (`state-digest.ts`) of the store right after the import.
 *  - `device-switched` `{ authority, vault_id, device }`: this device moved
 *    to the store. A device holding its own record is store-only (D14).
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
  STORE_PARTITIONS,
  type StorePartition,
} from "../store/constants.ts";
import { returnedAfterRetirement } from "../store/device-retirement.ts";
import { compareRecords, type StoreRecord } from "../store/envelope.ts";
import { readPartition, type CutEntry } from "../store/state-digest.ts";
import type { StoreHandle } from "../store/store-open.ts";
import { readStreamRecords } from "../store/read/stream-read.ts";
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
  readPartition(partitionDir(store.root, "shared"), {
    onUnreadable: ({ rel, incomplete }) => {
      if (rel.split("/")[0] !== MIGRATION_STREAM) return;
      (incomplete === true ? partial : unreadable).push(`shared/${rel}`);
    },
  });
  return { unreadable: unreadable.toSorted(), partial: partial.toSorted() };
}

/**
 * The retired devices this machine sees writing again after their latest
 * human retirement, over every held partition (the doctor's
 * `store-device-retired-returned` reads the same rule,
 * `store/device-retirement.ts`).
 */
function returnedRetiredDeviceIds(store: Pick<StoreHandle, "root" | "partitions">): Set<string> {
  const all = STORE_PARTITIONS.filter((p) => store.partitions.has(p)).flatMap((partition) =>
    readPartition(partitionDir(store.root, partition), { onUnreadable: () => {} }).flatMap(
      (shard) => shard.all,
    ),
  );
  return new Set(returnedAfterRetirement(all).map((r) => r.device));
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
export function legacyDevices(store: StoreHandle, seen: ReadonlyArray<string>): string[] {
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
  const returned = returnedRetiredDeviceIds(store);
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

export function deviceSwitchedBody(vaultId: string | null, device: string) {
  return { [AUTHORITY_FIELD]: "human", vault_id: vaultId, device };
}
