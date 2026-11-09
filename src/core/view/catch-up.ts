/**
 * Catch-up for the human view: read every partition this machine holds,
 * once per pass, and raise the local clock past everything read (the
 * receive rule, design D3), so a record the writer writes in answer (a
 * release, a render, an ingested edit) folds after what it answers.
 *
 * The view renders from the `shared` partition only (see `pages.ts`); the
 * `private` records are read so the merge base, the replaced versions of a
 * page and the edits already ingested are found wherever their write put
 * them.
 */

import type { StorePartition } from "../store/constants.ts";
import { compareRecords, type StoreRecord } from "../store/envelope.ts";
import { prepareRecords } from "../store/fold.ts";
import { observeClock } from "../store/clock-store.ts";
import { parseHlc } from "../store/hlc.ts";
import { readShard, shardReadGap } from "../store/reader.ts";
import { trackSeenShards } from "../store/seen-shards.ts";
import { listShards } from "../store/shard-list.ts";
import { readPartition, type UnreadableShard } from "../store/state-digest.ts";
import type { StoreHandle } from "../store/store-open.ts";
import { partitionDir } from "../store/store-paths.ts";

/** What one catch-up read. */
export interface ViewCatchUp {
  /** Records of each held partition, deduplicated, in fold order (pending blobs left out). */
  readonly records: ReadonlyMap<StorePartition, ReadonlyArray<StoreRecord>>;
  /** Shards that could not be read; the pass must not render over an incomplete read. */
  readonly unreadable: ReadonlyArray<UnreadableShard & { partition: StorePartition }>;
}

/** Read the held partitions and observe their newest clock. */
export function catchUp(store: StoreHandle, now?: () => number): ViewCatchUp {
  const records = new Map<StorePartition, ReadonlyArray<StoreRecord>>();
  const unreadable: Array<UnreadableShard & { partition: StorePartition }> = [];
  let newest: StoreRecord | undefined;
  for (const partition of store.partitions) {
    const shards = readPartition(partitionDir(store.root, partition), {
      onUnreadable: (shard) => unreadable.push({ ...shard, partition }),
    });
    const prepared = prepareRecords(shards.flatMap((shard) => shard.records)).records;
    records.set(partition, prepared);
    const last = prepared.at(-1);
    if (last !== undefined && (newest === undefined || compareRecords(last, newest) > 0)) {
      newest = last;
    }
  }
  if (newest !== undefined) {
    observeClock(store.deviceStateDir, store.device, parseHlc(newest.hlc)!, now);
  }
  return { records, unreadable };
}

/** Every record read, all partitions together, in fold order. */
export function allRecords(read: ViewCatchUp): StoreRecord[] {
  return [...read.records.values()].flat().toSorted(compareRecords);
}

/** The records of one partition (empty when it is not held). */
export function partitionRecords(
  read: ViewCatchUp,
  partition: StorePartition,
): ReadonlyArray<StoreRecord> {
  return read.records.get(partition) ?? [];
}

/**
 * `read` with one record this device just wrote added, so a pass need not
 * read the whole store again to see its own render record.
 */
export function withOwnRecord(
  read: ViewCatchUp,
  partition: StorePartition,
  record: StoreRecord,
): ViewCatchUp {
  const records = new Map(read.records);
  records.set(partition, [...(records.get(partition) ?? []), record]);
  return { records, unreadable: read.unreadable };
}

/**
 * Read only the `settings` stream of `shared`, where the view writer
 * records live, and observe its newest clock: the cheap first step of a
 * pass, so a machine that is not the writer never reads the rest of the
 * store. `null` when a shard of it could not be read, was read only in
 * part (`shardReadGap`), or is gone since this machine read it
 * (`seen-shards.ts`).
 */
export function catchUpSettings(
  store: StoreHandle,
  now?: () => number,
): ReadonlyArray<StoreRecord> | null {
  if (!store.partitions.has("shared")) return [];
  const root = partitionDir(store.root, "shared");
  const read: StoreRecord[] = [];
  const shards = listShards(root, { stream: "settings" });
  if (
    trackSeenShards(
      root,
      { prefix: "settings/" },
      shards.map((shard) => shard.rel),
    ).length > 0
  ) {
    return null;
  }
  for (const shard of shards) {
    try {
      const result = readShard(shard.path, { partitionRoot: root });
      if (shardReadGap(result) !== null) return null;
      for (const r of result.records) if (r.bodyState !== "pending") read.push(r.record);
    } catch {
      return null;
    }
  }
  const records = prepareRecords(read).records;
  const last = records.at(-1);
  if (last !== undefined) {
    observeClock(store.deviceStateDir, store.device, parseHlc(last.hlc)!, now);
  }
  return records;
}
