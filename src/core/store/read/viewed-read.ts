/**
 * A stream read through a window's view (`read-view.ts`): the records up
 * to the boundary, inputs among them only while visible in the window,
 * and the state records written beyond it (an earlier window's effects, a
 * person's change). Inputs beyond the boundary belong to a later window's
 * admission and are left out.
 */

import type { StorePartition } from "../constants.ts";
import type { StoreRecord } from "../envelope.ts";
import type { StreamRef } from "../store-paths.ts";
import { boundaryOf, isInputRecord, visibleInView, type StoreReadView } from "./read-view.ts";
import { scanShard, shardScanGap } from "../reader.ts";
import { listShards } from "../shard-list.ts";
import { partitionDir } from "../store-paths.ts";
import { readStreamRecords, type StreamRead } from "./stream-read.ts";

export interface ViewedReadOptions {
  readonly keep?: (record: StoreRecord) => boolean;
  readonly month?: (month: string) => boolean;
  readonly checkpoint?: () => void;
  /**
   * Names what `keep` and `month` select, so the read below the boundary
   * (which cannot change while the view is active: the boundary is fixed)
   * is read once per view and selection, not once per reader.
   */
  readonly cacheKey?: string;
}

/** The reads below the boundary of the active view, by selection; dropped when the view changes. */
let belowCache: { token: string; reads: Map<string, StreamRead> } | null = null;

function belowOnce(key: string | undefined, token: string, read: () => StreamRead): StreamRead {
  if (key === undefined) return read();
  if (belowCache?.token !== token) belowCache = { token, reads: new Map() };
  const cached = belowCache.reads.get(key);
  if (cached !== undefined) return cached;
  const fresh = read();
  // A read that missed records is read again next time.
  if (fresh.unreadable.length === 0 && !fresh.skippedPending) belowCache.reads.set(key, fresh);
  return fresh;
}

/** The records of `ref` in `partition` as the window of `view` sees them. */
export function readStreamViewed(
  root: string,
  partition: StorePartition,
  ref: StreamRef,
  view: StoreReadView,
  options: ViewedReadOptions = {},
): StreamRead {
  const keep = options.keep ?? (() => true);
  const folder = ref.ledger !== undefined ? `${ref.stream}/${ref.ledger}` : ref.stream;
  const below = belowOnce(
    options.cacheKey === undefined
      ? undefined
      : `${root}\n${partition}\n${folder}\n${options.cacheKey}`,
    view.token,
    () =>
      readStreamRecords(root, partition, ref, {
        until: boundaryOf(view, partition, folder),
        keep: (record) => keep(record) && (!isInputRecord(record) || visibleInView(view, record)),
        ...(options.month !== undefined ? { month: options.month } : {}),
        ...(options.checkpoint !== undefined ? { checkpoint: options.checkpoint } : {}),
      }),
  );
  // The state written beyond the boundary: read from each position on
  // (and whole for a shard that appeared since), without the prefix check
  // of an admission, which hashes every shard on every read.
  const records = [...below.records];
  const unreadable = [...below.unreadable];
  const seen = new Set(below.records.map((record) => record.id));
  const partitionRoot = partitionDir(root, partition);
  const offsets = boundaryOf(view, partition, folder);
  let shards: ReturnType<typeof listShards>;
  try {
    shards = listShards(partitionRoot, ref);
  } catch {
    shards = [];
    unreadable.push(folder);
  }
  for (const shard of shards) {
    if (options.month !== undefined && !options.month(monthOfShard(shard.rel))) continue;
    const offset = offsets.get(shard.rel) ?? 0;
    try {
      const scan = scanShard(
        shard.path,
        { partitionRoot, ...(offset > 0 ? { offset } : {}) },
        (r) => {
          if (r.bodyState === "pending") return;
          if (!keep(r.record) || isInputRecord(r.record) || seen.has(r.record.id)) return;
          seen.add(r.record.id);
          records.push(r.record);
        },
      );
      if (shardScanGap(scan) !== null) unreadable.push(shard.rel);
    } catch {
      unreadable.push(shard.rel);
    }
  }
  return { ...below, records, unreadable: [...new Set(unreadable)] };
}

function monthOfShard(rel: string): string {
  return rel.slice(rel.lastIndexOf("/") + 1).slice(0, 7);
}
