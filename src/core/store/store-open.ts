/**
 * Open an existing brain store, and describe it as a {@link StoreHandle}
 * the appender and reader work through.
 *
 * A partition is held on this machine when its folder carries the store
 * identity file (`store.json`, `{ "store_id": <ulid>, "format": 1 }`).
 * Opening never creates a store or a partition: a store is created only by
 * `o2b store init` (`store-init.ts`). A root that holds no partition is
 * refused with {@link NoStoreError}, so a writer on a second machine whose
 * sync has not delivered the store yet cannot mint a store id of its own.
 * The format document of the root and of every held partition is
 * refreshed (never downgraded).
 *
 * Partitions of two different stores under one root are refused by name.
 *
 * The held partitions are sticky per machine (`held-ledger.ts`): the
 * writing open records them, and a partition this machine has held whose
 * identity file is now missing makes both opens refuse with
 * {@link HeldPartitionLostError}, so a protection reader fails closed
 * instead of reading a shared-only store.
 */

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { processDirsEnv, type PlatformDirsEnv } from "../platform-dirs.ts";
import { isUsableLocalDeviceId } from "../config.ts";
import { STORE_IDENTITY_FILE, STORE_PARTITIONS, type StorePartition } from "./constants.ts";
import { writeFormatDoc } from "./format-doc.ts";
import { lostHeldPartitions, recordHeldPartitions } from "./held-ledger.ts";
import { deviceStateDirFor, partitionDir } from "./store-paths.ts";
import { isUlid } from "./ulid.ts";

/** An opened store, as one device sees it. */
export interface StoreHandle {
  /** The store root. */
  readonly root: string;
  /** The store id shared by every partition. */
  readonly storeId: string;
  /** This device's id; it names every shard this device writes. */
  readonly device: string;
  /** Device-local state directory: locks, the persisted clock. Never synced. */
  readonly deviceStateDir: string;
  /** Partitions this machine holds. */
  readonly partitions: ReadonlySet<StorePartition>;
}

export interface OpenStoreOptions {
  readonly root: string;
  readonly device: string;
  /** Platform source for the device-local directory (default: this process). */
  readonly dirs?: PlatformDirsEnv;
}

/** A store that cannot be opened as asked. */
export class StoreOpenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreOpenError";
  }
}

/** The root holds no store yet; `o2b store init` creates one. */
export class NoStoreError extends StoreOpenError {
  constructor(readonly root: string) {
    super(
      `no brain store at ${root}: no partition holds ${STORE_IDENTITY_FILE}; ` +
        "run `o2b store init` to create one, or let sync deliver it from a machine that has it",
    );
    this.name = "NoStoreError";
  }
}

/** A partition's identity file exists but holds no valid store id (corrupt, or half written). */
export class StoreIdentityError extends StoreOpenError {
  constructor(message: string) {
    super(message);
    this.name = "StoreIdentityError";
  }
}

/**
 * A partition this machine has held lost its identity file: the store as it
 * shows now would read without that partition's records, so it is not
 * opened at all (design D14, fail closed).
 */
export class HeldPartitionLostError extends StoreOpenError {
  constructor(
    readonly root: string,
    readonly partitions: ReadonlyArray<StorePartition>,
  ) {
    super(
      `the ${partitions.join(" and ")} partition${partitions.length > 1 ? "s" : ""} of the ` +
        `brain store at ${root}, which this machine has held, no longer show${
          partitions.length > 1 ? "" : "s"
        } ${STORE_IDENTITY_FILE}; its records cannot be read, so the store is not opened. ` +
        `Restore ${partitions.map((p) => `${p}/${STORE_IDENTITY_FILE}`).join(" and ")} ` +
        "from sync or a backup",
    );
    this.name = "HeldPartitionLostError";
  }
}

