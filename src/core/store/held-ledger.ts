/**
 * The partitions this machine has held, per store root (design D14, fail
 * closed). A partition counts as held while its folder carries the store
 * identity file (`store-open.ts`). That answer alone is not safe for a
 * protection: when `private/store.json` goes missing while its shards stay
 * (a sync tool rewriting it, a partial restore), the store would open as
 * shared-only, the lane fold would skip the private shards, and a lane
 * overwrite that drops the visibility field would land its text in
 * `shared`, which every machine receives.
 *
 * So the held partitions are sticky per machine, like the switch
 * (`store-only.ts`). Opening a store for writing and initialising it record
 * here, device-locally, every partition this machine holds (one marker
 * file each, so concurrent opens never lose one another's record). From then on a
 * recorded partition whose identity file is missing makes the store
 * unopenable by name (`HeldPartitionLostError` in `store-open.ts`), so every
 * protection reader fails closed exactly as for an unopenable store, and
 * every write refuses. A machine that never held a partition is unaffected.
 *
 * One command takes a partition off this record: `o2b store partition leave
 * <partition>` (`partition-leave.ts`), once the partition's identity file is
 * gone. The other remedy is to restore the identity file (sync, or a backup).
 * The list is keyed by the store root as configured, like the switch marker.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

import { atomicWriteFileSync } from "../fs-atomic.ts";
import { processDirsEnv, type PlatformDirsEnv } from "../platform-dirs.ts";
import { STORE_PARTITIONS, type StorePartition } from "./constants.ts";
import { storesStateDir } from "./store-paths.ts";

/**
 * Device-local folder holding one marker file per store root and held
 * partition. One file per fact, never a shared list rewritten in place:
 * two processes opening the store at once each only create their own
 * markers, so neither can drop what the other recorded (a read-modify-write
 * of one list could, and a partition dropped that way would no longer fail
 * closed when its identity file later went missing).
 */
export const HELD_LEDGER_DIR = "held-partitions";

function ledgerDir(dirs: PlatformDirsEnv = processDirsEnv()): string {
  return join(storesStateDir(dirs), HELD_LEDGER_DIR);
}

function markerPath(dir: string, root: string, partition: StorePartition): string {
  const key = createHash("sha256").update(resolve(root)).digest("hex").slice(0, 32);
  return join(dir, `${key}.${partition}`);
}

/**
 * Record that this machine holds `partitions` of the store at `root`, in
 * the device-local state of `dirs` (default: this process). Never throws:
 * the markers only make a lost identity file fail closed, and the next open
 * records again. Already recorded partitions write nothing.
 */
export function recordHeldPartitions(
  root: string,
  partitions: Iterable<StorePartition>,
  dirs?: PlatformDirsEnv,
): void {
  const dir = ledgerDir(dirs);
  for (const partition of partitions) {
    const marker = markerPath(dir, root, partition);
    if (existsSync(marker)) continue;
    try {
      mkdirSync(dir, { recursive: true });
      // The content names the root for a human reading the folder; only
      // the file's existence counts.
      atomicWriteFileSync(marker, `${resolve(root)}\n`);
    } catch {
      // see above
    }
  }
}

/**
 * The partitions this machine has held at `root` that `held` (what the
 * identity files show now) lacks, in partition order. Empty when the store
 * shows every partition, without reading the markers.
 */
export function lostHeldPartitions(
  root: string,
  held: ReadonlySet<StorePartition>,
): StorePartition[] {
  if (STORE_PARTITIONS.every((p) => held.has(p))) return [];
  const dir = ledgerDir();
  return STORE_PARTITIONS.filter((p) => !held.has(p) && existsSync(markerPath(dir, root, p)));
}

/**
 * Whether this machine holds a marker for the partition at `root`: the
 * fact {@link recordHeldPartitions} wrote and {@link HeldPartitionLostError}
 * reads.
 */
export function isHeldPartitionMarked(root: string, partition: StorePartition): boolean {
  return existsSync(markerPath(ledgerDir(), root, partition));
}

/**
 * Take the partition off this machine's held list: remove the marker, and
 * return `true` when one was there. `false` changes nothing.
 */
export function forgetHeldPartition(root: string, partition: StorePartition): boolean {
  const marker = markerPath(ledgerDir(), root, partition);
  if (!existsSync(marker)) return false;
  rmSync(marker, { force: true });
  return true;
}
