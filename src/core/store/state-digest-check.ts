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
import { STORE_PARTITIONS, type StorePartition } from "./constants.ts";
import type { StoreRecord } from "./envelope.ts";
import {
  compareDigests,
  type DigestComparison,
  type DigestFinding,
} from "./state-digest-compare.ts";
import { readPartitionView, type PartitionView } from "./partition-view.ts";
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
 * has already read the partitions passes them as `views` (only those
 * partitions are checked), so the history is not read twice. Each
 * partition is read record by record (`partition-view.ts`): the check
 * keeps the digests and each device's first and last record, not the
 * history.
 */
export function checkStateDigests(
  store: Pick<StoreHandle, "root" | "partitions">,
  options: {
    readonly now?: WallClock;
    readonly views?: ReadonlyMap<StorePartition, PartitionView>;
  } = {},
): StateDigestReport {
  const nowMs = (options.now ?? (() => Date.now()))();
  const views = new Map<StorePartition, PartitionView>();
  for (const partition of STORE_PARTITIONS) {
    if (options.views !== undefined) {
      const given = options.views.get(partition);
      if (given !== undefined) views.set(partition, given);
    } else if (store.partitions.has(partition)) {
      views.set(partition, readPartitionView(partitionDir(store.root, partition), {}, nowMs));
    }
  }
  const retireRecords: ReadonlyArray<StoreRecord> = views.get("shared")?.retireRecords ?? [];
  const partitions: DigestComparison[] = [];
  const skipped: StorePartition[] = [];
  for (const partition of STORE_PARTITIONS) {
    const own = views.get(partition);
    if (own === undefined) {
      skipped.push(partition);
      continue;
    }
    partitions.push(
      compareDigests({ partition, records: own.digestRecords, retireRecords, nowMs }),
    );
  }
  return { partitions, skipped, findings: partitions.flatMap((p) => p.findings) };
}
