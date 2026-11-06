/**
 * The doctor-facing state digest check (design D6, task 1.7): read every
 * partition this machine holds and compare its digests.
 *
 * It never waits for anything: a partition this machine lacks is simply
 * not checked (no finding, no error), and devices that are offline only
 * ever show up as silent. Retire records come from the `shared`
 * partition's `settings` stream and apply to every partition's roster.
 *
 * The result is structured so doctor can render it; this module does not
 * format text or decide exit codes.
 */

import type { WallClock } from "./clock-store.ts";
import { DEVICE_RETIRE_KIND, STORE_PARTITIONS, type StorePartition } from "./constants.ts";
import type { StoreRecord } from "./envelope.ts";
import {
  compareDigests,
  type DigestComparison,
  type DigestFinding,
} from "./state-digest-compare.ts";
import { readPartition, type PartitionShard } from "./state-digest.ts";
import type { StoreHandle } from "./store-open.ts";
import { partitionDir } from "./store-paths.ts";

export interface StateDigestReport {
  /** One comparison per partition this machine holds, in partition order. */
  readonly partitions: ReadonlyArray<DigestComparison>;
  /** Partitions this machine does not hold, which were not checked. */
  readonly skipped: ReadonlyArray<StorePartition>;
  /** Every finding of every partition. */
  readonly findings: ReadonlyArray<DigestFinding>;
}

/**
 * Check the state digests of every partition `store` holds. A caller that
 * has already read the partitions passes them as `shards` (only those
 * partitions are checked), so the history is not read twice.
 */
export function checkStateDigests(
  store: Pick<StoreHandle, "root" | "partitions">,
  options: {
    readonly now?: WallClock;
    readonly shards?: ReadonlyMap<StorePartition, ReadonlyArray<PartitionShard>>;
  } = {},
): StateDigestReport {
  const nowMs = (options.now ?? (() => Date.now()))();
  const shards = new Map<StorePartition, ReadonlyArray<PartitionShard>>();
  for (const partition of STORE_PARTITIONS) {
    if (options.shards !== undefined) {
      const given = options.shards.get(partition);
      if (given !== undefined) shards.set(partition, given);
    } else if (store.partitions.has(partition)) {
      shards.set(partition, readPartition(partitionDir(store.root, partition)));
    }
  }
  const retireRecords: StoreRecord[] = (shards.get("shared") ?? [])
    .filter((shard) => shard.stream === "settings")
    .flatMap((shard) => shard.records)
    .filter((record) => record.kind === DEVICE_RETIRE_KIND);
  const partitions: DigestComparison[] = [];
  const skipped: StorePartition[] = [];
  for (const partition of STORE_PARTITIONS) {
    const own = shards.get(partition);
    if (own === undefined) {
      skipped.push(partition);
      continue;
    }
    const records = own.flatMap((shard) => shard.all);
    partitions.push(compareDigests({ partition, records, retireRecords, nowMs }));
  }
  return { partitions, skipped, findings: partitions.flatMap((p) => p.findings) };
}
