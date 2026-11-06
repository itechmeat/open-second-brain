/**
 * Records a catch-up pass found missing from the shard it credited them
 * to (design D5): a shard re-read from the start that no longer holds
 * them, or a shard that disappeared. They are removed from the index
 * only when no shard holds them any more.
 *
 * A compaction (`store/FORMAT.md`) writes the same records to a new shard
 * of the same stream and device before it removes the old one, so for a
 * while two shards hold one record and the index credits it to whichever
 * it read last. Removing on that single credit alone would drop records
 * the new shard still holds and that catch-up never reads again.
 */

import { posix } from "node:path";

import { readShard } from "../../store/reader.ts";
import { partitionDir } from "../../store/store-paths.ts";
import type { Store } from "../store.ts";
import { getRecord } from "../store/brain-records.ts";
import type { ResolvedSearchConfig } from "../types.ts";
import { ingestRecord, removeRecord } from "./ingest.ts";
import type { IndexedStore } from "./location.ts";
import type { ShardStat } from "./shard-scan.ts";

/** Records a shard no longer holds: record id to the shard key it was credited to. */
export type Orphans = Map<string, string>;

/** Length of the `YYYY-MM` month every shard name starts with. */
const SHARD_MONTH_LENGTH = "YYYY-MM".length;

/**
 * The shards a compaction can move a record between: the same partition,
 * stream, ledger and device (the key's directory) and the same month,
 * because a record lives only in a shard of its clock's month
 * (`YYYY-MM.jsonl` or a compaction output `YYYY-MM.<suffix>.jsonl`). The
 * device's other months are never read to settle an orphan.
 */
function shardGroup(key: string): string {
  return `${posix.dirname(key)}/${posix.basename(key).slice(0, SHARD_MONTH_LENGTH)}`;
}

/** What {@link settleOrphans} did. */
export interface SettledOrphans {
  /** Rows removed: no shard holds them any more. */
  readonly removed: number;
  /**
   * Shard keys whose orphans could not be settled because a sibling could
   * not be read. Their watermarks must stay as they were, so the next pass
   * finds the same orphans again and retries once the sibling reads.
   */
  readonly retry: ReadonlySet<string>;
}

/**
 * Remove the orphans no shard holds any more. A compaction writes the same
 * records to a sibling shard (same partition, stream, ledger, device and
 * month) before it removes the old one, so every present sibling not read
 * in full this pass is read here, and a record found there is credited to
 * it instead of removed.
 */
export function settleOrphans(
  index: Store,
  config: ResolvedSearchConfig,
  store: IndexedStore,
  shards: ReadonlyArray<ShardStat>,
  orphans: Orphans,
  readInFull: ReadonlySet<string>,
): SettledOrphans {
  if (orphans.size === 0) return { removed: 0, retry: new Set() };
  const groups = new Set([...orphans.values()].map(shardGroup));
  // A group with a sibling that cannot be read cannot be settled: its
  // orphans stay in the index (the sibling may hold them) rather than fail
  // the whole pass, which would fail the same way on every pass.
  const unsettled = new Set<string>();
  for (const sibling of shards) {
    if (orphans.size === 0) break;
    const group = shardGroup(sibling.key);
    if (readInFull.has(sibling.key) || !groups.has(group)) continue;
    let read: ReturnType<typeof readShard>;
    try {
      read = readShard(sibling.path, {
        partitionRoot: partitionDir(store.root, sibling.partition),
      });
    } catch {
      unsettled.add(group);
      continue;
    }
    for (const r of read.records) {
      if (!orphans.has(r.record.id)) continue;
      orphans.delete(r.record.id);
      ingestRecord(index, config, r.record, sibling, r.bodyState === "pending");
    }
  }
  const db = index.brainRecordsConnection();
  let removed = 0;
  const retry = new Set<string>();
  for (const [id, shard] of orphans) {
    if (unsettled.has(shardGroup(shard))) {
      retry.add(shard);
      continue;
    }
    const stored = getRecord(db, id);
    // Credited to another shard since: that shard holds it.
    if (stored === null || stored.shard !== shard) continue;
    removeRecord(index, stored);
    removed++;
  }
  return { removed, retry };
}
