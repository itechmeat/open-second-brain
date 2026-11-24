/**
 * Moving a store from the per-user folder into the vault (patch 2.0.1).
 *
 * Release 2.0.0 put the default store root in the per-user data folder,
 * which nothing syncs: a machine that switched there wrote a store no
 * other machine ever received. Since 2.0.1 the default root of an
 * installation with a vault is the vault's reserved folder
 * (`.open-second-brain-store/`, `store-paths.ts`). A machine whose store
 * still sits at the old default keeps using it until a person runs
 * `o2b store move-into-vault` on it with its agent sessions closed
 * (`store-migration/move-into-vault.ts`); nothing starts the move by
 * itself, because a move that races live writers, stale processes and the
 * sync tool cannot be made safe at a session start.
 *
 *  1. `locked`: the device-local relocation lock is held (a process lock:
 *     a crashed relocation leaves no holder; a second run is refused, not
 *     queued). Every store append on this machine checks it under its
 *     shard lock and does not write while it is held.
 *  2. `quiesced`: no shard lock is held and no other writer the caller
 *     can see runs ({@link RelocationOptions.liveWriters}); otherwise the
 *     move is refused, never waited for, and the person is told to close
 *     the agent sessions. An append that takes its shard lock after this
 *     point sees the relocation lock and does not write.
 *  3. `copied`: every held partition is copied into the vault folder. A
 *     partition the folder does not have yet is copied whole into a hidden
 *     staging folder (`.relocating-<store id>/`) and renamed into place,
 *     so it appears with its identity file and every record at once, and
 *     a store that another machine's sync puts there meanwhile makes the
 *     rename fail instead of receiving this store's files. A partition
 *     already there with this store's identity is completed file by file,
 *     each through a temp name and a rename: a file is kept when it holds
 *     the copy as a prefix (the same, or grown since), replaced when it is
 *     a prefix of the copy (an earlier, shorter copy) and still the file
 *     that was compared, and anything else stops the relocation: two
 *     copies that diverged are never merged, whichever device wrote them.
 *     A partition folder of another store, one holding files but no
 *     identity (a store still arriving), or a vault folder or partition
 *     folder that is a link stops it too. This device's own shards are
 *     copied up to their last whole line: a line an older process is
 *     still writing is carried later, whole.
 *  4. `verified`: every byte copied is compared with the source.
 *  5. `bound`: the device-local bindings keyed by the store root (store
 *     identity, vault binding, the switched marker, the held partitions)
 *     name the new root too.
 *  6. `committed`: the copy is verified once more, then `relocated.json`
 *     is written into the old root. From then on the root resolver names
 *     the vault folder, a stale process whose store handle names the old
 *     root appends to the new root instead (`relocatedRootOf`), and
 *     nothing of this release writes the old root again: it stays as an
 *     inactive recovery copy.
 *
 * The store id, every record id and the device id are kept: the bytes are
 * the same bytes. A crash at any boundary leaves the old root active (no
 * `relocated.json`), and the next run of the command starts again from
 * the top; every step is idempotent. A store with another id already in
 * the vault folder is never merged with this one: the relocation stops and
 * says so, and the machine keeps writing its old root.
 *
 * A process of an older release that still runs (an MCP server started
 * before the update) knows nothing of the marker and may append to the
 * old root after the commit. {@link carryLateWrites} brings such lines and
 * blobs into the new root when the command runs again (it also runs at
 * the end of every move), so they are not lost.
 */

