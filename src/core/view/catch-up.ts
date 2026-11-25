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

import { join } from "node:path";

import type { StorePartition, StoreStream } from "../store/constants.ts";
import { compareRecords, isBlobRef, type StoreRecord } from "../store/envelope.ts";
import { prepareRecords } from "../store/fold.ts";
import { observeClock } from "../store/clock-store.ts";
import { parseHlc } from "../store/hlc.ts";
import { readShard, shardReadGap } from "../store/reader.ts";
import { readStreamRecords, type ShardTails } from "../store/read/stream-read.ts";
import { trackSeenShards } from "../store/seen-shards.ts";
import { listShards } from "../store/shard-list.ts";
import {
  forEachPartitionRecord,
  readPartition,
  streamRefs,
  type UnreadableShard,
} from "../store/state-digest.ts";
import type { StoreHandle } from "../store/store-open.ts";
import { partitionDir, type StreamRef } from "../store/store-paths.ts";

/** What one catch-up read. */
export interface ViewCatchUp {
  /** Records of each held partition, deduplicated, in fold order (pending blobs left out). */
  readonly records: ReadonlyMap<StorePartition, ReadonlyArray<StoreRecord>>;
  /** Shards that could not be read; the pass must not render over an incomplete read. */
  readonly unreadable: ReadonlyArray<UnreadableShard & { partition: StorePartition }>;
  /**
   * By partition, the envelope kinds of the records left out because their
   * body has not arrived (a pending blob, quarantined or not), counted.
   * Absent when the read did not count them: a reader that must know
   * whether a record of some kind is missing takes it as incomplete.
   */
  readonly pendingKinds?: ReadonlyMap<StorePartition, ReadonlyMap<string, number>>;
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

/**
 * {@link catchUp} keeping only the records `keep` passes, judged record by
 * record as each is read (`forEachPartitionRecord`): for a pass that folds
 * a few kinds out of a large store (topic planning reads signals, notes
 * and topic records, the view its page inputs, not the whole migrated
 * log), so a record it drops is never held, not even with its shard.
 * The clock is raised past the newest record read, kept or not, exactly as
 * {@link catchUp} raises it, and an unreadable shard is reported the same
 * way.
 */
export function catchUpWhere(
  store: StoreHandle,
  keep: (record: StoreRecord, stream: StoreStream) => boolean,
  now?: () => number,
): ViewCatchUp {
  const records = new Map<StorePartition, ReadonlyArray<StoreRecord>>();
  const unreadable: Array<UnreadableShard & { partition: StorePartition }> = [];
  const pendingKinds = new Map<StorePartition, Map<string, number>>();
  let newest: StoreRecord | undefined;
  for (const partition of store.partitions) {
    const kept: StoreRecord[] = [];
    const pendingHere = new Map<string, number>();
    pendingKinds.set(partition, pendingHere);
    forEachPartitionRecord(
      partitionDir(store.root, partition),
      { onUnreadable: (shard) => unreadable.push({ ...shard, partition }) },
      {
        record: (shard, record, pending) => {
          if (pending) {
            pendingHere.set(record.kind, (pendingHere.get(record.kind) ?? 0) + 1);
            return;
          }
          if (newest === undefined || compareRecords(record, newest) > 0) newest = record;
          if (keep(record, shard.stream)) kept.push(record);
        },
      },
    );
    records.set(partition, prepareRecords(kept).records);
  }
  if (newest !== undefined) {
    observeClock(store.deviceStateDir, store.device, parseHlc(newest.hlc)!, now);
  }
  return { records, unreadable, pendingKinds };
}

/**
 * What a long-lived reader kept of every stream it read through
 * {@link catchUpWhereKept}: the kept tails of each stream's shards
 * (`ShardTails`), keyed by partition and stream. Bound to one store and one
 * `keep`: a tail holds only the records that `keep` passed.
 */
export type CatchUpTails = Map<string, ShardTails>;

/** A stream's key in {@link CatchUpTails}. */
function tailsKey(partition: StorePartition, ref: StreamRef): string {
  return `${partition}/${ref.stream}/${ref.ledger ?? ""}`;
}

/**
 * How many records each kept tail holds, for the tails that hold any:
 * with the count of records read anew and kept, what tells a reread that
 * changed the kept records from one that did not (a shard that grew, or
 * appeared, with only records the caller does not keep, such as the
 * queue's own writes, changes nothing kept).
 */
function tailsStamp(tails: CatchUpTails): string {
  const parts: string[] = [];
  for (const [key, shards] of tails) {
    for (const [rel, tail] of shards) {
      if (tail.records.length > 0) parts.push(`${key}|${rel}|${tail.records.length}`);
    }
  }
  return parts.toSorted().join("\n");
}

/**
 * {@link catchUpWhere} through `tails` a caller keeps between reads (a
 * dream session's server, which rereads the planning inputs on every
 * take and answer): a shard whose stamp is unchanged is not opened, one
 * that grew is read from where the kept read ended, with the same checks
 * as any kept-tail read (`ShardTails`, `stream-read.ts`). The records, the
 * unreadable shards and the pending kinds are those {@link catchUpWhere}
 * answers for the same store, and the clock is raised past the newest
 * record read anew (what was kept had raised it when it was read).
 *
 * `fresh` is false only when the kept records are those of the previous
 * read through the same tails: no record was read anew and kept, no kept
 * tail holds another number of records, nothing is unreadable or pending.
 * A caller may then keep what it built from the previous read; given that
 * read as `previous`, it is answered again as it is.
 */
export function catchUpWhereKept(
  store: StoreHandle,
  keep: (record: StoreRecord, stream: StoreStream) => boolean,
  tails: CatchUpTails,
  now?: () => number,
  previous?: ViewCatchUp,
): { readonly read: ViewCatchUp; readonly fresh: boolean } {
  const before = tailsStamp(tails);
  const kept = new Map<StorePartition, StoreRecord[]>();
  const unreadable: Array<UnreadableShard & { partition: StorePartition }> = [];
  const pendingKinds = new Map<StorePartition, Map<string, number>>();
  let newest: StoreRecord | undefined;
  let keptAnew = 0;
  let pendingAny = false;
  for (const partition of store.partitions) {
    const root = partitionDir(store.root, partition);
    const keptHere: StoreRecord[] = [];
    kept.set(partition, keptHere);
    const pendingHere = new Map<string, number>();
    pendingKinds.set(partition, pendingHere);
    for (const ref of streamRefs(root)) {
      const key = tailsKey(partition, ref);
      let shards = tails.get(key);
      if (shards === undefined) {
        shards = new Map();
        tails.set(key, shards);
      }
      const read = readStreamRecords(store.root, partition, ref, {
        tails: shards,
        // A pending record is kept so it is counted by kind, as
        // `catchUpWhere` counts every pending record it meets.
        keep: (record) => {
          if (isBlobRef(record.body)) {
            keptAnew += 1;
            return true;
          }
          if (newest === undefined || compareRecords(record, newest) > 0) newest = record;
          const wanted = keep(record, ref.stream);
          if (wanted) keptAnew += 1;
          return wanted;
        },
      });
      keptHere.push(...read.records);
      for (const rel of read.unreadable) {
        unreadable.push({
          rel,
          path: join(root, ...rel.split("/")),
          error: new Error("the shard could not be read in full"),
          partition,
        });
      }
      for (const [kind, count] of read.pendingKinds) {
        pendingAny = true;
        pendingHere.set(kind, (pendingHere.get(kind) ?? 0) + count);
      }
    }
  }
  if (newest !== undefined) {
    observeClock(store.deviceStateDir, store.device, parseHlc(newest.hlc)!, now);
  }
  const fresh = keptAnew > 0 || unreadable.length > 0 || pendingAny || tailsStamp(tails) !== before;
  // Nothing kept changed: the previous read through these tails holds the
  // same records in the same order, so they are not sorted again.
  if (!fresh && previous !== undefined) return { read: previous, fresh };
  const records = new Map<StorePartition, ReadonlyArray<StoreRecord>>();
  for (const [partition, list] of kept) records.set(partition, prepareRecords(list).records);
  return { read: { records, unreadable, pendingKinds }, fresh };
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
  return {
    records,
    unreadable: read.unreadable,
    ...(read.pendingKinds !== undefined ? { pendingKinds: read.pendingKinds } : {}),
  };
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