/** The store id in a partition's identity file; `null` when the partition is not held. */
export function readStoreId(dir: string): string | null {
  let text: string;
  try {
    text = readFileSync(join(dir, STORE_IDENTITY_FILE), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  let parsed: { store_id?: unknown };
  try {
    parsed = JSON.parse(text) as { store_id?: unknown };
  } catch {
    throw new StoreIdentityError(`${join(dir, STORE_IDENTITY_FILE)} is not valid JSON`);
  }
  if (!isUlid(parsed.store_id)) {
    throw new StoreIdentityError(`${join(dir, STORE_IDENTITY_FILE)} carries no valid store_id`);
  }
  return parsed.store_id;
}

/**
 * The partitions under `root` that carry an identity file, and the one
 * store id they share. Throws {@link StoreOpenError} when they belong to
 * different stores. The one rule of which partitions count as held, for
 * the read-only open, the writing open and `store init`.
 */
export function heldPartitions(root: string): {
  held: Set<StorePartition>;
  storeId: string | null;
} {
  // A root that exists but is not a directory holds no store and never
  // will. Said here, because the partition reads below cannot: POSIX
  // answers them with ENOTDIR, but Windows answers ENOENT, which would
  // read as "no store yet, run init".
  if (statSync(root, { throwIfNoEntry: false })?.isDirectory() === false) {
    throw new StoreOpenError(
      `the brain store root ${root} is not a directory; move the file away or point ` +
        "the store root at a directory",
    );
  }
  const ids = new Map<StorePartition, string>();
  for (const partition of STORE_PARTITIONS) {
    const id = readStoreId(partitionDir(root, partition));
    if (id !== null) ids.set(partition, id);
  }
  if (new Set(ids.values()).size > 1) {
    throw new StoreOpenError(
      `the partitions under ${root} belong to different stores (${[...ids]
        .map(([p, id]) => `${p}: ${id}`)
        .join(", ")}); keep one store per root`,
    );
  }
  const first = ids.values().next();
  return { held: new Set(ids.keys()), storeId: first.done === true ? null : first.value };
}

/**
 * {@link heldPartitions}, refused with {@link HeldPartitionLostError} when a
 * partition this machine has held no longer shows its identity file.
 */
function heldPartitionsChecked(root: string): ReturnType<typeof heldPartitions> {
  const found = heldPartitions(root);
  const lost = lostHeldPartitions(root, found.held);
  if (lost.length > 0) throw new HeldPartitionLostError(root, lost);
  return found;
}

/** What a read-only look at a store root finds. */
export interface StoreInspection {
  readonly root: string;
  readonly storeId: string;
  readonly partitions: ReadonlySet<StorePartition>;
}

/**
 * Look at the store at `root` without creating or refreshing anything:
 * `null` when no partition holds an identity file. Throws
 * {@link StoreOpenError} when the partitions belong to different stores,
 * or a partition this machine has held lost its identity file. For
 * read-only callers (doctor); writers use {@link openStore}.
 */
export function inspectStore(root: string): StoreInspection | null {
  const { held, storeId } = heldPartitionsChecked(root);
  return storeId === null ? null : { root, storeId, partitions: held };
}

/** Open the store at `options.root`; throws {@link NoStoreError} when it holds none. */
export function openStore(options: OpenStoreOptions): StoreHandle {
  if (!isUsableLocalDeviceId(options.device)) {
    throw new StoreOpenError(
      `the brain store needs a device id, got "${options.device}"; set device_id in the machine ` +
        `config or O2B_DEVICE_ID to lowercase letters, digits and hyphens`,
    );
  }
  const { held, storeId } = heldPartitionsChecked(options.root);
  if (storeId === null) throw new NoStoreError(options.root);
  recordHeldPartitions(options.root, held, options.dirs);
  // The root copy is device-local (the root is never synced), so it is
  // refreshed like every partition copy.
  writeFormatDoc(options.root);
  for (const partition of held) writeFormatDoc(partitionDir(options.root, partition));
  return {
    root: options.root,
    storeId,
    device: options.device,
    deviceStateDir: deviceStateDirFor(storeId, options.dirs ?? processDirsEnv()),
    partitions: held,
  };
}