import { createHash } from "node:crypto";
import {
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmdirSync,
  rmSync,
  type Stats,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import { readDeviceId, resolveVault } from "../config.ts";
import { atomicWriteFileSync, renameWithRetry } from "../fs-atomic.ts";
import { processDirsEnv } from "../platform-dirs.ts";
import {
  MOVE_INTO_VAULT_COMMAND,
  STORE_FORMAT_FILE,
  STORE_IDENTITY_FILE,
  STORE_LOCKS_DIR,
  STORE_PARTITIONS,
  STORE_RELOCATED_FILE,
  STORE_SHARD_EXT,
  type StorePartition,
} from "./constants.ts";
import { recordHeldPartitions } from "./held-ledger.ts";
import { STORE_LOCK_STALE_MS, withLocalLock } from "./local-lock.ts";
import { acquireProcessLock } from "./process-lock.ts";
import { bindRelocatedStoreIdentity } from "./store-identity.ts";
import { createStoreTempFile, ensureStoreDir, openShardForAppend } from "./safe-fs.ts";
import {
  heldPartitions,
  heldPartitionsChecked,
  LinkedVaultStoreFolderError,
  readStoreId,
  StoreOpenError,
} from "./store-open.ts";
import {
  defaultStoreRoot,
  deviceStateDirFor,
  partitionDir,
  resolveConfiguredStoreRoot,
  shardLockTarget,
  vaultStoreRoot,
} from "./store-paths.ts";
import {
  readRelocatedMarker,
  relocatedRootOf,
  relocationLockTarget,
  relocationOf,
  type RelocatedMarker,
} from "./relocation-marker.ts";

export { MOVE_INTO_VAULT_COMMAND } from "./constants.ts";
export {
  readRelocatedMarker,
  relocatedRootOf,
  relocationLockTarget,
  relocationRunning,
  waitForRelocation,
  type RelocatedMarker,
} from "./relocation-marker.ts";
import { deviceSwitchedHere, recordSwitchMarker } from "./store-only.ts";
import {
  bindingNamesVault,
  bindVaultToStore,
  readVaultBindings,
} from "../vault-adapter/vault-binding.ts";

/** The relocation's step boundaries, in order (module docblock). */
export const RELOCATION_STEP = Object.freeze({
  locked: "relocation-locked",
  quiesced: "relocation-quiesced",
  copied: "relocation-copied",
  verified: "relocation-verified",
  bound: "relocation-bound",
  committed: "relocation-committed",
} as const);

export type RelocationStep = (typeof RELOCATION_STEP)[keyof typeof RELOCATION_STEP];

export type RelocationOutcome =
  | { readonly kind: "not-needed" }
  | {
      readonly kind: "relocated";
      readonly from: string;
      readonly to: string;
      readonly storeId: string;
      readonly files: number;
    }
  /** Something only a person can resolve: the reason names it. Nothing was committed. */
  | {
      readonly kind: "refused";
      readonly from: string;
      readonly to: string;
      readonly reason: string;
    }
  /**
   * Something writes the store on this machine now (a shard lock is held,
   * or a writer the caller sees runs): nothing was copied. `writers` says
   * what, one entry each.
   */
  | {
      readonly kind: "live";
      readonly from: string;
      readonly to: string;
      readonly writers: ReadonlyArray<string>;
    }
  /** Another relocation of this store runs on this machine. */
  | { readonly kind: "busy" };

export interface RelocationOptions {
  readonly configPath?: string;
  /**
   * Writers of this store the caller can see that hold no shard lock now
   * (a dream pass, a migration worker), one description each; asked once,
   * under the relocation lock, after the shard locks were looked at.
   */
  readonly liveWriters?: (deviceStateDir: string) => ReadonlyArray<string>;
  /**
   * Fault injection for the crash tests: called at each boundary. An
   * in-process option only; no flag, variable or config key reaches it.
   */
  readonly atStep?: (step: RelocationStep) => void;
  /** Clock of the shard-lock age rule (tests); default `Date.now`. */
  readonly now?: () => number;
}

/** A relocation that must not go on; the reason is for the person. */
export class StoreRelocationRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreRelocationRefused";
  }
}

/** Where a pending relocation moves the store from and to. */
export interface PendingRelocation {
  readonly from: string;
  readonly to: string;
  readonly vault: string;
}

/**
 * The relocation this machine owes, or null: the configured store root is
 * the default one, a vault is configured, and the store still sits at the
 * per-user folder (`store-paths.ts`). The vault is read once, so the
 * root's eligibility and the destination are judged against the same
 * vault. Cheap: two `stat`s when nothing is owed. Never throws.
 */
export function pendingRelocation(configPath?: string): PendingRelocation | null {
  try {
    const vault = resolveVault(configPath);
    if (vault === null || vault.trim() === "") return null;
    const resolved = resolveConfiguredStoreRoot(configPath, vault);
    if (!resolved.relocationPending) return null;
    const abs = resolve(vault.trim());
    return { from: resolved.root, to: vaultStoreRoot(abs), vault: abs };
  } catch {
    return null;
  }
}

function deviceOf(configPath: string | undefined): string {
  const fromEnv = process.env["O2B_DEVICE_ID"]?.trim();
  if (fromEnv) return fromEnv;
  return readDeviceId(configPath ?? null) ?? "";
}

/** Every regular file below `dir`, as paths relative to it with `/` separators. */
function filesBelow(dir: string, base: string = dir): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesBelow(path, base));
    else if (entry.isFile()) out.push(relative(base, path).split(sep).join("/"));
  }
  return out;
}

/** Whether a partition-relative path is a shard this device writes. */
function ownShard(rel: string, device: string): boolean {
  const segments = rel.split("/");
  return (
    segments.length >= 3 &&
    segments[segments.length - 2] === device &&
    segments[segments.length - 1]!.endsWith(`.${STORE_SHARD_EXT}`)
  );
}

/** What a file at a name looked like when it was compared: absent, or its identity and size. */
type FileVersion =
  | { readonly kind: "absent" }
  | {
      readonly kind: "file";
      readonly dev: bigint;
      readonly ino: bigint;
      readonly size: bigint;
      readonly mtimeNs: bigint;
    };

function versionOf(path: string): FileVersion {
  try {
    const st = lstatSync(path, { bigint: true });
    return { kind: "file", dev: st.dev, ino: st.ino, size: st.size, mtimeNs: st.mtimeNs };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    throw err;
  }
}

