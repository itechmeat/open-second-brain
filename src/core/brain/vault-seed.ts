/**
 * The datum every machine of a legacy vault holds alike before the update
 * (patch 2.0.1): the name and first line of the oldest legacy log shard, a
 * finished day of one device that sync delivered long ago. A vault with no
 * identity marker mints its vault id from it (`vault-identity.ts`), and the
 * store a vault's migration creates takes its id from the vault id
 * (`init-store.ts`), so two machines that create the store, or mint the
 * marker, before they see each other's agree on both.
 */

import { readFileSync } from "node:fs";

import { compareCodeUnits } from "../store/compare.ts";
import { listLogShardFiles } from "./log-jsonl.ts";

/**
 * The name and first line of the oldest legacy log shard with a line
 * (names sort by day, then device), or null when there is none or the log
 * cannot be read.
 */
export function legacyLogSeed(vault: string): string | null {
  try {
    const shards = listLogShardFiles(vault).filter((f) => f.ext === "jsonl");
    for (const shard of shards.toSorted((a, b) => compareCodeUnits(a.name, b.name))) {
      // A finished day of one device: a small file, read once.
      const line = readFileSync(shard.path, "utf8").split("\n", 1)[0]!.trim();
      if (line !== "") return `${shard.name}\n${line}`;
    }
  } catch {
    // no log to agree on
  }
  return null;
}
