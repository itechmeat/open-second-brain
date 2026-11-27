/**
 * Shared helpers of the tests 2.0.4 owed (change `lane-reach-residuals`,
 * package 19): the raw records of both partitions of a test's store, for
 * the comparison around every refused call.
 */

import { join } from "node:path";

import { readPartition } from "../../src/core/store/state-digest.ts";
import type { LaneEnv } from "../core/lanes/fixtures/lane-env.ts";

/** Every record of both partitions, by id, as the store holds them. */
export function rawRecords(e: LaneEnv): string {
  const ids = (partition: "shared" | "private") =>
    readPartition(join(e.env.storeRoot, partition))
      .flatMap((shard) => shard.all)
      .map((r) => r.id)
      .toSorted();
  return JSON.stringify({ shared: ids("shared"), private: ids("private") });
}