function sameVersion(a: FileVersion, b: FileVersion): boolean {
  if (a.kind === "absent" || b.kind === "absent") return a.kind === b.kind;
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs;
}

/** The file at a copy's destination changed since it was compared; compare again. */
class DestinationChanged extends Error {
  constructor(path: string) {
    super(`${path} changed while it was being replaced`);
    this.name = "DestinationChanged";
  }
}

/**
 * Copy bytes to `dest` (under the partition folder `partitionRoot`)
 * through a dot-named temp file in its folder and a rename. No symlink
 * below the partition folder is followed (`safe-fs.ts`). With `compared`,
 * the rename happens only while the file at `dest` is still the version
 * the caller compared (absent, or the same file of the same size and
 * time); otherwise nothing is replaced and {@link DestinationChanged} is
 * thrown, so a version a sync delivered meanwhile is compared before it
 * could be overwritten.
 */
function writeTo(partitionRoot: string, dest: string, bytes: Buffer, compared?: FileVersion): void {
  ensureStoreDir(partitionRoot, dirname(dest));
  const temp = join(dirname(dest), `.relocating-${process.pid}-${dest.length}.tmp`);
  // Created exclusively at 0600, never through a link a sync left at the
  // name (`safe-fs.ts`): that would truncate a file outside the store.
  const fd = createStoreTempFile(temp);
  try {
    let written = 0;
    while (written < bytes.length) written += writeSync(fd, bytes, written);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    if (compared !== undefined && !sameVersion(versionOf(dest), compared)) {
      throw new DestinationChanged(dest);
    }
    renameSync(temp, dest);
  } catch (err) {
    try {
      unlinkSync(temp);
    } catch {
      // nothing left to clean
    }
    throw err;
  }
}

