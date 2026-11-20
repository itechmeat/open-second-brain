/**
 * One held partition read record by record into what the store checks
 * need of it (the doctor's store checks, `state-digest-check.ts`), never
 * the records themselves: a migrated store's busiest shard can hold every
 * record a migration imported, and a check that held every partition
 * whole needed several times the store's size in memory.
 *
 * Kept, per partition: each shard's totals (held tails); the records the
 * digest comparison reads (every `state-digest` record, and each
 * device's first and last record inside the roster window, which is all
 * `computeRoster` takes of the rest); the `device-retire` records; each
 * device's last record; the records the removal folds read; one version
 * key per record id (cross-partition ids, conflicting versions); and the
 * records stamped too far ahead of the clock, counted by device.
 */

import {
  DAY_MS,
  DEVICE_RETIRE_KIND,
  DIGEST_ROSTER_WINDOW_DAYS,
  STATE_DIGEST_KIND,
} from "./constants.ts";
import { compareCodeUnits } from "./compare.ts";
import { compareRecords, type StoreRecord } from "./envelope.ts";
import { compareHlc, HLC_MAX_DRIFT_MS, parseHlc, type Hlc } from "./hlc.ts";
import { isVoidingFoldInput } from "./removal-backlog.ts";
import {
  forEachPartitionRecord,
  type PartitionShardTotals,
  type ReadPartitionOptions,
} from "./state-digest.ts";

export interface PartitionView {
  /** Every shard read to its end, in path order. */
  readonly shards: ReadonlyArray<PartitionShardTotals>;
  /** What `compareDigests` reads of the partition (see the module docblock). */
  readonly digestRecords: ReadonlyArray<StoreRecord>;
  /** The `device-retire` records of the `settings` stream whose body is known. */
  readonly retireRecords: ReadonlyArray<StoreRecord>;
  /** Every `device-retire` record, wherever it sits. */
  readonly allRetireRecords: ReadonlyArray<StoreRecord>;
  /** The last record of each device, in fold order. */
  readonly lastByDevice: ReadonlyMap<string, StoreRecord>;
  /** The records the removal folds read (`isVoidingFoldInput`). */
  readonly voiding: ReadonlyArray<StoreRecord>;
  /** Every record id read. */
  readonly ids: ReadonlySet<string>;
  /** Ids delivered with different content, as `prepareRecords` reports them. */
  readonly conflicts: ReadonlyArray<{ readonly id: string; readonly versions: number }>;
  /** Records stamped more than the allowed drift after `nowMs`, by device. */
  readonly clockAhead: ReadonlyMap<string, { count: number; newest: Hlc }>;
}

/**
 * What tells two versions of one id apart, as their canonical texts do
 * (`prepareRecords`): every envelope field, the body's verified checksum,
 * and whether the body is a blob not arrived (its line holds the
 * reference, not the body).
 */
function versionKey(record: StoreRecord, pending: boolean): string {
  return [
    pending ? "pending" : "body",
    record.v,
    record.hlc,
    record.device,
    record.agent,
    record.kind,
    record.scope ?? "",
    record.topic ?? "",
    record.sum,
  ].join("\u0000");
}

/** Read the partition at `partitionRoot` into its {@link PartitionView}; see the module docblock. */
export function readPartitionView(
  partitionRoot: string,
  options: ReadPartitionOptions,
  nowMs: number,
): PartitionView {
  const since = nowMs - DIGEST_ROSTER_WINDOW_DAYS * DAY_MS;
  const shards: PartitionShardTotals[] = [];
  const digests: StoreRecord[] = [];
  const windowEnds = new Map<string, { first: StoreRecord; last: StoreRecord }>();
  const retireRecords: StoreRecord[] = [];
  const allRetireRecords: StoreRecord[] = [];
  const lastByDevice = new Map<string, StoreRecord>();
  const voiding: StoreRecord[] = [];
  const versions = new Map<string, string | Set<string>>();
  const clockAhead = new Map<string, { count: number; newest: Hlc }>();
  forEachPartitionRecord(partitionRoot, options, {
    record: (shard, record, pending) => {
      const stamp = parseHlc(record.hlc);
      if (record.kind === STATE_DIGEST_KIND) digests.push(record);
      if (record.kind === DEVICE_RETIRE_KIND) {
        allRetireRecords.push(record);
        if (shard.stream === "settings" && !pending) retireRecords.push(record);
      }
      if (isVoidingFoldInput(record)) voiding.push(record);
      const last = lastByDevice.get(record.device);
      if (last === undefined || compareRecords(record, last) > 0) {
        lastByDevice.set(record.device, record);
      }
      if (stamp !== null && stamp.physical >= since) {
        const ends = windowEnds.get(record.device);
        if (ends === undefined) windowEnds.set(record.device, { first: record, last: record });
        else {
          if (compareRecords(record, ends.first) < 0) ends.first = record;
          if (compareRecords(record, ends.last) > 0) ends.last = record;
        }
      }
      const key = versionKey(record, pending);
      const seen = versions.get(record.id);
      if (seen === undefined) versions.set(record.id, key);
      else if (typeof seen === "string") {
        if (seen !== key) versions.set(record.id, new Set([seen, key]));
      } else seen.add(key);
      if (stamp !== null && stamp.physical - nowMs > HLC_MAX_DRIFT_MS) {
        const ahead = clockAhead.get(record.device);
        if (ahead === undefined) clockAhead.set(record.device, { count: 1, newest: stamp });
        else {
          ahead.count += 1;
          if (compareHlc(stamp, ahead.newest) > 0) ahead.newest = stamp;
        }
      }
    },
    shard: (totals) => shards.push(totals),
  });
  const digestRecords = [...digests];
  for (const { first, last } of windowEnds.values()) {
    digestRecords.push(first);
    if (last !== first) digestRecords.push(last);
  }
  const conflicts: Array<{ id: string; versions: number }> = [];
  for (const [id, seen] of versions) {
    if (typeof seen !== "string") conflicts.push({ id, versions: seen.size });
  }
  conflicts.sort((a, b) => compareCodeUnits(a.id, b.id));
  return {
    shards,
    digestRecords,
    retireRecords,
    allRetireRecords,
    lastByDevice,
    voiding,
    ids: new Set(versions.keys()),
    conflicts,
    clockAhead,
  };
}
