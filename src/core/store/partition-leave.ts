/**
 * Take a partition off this machine on purpose (design D7 of change
 * `store-hardening`).
 *
 * The held partitions are sticky (`held-ledger.ts`): a machine that held a
 * partition whose `store.json` is gone refuses every store operation. This
 * module clears what this machine kept of a partition once its folder no
 * longer carries the identity file: the held marker, the seen-shard
 * entries and the digest caches, marker last, so a failed clearing leaves
 * the machine still holding the partition (it fails closed, and
 * `HeldPartitionLostError` still names the verb). A `store.json` that
 * returns is held again by `recordHeldPartitions`.
 */

import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { digestCacheRoot } from "../brain/compiled-digest-path.ts";
import { STORE_IDENTITY_FILE, type StorePartition } from "./constants.ts";
import { forgetHeldPartition, isHeldPartitionMarked } from "./held-ledger.ts";
import { readStoreId } from "./store-open.ts";
import { forgetSeenPartition } from "./seen-shards.ts";
import { partitionDir } from "./store-paths.ts";

/** Why {@link leavePartition} refuses. */
export class PartitionLeaveRefusal extends Error {
  constructor(
    readonly reason: "shared" | "still-held" | "files-left" | "no-store-id" | "clear-failed",
    message: string,
  ) {
    super(message);
    this.name = "PartitionLeaveRefusal";
  }
}

/** What a leave reported: whether it left, and what it cleared. */
export interface LeavePartitionResult {
  readonly left: boolean;
  readonly partition: StorePartition;
  readonly cleared: {
    readonly heldMarker: boolean;
    readonly seenShards: number;
    readonly digestCaches: boolean;
  };
}

/**
 * Take `partition` off this machine's held list of the store at `root`:
 * refuse what it cannot do safely, then clear this machine's device-local
 * state of it, marker last.
 */
export function leavePartition(options: {
  readonly root: string;
  readonly partition: StorePartition;
  readonly force?: boolean;
}): LeavePartitionResult {
  const { root, partition } = options;
  if (partition === "shared") {
    throw new PartitionLeaveRefusal(
      "shared",
      "the shared partition holds every rule of the brain store; leaving it is leaving " +
        "the store, which this command does not do",
    );
  }
  const dir = partitionDir(root, partition);
  const refuseStillHeld = (): void => {
    if (!existsSync(join(dir, STORE_IDENTITY_FILE))) return;
    throw new PartitionLeaveRefusal(
      "still-held",
      `${join(dir, STORE_IDENTITY_FILE)} is still here, so the ${partition} partition is not ` +
        `left; stop syncing ${dir}, remove the folder, then run the command again`,
    );
  };
  refuseStillHeld();
  if (!isHeldPartitionMarked(root, partition)) {
    return {
      left: false,
      partition,
      cleared: { heldMarker: false, seenShards: 0, digestCaches: false },
    };
  }
  let entries: string[];
  try {
    entries = existsSync(dir) ? readdirSync(dir) : [];
  } catch (err) {
    const code = (err as { code?: string } | null)?.code ?? "unknown";
    throw new PartitionLeaveRefusal(
      "files-left",
      `could not list ${dir} (${code}), so this machine's state of the ${partition} partition ` +
        "cannot be checked; fix the cause, then run the command again",
    );
  }
  if (entries.length > 0 && options.force !== true) {
    throw new PartitionLeaveRefusal(
      "files-left",
      `${dir} still holds ${entries.length} item(s) of the ${partition} partition without its ` +
        `${STORE_IDENTITY_FILE}; remove the folder, or pass --force to leave the partition ` +
        "anyway (its files are then ignored on this machine)",
    );
  }
  let storeId: string | null;
  let idProblem: string | null = null;
  try {
    storeId = readStoreId(partitionDir(root, "shared"));
  } catch (err) {
    storeId = null;
    idProblem = err instanceof Error ? err.message : String(err);
  }
  if (storeId === null) {
    // `idProblem` is null for a missing file and otherwise the read's own
    // error, which already carries the full path, so the wording below
    // names the path once either way.
    const what =
      idProblem ?? `${join(partitionDir(root, "shared"), STORE_IDENTITY_FILE)} is missing`;
    throw new PartitionLeaveRefusal(
      "no-store-id",
      `${what}, so the device-local state of the ${partition} partition cannot be found; ` +
        "restore the shared partition's identity file first (sync, or a backup), then run the " +
        "command again",
    );
  }
  let digestCaches = false;
  let seenShards = 0;
  try {
    const cacheDir = digestCacheRoot(storeId);
    const existed = existsSync(cacheDir);
    rmSync(cacheDir, { recursive: true, force: true });
    digestCaches = existed;
    seenShards = forgetSeenPartition(root, storeId, partition);
  } catch (err) {
    throw new PartitionLeaveRefusal(
      "clear-failed",
      `could not clear this machine's state of the ${partition} partition ` +
        `(${err instanceof Error ? err.message : String(err)}); the partition is still held ` +
        "here; fix the cause, then run the command again",
    );
  }
  // A sync tool may have brought the identity file back while the caches
  // were cleared: the marker goes only while the file is still absent.
  refuseStillHeld();
  let heldMarker: boolean;
  try {
    heldMarker = forgetHeldPartition(root, partition);
  } catch (err) {
    throw new PartitionLeaveRefusal(
      "clear-failed",
      `could not remove the held marker of the ${partition} partition ` +
        `(${err instanceof Error ? err.message : String(err)}); the partition is still held ` +
        "here; fix the cause, then run the command again",
    );
  }
  return {
    left: true,
    partition,
    cleared: { heldMarker, seenShards, digestCaches },
  };
}