function readOrNull(path: string): Buffer | null {
  try {
    return readFileSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

function startsWith(whole: Buffer, prefix: Buffer): boolean {
  return whole.length >= prefix.length && whole.subarray(0, prefix.length).equals(prefix);
}

/** `bytes` up to and including its last newline: the whole lines of a shard. */
function wholeLines(bytes: Buffer): Buffer {
  return bytes.subarray(0, bytes.lastIndexOf(0x0a) + 1);
}

/**
 * What of the file at `rel` (partition-relative) the relocation copies:
 * this device's own shards up to their last whole line (an older process
 * that knows no relocation lock may be writing the next one, which the
 * late-write carry brings over whole), every other file as it is.
 */
function bytesToCopy(rel: string, device: string, bytes: Buffer): Buffer {
  return ownShard(rel, device) ? wholeLines(bytes) : bytes;
}

/** How often a destination file that keeps changing is compared again before the move stops. */
const COMPARE_TRIES = 5;

/**
 * Copy `bytes` to the file `rel` of the partition folder `partitionRoot`
 * (step 3); throws {@link StoreRelocationRefused} when a file already there
 * diverged from it. A file there that holds `bytes` as a prefix is kept,
 * one that is a prefix of `bytes` is replaced, and only while it is still
 * the version compared: one a sync delivered meanwhile is compared again,
 * so a longer copy is never overwritten by a shorter one. Who wrote either
 * never makes divergent bytes disposable.
 */
function copyOne(partitionRoot: string, rel: string, bytes: Buffer): void {
  const destPath = join(partitionRoot, ...rel.split("/"));
  for (let attempt = 0; attempt < COMPARE_TRIES; attempt++) {
    const compared = versionOf(destPath);
    const dest = compared.kind === "absent" ? null : readOrNull(destPath);
    try {
      if (dest === null) {
        if (bytes.length > 0) writeTo(partitionRoot, destPath, bytes, { kind: "absent" });
        return;
      }
      // Refreshed by every open, never downgraded (`format-doc.ts`): the one there stays.
      if (rel === STORE_FORMAT_FILE) return;
      if (startsWith(dest, bytes)) return;
      if (startsWith(bytes, dest)) {
        writeTo(partitionRoot, destPath, bytes, compared);
        return;
      }
    } catch (err) {
      if (err instanceof DestinationChanged) continue;
      throw err;
    }
    throw new StoreRelocationRefused(
      `the copy of ${rel} already in ${partitionRoot} differs from this machine's and neither ` +
        "holds the other; the two stores are not merged",
    );
  }
  throw new StoreRelocationRefused(
    `the copy of ${rel} already in ${partitionRoot} kept changing while it was compared ` +
      "(the vault's sync is writing it); nothing was committed. Let the sync settle, then run " +
      "the command again",
  );
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * The vault's store folder as a real folder, created when it is missing.
 * A link there (or a junction) is refused: the store would be copied
 * wherever it leads, outside the folder the vault's sync carries.
 */
function destinationRoot(to: string): void {
  const stat = lstatOrNull(to);
  if (stat === null) {
    mkdirSync(to, { mode: 0o700 });
    return;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new StoreRelocationRefused(
      `the vault's store folder ${to} is ${stat.isSymbolicLink() ? "a link" : "not a folder"}; ` +
        `the store is not copied through it. Replace it with a folder, then run ${MOVE_INTO_VAULT_COMMAND} again`,
    );
  }
}

/**
 * What is at the destination partition folder `dest`: nothing (`absent`;
 * an empty folder, or one holding only dot-named leftovers of a sync tool
 * or a crashed copy, is cleared to nothing), or this store's partition
 * (`ours`). Anything else is refused: a link, another store's partition,
 * or a folder with files and no identity (a store still arriving).
 */
function destinationPartition(dest: string, storeId: string): "absent" | "ours" {
  const stat = lstatOrNull(dest);
  if (stat === null) return "absent";
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new StoreRelocationRefused(
      `${dest} is ${stat.isSymbolicLink() ? "a link" : "not a folder"}; the store is not ` +
        `copied through it. Replace it with a folder, then run ${MOVE_INTO_VAULT_COMMAND} again`,
    );
  }
  let id: string | null;
  try {
    id = readStoreId(dest);
  } catch (err) {
    if (err instanceof StoreOpenError) throw new StoreRelocationRefused(err.message);
    throw err;
  }
  if (id === storeId) return "ours";
  if (id !== null) {
    throw new StoreRelocationRefused(
      `${dest} belongs to another brain store (id ${id}, this machine's is ${storeId}); ` +
        "the two are not merged",
    );
  }
  const entries = readdirSync(dest, { withFileTypes: true });
  const kept = entries.filter((e) => !(e.isFile() && e.name.startsWith(".")));
  if (kept.length > 0) {
    throw new StoreRelocationRefused(
      `${dest} holds ${kept
        .slice(0, 3)
        .map((e) => e.name)
        .join(", ")} but no ${STORE_IDENTITY_FILE} (a brain store that has not arrived in ` +
        "full, or the rest of one); nothing was copied into it. Let the sync finish, or move " +
        `it away, then run ${MOVE_INTO_VAULT_COMMAND} again`,
    );
  }
  for (const e of entries) unlinkSync(join(dest, e.name));
  rmdirSync(dest);
  return "absent";
}

/** The hidden staging folder of a store's copy inside the vault's store folder. */
function stagingName(storeId: string): string {
  return `.relocating-${storeId}`;
}

/**
 * Step 3 (module docblock): copy every held partition of `from` into `to`
 * and return, per `<partition>/<rel>`, the bytes copied.
 */
function copyPartitions(
  from: string,
  to: string,
  storeId: string,
  device: string,
  files: ReadonlyMap<StorePartition, ReadonlyArray<string>>,
): Map<string, number> {
  destinationRoot(to);
  const stage = join(to, stagingName(storeId));
  // A crashed run's staging folder: removed, never followed through a link.
  rmSync(stage, { recursive: true, force: true });
  const copied = new Map<string, number>();
  const copyAll = (partition: StorePartition, partitionRoot: string): void => {
    const list = files.get(partition)!;
    const ordered = [
      ...list.filter((rel) => rel !== STORE_IDENTITY_FILE),
      ...list.filter((rel) => rel === STORE_IDENTITY_FILE),
    ];
    for (const rel of ordered) {
      const bytes = bytesToCopy(
        rel,
        device,
        readFileSync(join(from, partition, ...rel.split("/"))),
      );
      copyOne(partitionRoot, rel, bytes);
      copied.set(`${partition}/${rel}`, bytes.length);
    }
  };
  try {
    for (const [partition] of files) {
      const dest = join(to, partition);
      if (destinationPartition(dest, storeId) === "ours") {
        copyAll(partition, dest);
        continue;
      }
      const staged = join(stage, partition);
      mkdirSync(stage, { recursive: true, mode: 0o700 });
      mkdirSync(staged, { mode: 0o700 });
      copyAll(partition, staged);
      try {
        renameWithRetry(staged, dest);
      } catch (err) {
        // Something took the name since it was examined: examined again (it
        // refuses another store's partition, or one still arriving), and an
        // empty folder there is cleared for one more try.
        if (lstatOrNull(dest) === null || destinationPartition(dest, storeId) !== "absent") {
          throw err;
        }
        renameWithRetry(staged, dest);
      }
    }
  } finally {
    // Nothing of this store stays in the vault's sync outside its partitions.
    rmSync(stage, { recursive: true, force: true });
  }
  return copied;
}

function sha(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * The shard locks of this store held now (step 2): every `<target>.lock`
 * directory below the device-local lock folder younger than the age after
 * which a lock counts as a crashed holder's. A lock folder that is missing
 * holds nothing; one that cannot be read throws, so a move never starts
 * beside an append it could not see.
 */
export function liveShardLocks(deviceStateDir: string, now: () => number = Date.now): string[] {
  const locks = join(deviceStateDir, STORE_LOCKS_DIR);
  const held: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // Gone since it was listed (a released lock): nothing is held there.
      if (code === "ENOENT" || code === "ENOTDIR") return;
      throw err;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (!entry.isDirectory()) continue;
      if (!entry.name.endsWith(".lock")) {
        walk(path);
        continue;
      }
      let age: number;
      try {
        age = now() - statSync(path).mtimeMs;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw err;
      }
      if (age < STORE_LOCK_STALE_MS) held.push(relative(locks, path.slice(0, -".lock".length)));
    }
  };
  walk(locks);
  return held.map((rel) => rel.split(sep).join("/")).toSorted();
}

/**
 * Step 4 (module docblock): every file copied holds the source's bytes in
 * the destination. Returns the offsets the marker records: of this
 * device's own shards (which an older process may have grown since the
 * copy) and of blobs, by `<partition>/<rel>`. Throws when a copy does not
 * hold them: nothing is committed, and the next run copies it again.
 */
function verifyCopy(input: {
  readonly from: string;
  readonly to: string;
  readonly device: string;
  readonly held: ReadonlyArray<StorePartition>;
  readonly files: ReadonlyMap<StorePartition, ReadonlyArray<string>>;
  readonly lengths: ReadonlyMap<string, number>;
}): Record<string, number> {
  const { from, to, device } = input;
  const copied: Record<string, number> = {};
  for (const partition of input.held) {
    for (const rel of input.files.get(partition)!) {
      if (rel === STORE_FORMAT_FILE) continue;
      const path = `${partition}/${rel}`;
      const length = input.lengths.get(path)!;
      const original = readFileSync(join(from, ...path.split("/")));
      const copy = readOrNull(join(to, ...path.split("/")));
      const holds =
        length === 0 ||
        (copy !== null &&
          copy.length >= length &&
          original.length >= length &&
          sha(copy.subarray(0, length)) === sha(original.subarray(0, length)));
      // Only this device's own shards may have grown since the copy (an
      // older process appending; the carry brings its lines after the
      // commit). Every other file must be in the copy in full.
      const grows = ownShard(rel, device);
      if (!holds || (!grows && original.length !== length)) {
        throw new Error(
          `the copy of ${path} in ${to} does not hold the bytes of the original; nothing was ` +
            "committed, and the next run of the command copies it again",
        );
      }
      if (grows || rel.startsWith("blobs/")) copied[path] = length;
    }
  }
  return copied;
}

/**
 * Relocate this machine's store into the vault, when one is owed
 * ({@link pendingRelocation}). Never throws for a store that cannot move:
 * a refusal is an outcome that names its reason. A failure of the file
 * system throws, and leaves the old root active for the next run.
 */
export function relocateStore(options: RelocationOptions = {}): RelocationOutcome {
  const pending = pendingRelocation(options.configPath);
  if (pending === null) return { kind: "not-needed" };
  const { from, to } = pending;
  const refused = (reason: string): RelocationOutcome => ({ kind: "refused", from, to, reason });
  const device = deviceOf(options.configPath);
  if (device === "") {
    return refused("this machine has no device id; set device_id in the machine config");
  }
  let source: ReturnType<typeof heldPartitions>;
  try {
    // The open's own rule: a partition this machine has held whose
    // identity file is gone refuses the move, as it refuses the open, so
    // the vault folder never becomes a store without that partition.
    source = heldPartitionsChecked(from);
  } catch (err) {
    return refused(err instanceof Error ? err.message : String(err));
  }
  const storeId = source.storeId;
  if (storeId === null) return { kind: "not-needed" };
  const deviceStateDir = deviceStateDirFor(storeId, processDirsEnv());
  let release: () => void;
  try {
    mkdirSync(deviceStateDir, { recursive: true });
    release = acquireProcessLock(relocationLockTarget(deviceStateDir), {
      label: "store relocation lock",
      budgetMs: 0,
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ELOCKED") return { kind: "busy" };
    throw err;
  }
  try {
    options.atStep?.(RELOCATION_STEP.locked);
    // Another run may have committed since the move was found owed.
    if (relocatedRootOf(from, storeId) !== null) return { kind: "not-needed" };
    const linked = lstatOrNull(to)?.isSymbolicLink() === true;
    if (linked) {
      return refused(
        `the vault's store folder ${to} is a link; the store is not copied through it. ` +
          `Replace it with a folder, then run ${MOVE_INTO_VAULT_COMMAND} again`,
      );
    }
    // A staging folder a run killed mid-copy left (`copyPartitions`) goes
    // first, so a refusal below leaves none of this store's files in the
    // vault's sync.
    rmSync(join(to, stagingName(storeId)), { recursive: true, force: true });
    let target: ReturnType<typeof heldPartitions>;
    try {
      target = heldPartitions(to);
    } catch (err) {
      if (err instanceof LinkedVaultStoreFolderError) {
        return refused(`${err.message}. Nothing was moved`);
      }
      if (err instanceof StoreOpenError) {
        return refused(
          `the vault's store folder ${to} holds partitions of two stores (${err.message}); ` +
            "nothing was moved",
        );
      }
      throw err;
    }
    if (target.storeId !== null && target.storeId !== storeId) {
      return refused(
        `the vault's store folder ${to} already holds another brain store (id ${target.storeId}, ` +
          `this machine's is ${storeId}); the two are not merged. This machine keeps using ` +
          `${from}. Decide which store to keep: move one of them away, then run ${MOVE_INTO_VAULT_COMMAND} again`,
      );
    }
    // Refused, never waited for: the person runs the move with the agent
    // sessions closed, and one still writing is named. An append that
    // takes its shard lock from here on sees the relocation lock and does
    // not write (`appender.ts`).
    const writers = [
      ...liveShardLocks(deviceStateDir, options.now).map((lock) => `an append to ${lock} runs`),
      ...(options.liveWriters?.(deviceStateDir) ?? []),
    ];
    if (writers.length > 0) return { kind: "live", from, to, writers };
    options.atStep?.(RELOCATION_STEP.quiesced);

    const held = [...source.held];
    const files = new Map<StorePartition, string[]>();
    for (const partition of held) {
      files.set(
        partition,
        filesBelow(partitionDir(from, partition)).filter(
          (rel) => !rel.split("/").some((s) => s.startsWith(".")),
        ),
      );
    }
    let lengths: Map<string, number>;
    try {
      lengths = copyPartitions(from, to, storeId, device, files);
    } catch (err) {
      if (err instanceof StoreRelocationRefused) return refused(err.message);
      throw err;
    }
    options.atStep?.(RELOCATION_STEP.copied);

    const verify = (): Record<string, number> =>
      verifyCopy({ from, to, device, held, files, lengths });
    verify();
    options.atStep?.(RELOCATION_STEP.verified);

    bindRelocatedStoreIdentity(from, to, storeId, device);
    recordHeldPartitions(to, held);
    // The vault binding moves only when it names the vault the store now
    // rides: one bound to another vault would otherwise vouch for this
    // vault's settings having been imported, and skip their migration.
    if (
      readVaultBindings().some(
        (b) => b.root === from && b.store_id === storeId && bindingNamesVault(b, pending.vault),
      )
    ) {
      bindVaultToStore(pending.vault, { store: { root: to, storeId, device } });
    }
    if (deviceSwitchedHere({ root: from, partitions: source.held }, device)) {
      recordSwitchMarker(to, device);
    }
    options.atStep?.(RELOCATION_STEP.bound);

    // Checked again at the commit point: the bindings took time, and a
    // sync may have replaced a verified file since. The offsets the
    // marker records are the ones this check accepted.
    const copied = verify();
    const marker: RelocatedMarker = {
      store_id: storeId,
      to,
      device,
      at: new Date().toISOString(),
      files: copied,
    };
    atomicWriteFileSync(join(from, STORE_RELOCATED_FILE), `${JSON.stringify(marker, null, 2)}\n`);
    options.atStep?.(RELOCATION_STEP.committed);
    return { kind: "relocated", from, to, storeId, files: Object.keys(copied).length };
  } finally {
    release();
  }
}

/** Device-local file: how much of each file of the old root was carried over already. */
function carriedPath(deviceStateDir: string): string {
  return join(deviceStateDir, "relocation-carried.json");
}

function readCarried(path: string): Record<string, number> {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, number> = {};
    for (const [rel, n] of Object.entries(parsed)) {
      if (typeof n === "number" && Number.isSafeInteger(n) && n >= 0) out[rel] = n;
    }
    return out;
  } catch {
    return {};
  }
}

/** Record that the old root's file `rel` is carried up to `size` bytes. */
function saveCarried(path: string, rel: string, size: number): void {
  mkdirSync(dirname(path), { recursive: true });
  withLocalLock(path, () => {
    const carried = readCarried(path);
    carried[rel] = Math.max(carried[rel] ?? 0, size);
    atomicWriteFileSync(path, `${JSON.stringify(carried)}\n`);
  });
}

/** The old root this machine's store moved away from, with its marker, when it moved here. */
function movedHere(configPath?: string): { from: string; marker: RelocatedMarker } | null {
  let root: string;
  try {
    const resolved = resolveConfiguredStoreRoot(configPath);
    if (resolved.placement !== "vault" || resolved.origin !== "default") return null;
    root = resolved.root;
  } catch {
    return null;
  }
  const from = defaultStoreRoot(processDirsEnv());
  const marker = readRelocatedMarker(from);
  if (marker === null || resolve(marker.to) !== resolve(root)) return null;
  if (marker.device !== deviceOf(configPath)) return null;
  // Lines are carried only into the store they belong to: a destination
  // that holds no store or another one now (removed, replaced, not synced
  // back yet) receives nothing, and the lines wait in the old root.
  if (relocationOf(from, marker.store_id).kind !== "moved") return null;
  return { from, marker };
}

/** Whether the file at `path` holds a newline in its bytes from `start` to `end`. */
function newlineBetween(path: string, start: number, end: number): boolean {
  const fd = openSync(path, "r");
  try {
    const bytes = Buffer.alloc(end - start);
    let read = 0;
    while (read < bytes.length) {
      const n = readSync(fd, bytes, read, bytes.length - read, start + read);
      if (n === 0) break;
      read += n;
    }
    return bytes.subarray(0, read).includes(0x0a);
  } finally {
    closeSync(fd);
  }
}

/**
 * Whether what earlier carries brought of the old root's file `path` is
 * still in the new root: every whole line of the shard from the commit
 * offset to the carried offset, or the blob whole. A sync that put back an
 * older copy of the new root's file (the same store) drops it, and then
 * the file is owed again. The new root's files only grow (no compaction
 * rewrites them in this release), so a line once there stays there.
 */
function carriedStillThere(
  from: string,
  to: string,
  path: string,
  carriedTo: number,
  committed: number,
): boolean {
  const there = readOrNull(join(to, ...path.split("/")));
  if (path.split("/")[1] === "blobs") return there !== null && there.length === carriedTo;
  if (carriedTo <= committed) return true;
  if (there === null) return false;
  const source = readFileSync(join(from, ...path.split("/"))).subarray(committed, carriedTo);
  return linesOf(source).every((line) => holdsLine(there, line));
}

/**
 * This device's files in the old root with something the new root lacks:
 * a blob grown past what was carried, a shard with a whole line past it
 * (a line still being written, or one a crash tore and nothing followed,
 * is not owed), or a file whose carried bytes the new root no longer holds
 * ({@link carriedStillThere}).
 */
function lateFiles(from: string, marker: RelocatedMarker): Array<{ rel: string }> {
  const deviceStateDir = deviceStateDirFor(marker.store_id, processDirsEnv());
  const carried = readCarried(carriedPath(deviceStateDir));
  const out: Array<{ rel: string }> = [];
  for (const partition of STORE_PARTITIONS) {
    for (const rel of filesBelow(partitionDir(from, partition))) {
      if (rel.split("/").some((s) => s.startsWith("."))) continue;
      const blob = rel.startsWith("blobs/");
      if (!ownShard(rel, marker.device) && !blob) continue;
      const path = `${partition}/${rel}`;
      const committed = marker.files[path] ?? 0;
      const base = carried[path] ?? committed;
      const file = join(from, ...path.split("/"));
      const size = statSync(file).size;
      if (size > base && (blob || newlineBetween(file, base, size))) out.push({ rel: path });
      else if (
        carried[path] !== undefined &&
        !carriedStillThere(from, marker.to, path, carried[path], committed)
      ) {
        out.push({ rel: path });
      }
    }
  }
  return out;
}

/**
 * Whether a process of an older release appended to the old root after
 * the relocation, so {@link carryLateWrites} has lines or blobs to bring
 * over. A walk of this device's own folders in the old root; never throws.
 */
export function lateWritesPending(configPath?: string): boolean {
  try {
    const moved = movedHere(configPath);
    return moved !== null && lateFiles(moved.from, moved.marker).length > 0;
  } catch {
    return false;
  }
}

/** Whether `whole` (a shard) holds `line` (one line with its newline) as one of its lines. */
function holdsLine(whole: Buffer, line: Buffer): boolean {
  if (whole.subarray(0, line.length).equals(line)) return true;
  return whole.indexOf(Buffer.concat([Buffer.from([0x0a]), line])) >= 0;
}

/** The lines of `bytes` (which ends with a newline), each with its newline; empty lines left out. */
function linesOf(bytes: Buffer): Buffer[] {
  const out: Buffer[] = [];
  let at = 0;
  while (at < bytes.length) {
    const end = bytes.indexOf(0x0a, at);
    if (end > at) out.push(bytes.subarray(at, end + 1));
    at = end + 1;
  }
  return out;
}

/** Every byte of the open file `fd`, `size` bytes long. */
function readWhole(fd: number, size: number): Buffer {
  const bytes = Buffer.alloc(size);
  let read = 0;
  while (read < size) {
    const n = readSync(fd, bytes, read, size - read, read);
    if (n === 0) break;
    read += n;
  }
  return bytes.subarray(0, read);
}

/** What one late-write carry did. */
export interface CarryResult {
  /** Files of the old root whose late lines or blobs are in the new root now. */
  readonly carried: number;
  /**
   * Files left in the old root because the new root's partition did not
   * hold this store when they were to be written (removed or replaced by
   * a sync since): their offsets are not advanced, so a later run carries
   * them once the store is back.
   */
  readonly waiting: number;
}

/** Whether the partition folder `dir` carries the identity of store `storeId` now. */
function partitionHolds(dir: string, storeId: string): boolean {
  try {
    return readStoreId(dir) === storeId;
  } catch {
    return false;
  }
}

/**
 * The bytes to append to a shard that holds `present`, so that it holds
 * every line of `missing` once. A shard whose last line has no newline
 * (a carry or an append cut short) gets one first; when those unfinished
 * bytes are exactly one of the missing lines without its newline, that
 * line is finished with the newline and not appended again.
 */
function appendPayload(present: Buffer, missing: ReadonlyArray<Buffer>): Buffer {
  if (present.length === 0 || present[present.length - 1] === 0x0a) return Buffer.concat(missing);
  const unfinished = present.subarray(present.lastIndexOf(0x0a) + 1);
  const at = missing.findIndex((line) => line.subarray(0, line.length - 1).equals(unfinished));
  const rest = at < 0 ? missing : missing.filter((_, i) => i !== at);
  return Buffer.concat([Buffer.from([0x0a]), ...rest]);
}

/**
 * Bring into the new root what a stale process wrote to the old root after
 * the relocation: the whole lines appended to this device's shards, and
 * blobs the new root lacks. Readers order records by their clock, not by
 * their place in a file. Run by the move command only, at the end of a
 * move and at every later run; never at a session start.
 *
 * A shard is carried under its lock, from the offset the move committed:
 * every whole line after it that the new root's shard does not hold is
 * appended, and the offset reached is saved before the lock is released.
 * The saved offset only says where nothing more is owed
 * ({@link lateFiles}); a line it covers that the new root lost since (a
 * sync that put back an older copy) is owed again. A line the new root's
 * shard holds already is never appended again: two carries at once, a
 * carry cut short between its append and its offset, and one cut short
 * before the newline of its last line (finished, not written twice) all
 * end with each line there once. A blob is saved as carried only once the
 * new root holds its bytes. Each write first checks, at the write boundary, that the
 * new root's partition still carries this store's identity; one that does
 * not (removed or replaced by a sync) receives nothing, and the file's
 * offset stays where it was for a later run.
 */
export function carryLateWrites(configPath?: string): CarryResult {
  const moved = movedHere(configPath);
  if (moved === null) return { carried: 0, waiting: 0 };
  const { from, marker } = moved;
  const deviceStateDir = deviceStateDirFor(marker.store_id, processDirsEnv());
  const path = carriedPath(deviceStateDir);
  let carried = 0;
  let waiting = 0;
  for (const file of lateFiles(from, marker)) {
    const origin = join(from, ...file.rel.split("/"));
    const dest = join(marker.to, ...file.rel.split("/"));
    const slash = file.rel.indexOf("/");
    const partition = file.rel.slice(0, slash) as StorePartition;
    const rel = file.rel.slice(slash + 1);
    const partitionRoot = partitionDir(marker.to, partition);
    if (rel.startsWith("blobs/")) {
      if (!partitionHolds(partitionRoot, marker.store_id)) {
        waiting += 1;
        continue;
      }
      // Content-addressed: one already there whole is the same blob. One a
      // sync left short or changed is replaced by a verified copy, and the
      // offset is saved only once the new root holds the source's bytes.
      const source = readFileSync(origin);
      if (!(readOrNull(dest)?.equals(source) ?? false)) writeTo(partitionRoot, dest, source);
      if (!(readOrNull(dest)?.equals(source) ?? false)) {
        waiting += 1;
        continue;
      }
      saveCarried(path, file.rel, source.length);
      carried += 1;
      continue;
    }
    const outcome = withLocalLock(
      shardLockTarget(deviceStateDir, partition, rel),
      (): "carried" | "waiting" | "nothing" => {
        // From the commit offset, not from the carried one: a line carried
        // before and dropped from the new root since (a sync that put back
        // an older copy) is owed again, and one the new root holds is not
        // appended twice (`holdsLine` below).
        const base = marker.files[file.rel] ?? 0;
        const source = readFileSync(origin);
        if (source.length <= base) return "nothing";
        const tail = source.subarray(base);
        const end = tail.lastIndexOf(0x0a);
        if (end < 0) return "nothing";
        // At the write boundary: the partition the lines go to must still
        // be this store's, or nothing is written and the offset stays.
        if (!partitionHolds(partitionRoot, marker.store_id)) return "waiting";
        ensureStoreDir(partitionRoot, dirname(dest));
        const fd = openShardForAppend(dest);
        try {
          const size = fstatSync(fd).size;
          const present = readWhole(fd, size);
          const missing = linesOf(tail.subarray(0, end + 1)).filter((l) => !holdsLine(present, l));
          if (missing.length > 0) {
            const payload = appendPayload(present, missing);
            let written = 0;
            while (written < payload.length) written += writeSync(fd, payload, written);
            fsyncSync(fd);
          }
        } finally {
          closeSync(fd);
        }
        saveCarried(path, file.rel, base + end + 1);
        return "carried";
      },
    );
    if (outcome === "carried") carried += 1;
    else if (outcome === "waiting") waiting += 1;
  }
  return { carried, waiting };
}
