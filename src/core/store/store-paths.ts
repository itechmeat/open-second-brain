/**
 * Where the brain store lives (design D1): the store root, its partitions,
 * shards and blobs, and the device-local state directory beside it.
 *
 * The store root comes from `OPEN_SECOND_BRAIN_STORE_ROOT`, then the
 * `store_root` machine-config key, then a per-user default under the
 * platform data directory (`platform-dirs.ts`). A root inside the
 * configured vault is refused with an error naming the setting that put it
 * there: the store exists precisely so that no Open Second Brain machine
 * file lives in the user's notes.
 *
 * The device-local state directory (locks, the persisted clock, later the
 * index and caches) is `<state root>/stores/<store id>`, outside the store
 * and never synced. Every resolver takes an injected platform source so
 * Windows paths can be tested from any host; the process forms read the
 * running process.
 */

import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix, win32 } from "node:path";

import { defaultConfigPath, discoverConfig, isValidDeviceId, resolveVault } from "../config.ts";
import {
  APP_DIR_NAME,
  dataBaseDir,
  processDirsEnv,
  stateBaseDir,
  type PlatformDirsEnv,
} from "../platform-dirs.ts";
import {
  DUAL_WRITE_STATUS_FILE,
  LEDGER_STREAM,
  STORE_BLOBS_DIR,
  STORE_DEFAULT_DIR,
  STORE_LOCKS_DIR,
  STORE_ROOT_CONFIG_KEY,
  STORE_ROOT_ENV,
  STORE_SHARD_EXT,
  STORE_STATE_DIR,
  type StorePartition,
  type StoreStream,
} from "./constants.ts";
import { isUlid } from "./ulid.ts";

/** Everything {@link resolveStoreRoot} reads, injected. */
export interface StoreRootSource extends PlatformDirsEnv {
  /** Parsed machine config (`key: value`). */
  readonly config: Readonly<Record<string, string>>;
  /** Path of the machine config file; relative values anchor to its directory. */
  readonly configPath: string;
  /** The configured vault, or `null` when none is configured. */
  readonly vault: string | null;
}

/** Which setting supplied the root. */
export type StoreRootOrigin = "env" | "config" | "default";

export interface ResolvedStoreRoot {
  readonly root: string;
  readonly origin: StoreRootOrigin;
}

/** A configured store root that sits inside the configured vault. */
export class StoreRootInsideVaultError extends Error {
  readonly root: string;
  readonly vault: string;
  readonly setting: string;
  readonly origin: StoreRootOrigin;

  constructor(root: string, vault: string, origin: StoreRootOrigin) {
    const setting =
      origin === "env"
        ? `the ${STORE_ROOT_ENV} environment variable`
        : origin === "config"
          ? `\`${STORE_ROOT_CONFIG_KEY}\` in the machine config`
          : "the default store root";
    const remedy =
      origin === "default"
        ? `set \`${STORE_ROOT_CONFIG_KEY}\` in the machine config to a directory outside the vault`
        : `change ${setting} to a directory outside the vault, or remove it to use the per-user default`;
    super(
      `the brain store root ${root} (from ${setting}) is inside the vault ${vault}; ` +
        `the store must live outside the vault: ${remedy}.`,
    );
    this.name = "StoreRootInsideVaultError";
    this.root = root;
    this.vault = vault;
    this.setting = setting;
    this.origin = origin;
  }
}

function pathsFor(platform: string): typeof posix {
  return platform === "win32" ? win32 : posix;
}

function expandHome(value: string, source: PlatformDirsEnv): string {
  const paths = pathsFor(source.platform);
  if (value === "~") return source.home;
  if (value.startsWith("~/") || (source.platform === "win32" && value.startsWith("~\\"))) {
    return paths.join(source.home, value.slice(2));
  }
  return value;
}

/**
 * The path with symlinks resolved as far as it exists, when the source
 * describes this host (a Windows source examined on Linux cannot be
 * resolved, and is compared as written).
 */
function resolveLinks(path: string, platform: string): string {
  if (platform !== process.platform) return path;
  const paths = pathsFor(platform);
  let head = path;
  const tail: string[] = [];
  for (;;) {
    try {
      return paths.join(realpathSync(head), ...tail.toReversed());
    } catch {
      const parent = paths.dirname(head);
      if (parent === head) return path;
      tail.push(paths.basename(head));
      head = parent;
    }
  }
}

/** Platforms whose default filesystems compare names without case (NTFS, APFS, HFS+). */
const CASE_INSENSITIVE_PLATFORMS: ReadonlySet<string> = new Set(["win32", "darwin"]);

/**
 * Whether `child` is `parent` or lies inside it, on `platform`'s path
 * rules. Case is folded where the default filesystem ignores it, so a
 * differently cased spelling of the vault still counts as the vault; on a
 * case-sensitive macOS volume that only errs towards "inside".
 */
export function isPathInside(child: string, parent: string, platform: string): boolean {
  const paths = pathsFor(platform);
  const fold = (p: string): string =>
    CASE_INSENSITIVE_PLATFORMS.has(platform) ? p.toLowerCase() : p;
  const rel = paths.relative(fold(paths.resolve(parent)), fold(paths.resolve(child)));
  // `..` only as a whole segment: `..store` is a child named "..store".
  const escapes = rel === ".." || rel.startsWith(`..${paths.sep}`);
  return rel === "" || (!escapes && !paths.isAbsolute(rel));
}

/**
 * Whether `child` lies inside `parent` as written or once symlinks are
 * resolved on both (macOS `/var` -> `/private/var`, a vault reached through
 * a linked folder). Every "store root inside the vault" check uses it, so
 * the resolver and the doctor cannot disagree.
 */
export function isPathInsideResolved(child: string, parent: string, platform: string): boolean {
  return (
    isPathInside(child, parent, platform) ||
    isPathInside(resolveLinks(child, platform), resolveLinks(parent, platform), platform)
  );
}

/** The per-user default store root: `<data base>/open-second-brain/store`. */
export function defaultStoreRoot(source: PlatformDirsEnv = processDirsEnv()): string {
  return pathsFor(source.platform).join(dataBaseDir(source), APP_DIR_NAME, STORE_DEFAULT_DIR);
}

/**
 * Resolve the store root from an injected source. Throws
 * {@link StoreRootInsideVaultError} when the root is the vault or inside it.
 */
export function resolveStoreRoot(source: StoreRootSource): ResolvedStoreRoot {
  const paths = pathsFor(source.platform);
  const env = source.env[STORE_ROOT_ENV]?.trim();
  const configured = source.config[STORE_ROOT_CONFIG_KEY]?.trim();
  let resolved: ResolvedStoreRoot;
  if (env) {
    resolved = { root: paths.resolve(expandHome(env, source)), origin: "env" };
  } else if (configured) {
    const expanded = expandHome(configured, source);
    const root = paths.isAbsolute(expanded)
      ? paths.normalize(expanded)
      : paths.resolve(paths.dirname(source.configPath), expanded);
    resolved = { root, origin: "config" };
  } else {
    resolved = { root: defaultStoreRoot(source), origin: "default" };
  }
  if (source.vault !== null && source.vault.trim() !== "") {
    const vault = expandHome(source.vault.trim(), source);
    if (isPathInsideResolved(resolved.root, vault, source.platform))
      throw new StoreRootInsideVaultError(resolved.root, vault, resolved.origin);
  }
  return resolved;
}

/**
 * The store root for this process: the environment, the machine config at
 * `configPath` (default: the resolved config path) and the configured vault.
 */
export function resolveConfiguredStoreRoot(configPath?: string): ResolvedStoreRoot {
  const path = configPath ?? defaultConfigPath();
  return resolveStoreRoot({
    platform: process.platform,
    home: homedir(),
    env: process.env,
    config: discoverConfig(path).data,
    configPath: path,
    vault: resolveVault(path),
  });
}

/** The device-local directory holding every store's state: `<state base>/open-second-brain/stores`. */
export function storesStateDir(source: PlatformDirsEnv = processDirsEnv()): string {
  return pathsFor(source.platform).join(stateBaseDir(source), APP_DIR_NAME, STORE_STATE_DIR);
}

/** The device-local state directory of store `storeId`: `<state base>/open-second-brain/stores/<id>`. */
export function deviceStateDirFor(
  storeId: string,
  source: PlatformDirsEnv = processDirsEnv(),
): string {
  if (!isUlid(storeId)) throw new Error(`store id "${storeId}" is not a ULID`);
  return pathsFor(source.platform).join(storesStateDir(source), storeId);
}

/**
 * The device-local dual-write status file (failure and skip counters):
 * `<state base>/open-second-brain/stores/dual-write.json`. It sits beside
 * the per-store directories because a failure may happen before any store
 * could be opened.
 */
export function dualWriteStatusPath(source: PlatformDirsEnv = processDirsEnv()): string {
  return pathsFor(source.platform).join(storesStateDir(source), DUAL_WRITE_STATUS_FILE);
}

/** Directory of one partition. */
export function partitionDir(root: string, partition: StorePartition): string {
  return join(root, partition);
}

/** A stream, with the ledger name the `ledgers` stream needs. */
export interface StreamRef {
  readonly stream: StoreStream;
  readonly ledger?: string;
}

/** Ledger names: lowercase words joined by hyphens. */
export const LEDGER_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Months as `YYYY-MM`. */
export const SHARD_MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** The UTC month (`YYYY-MM`) of a millisecond timestamp: the shard a record goes to. */
export function shardMonth(physicalMs: number): string {
  return new Date(physicalMs).toISOString().slice(0, 7);
}

function streamSegments(ref: StreamRef): string[] {
  if (ref.stream === LEDGER_STREAM) {
    if (ref.ledger === undefined || !LEDGER_NAME_RE.test(ref.ledger)) {
      throw new Error(`the ${LEDGER_STREAM} stream needs a ledger name matching ${LEDGER_NAME_RE}`);
    }
    return [ref.stream, ref.ledger];
  }
  if (ref.ledger !== undefined) throw new Error(`stream ${ref.stream} takes no ledger name`);
  return [ref.stream];
}

/**
 * The shard path relative to its partition, always with `/` separators:
 * the form records (the `compacted` marker) use to name a shard.
 */
export function shardRelPath(ref: StreamRef, device: string, month: string): string {
  if (!isValidDeviceId(device)) throw new Error(`"${device}" is not a valid device id`);
  if (!SHARD_MONTH_RE.test(month)) throw new Error(`"${month}" is not a YYYY-MM month`);
  return posix.join(...streamSegments(ref), device, `${month}.${STORE_SHARD_EXT}`);
}

/** Absolute shard path: `<root>/<partition>/<stream>[/<ledger>]/<device>/<YYYY-MM>.jsonl`. */
export function shardPath(
  root: string,
  partition: StorePartition,
  ref: StreamRef,
  device: string,
  month: string,
): string {
  return join(partitionDir(root, partition), ...shardRelPath(ref, device, month).split("/"));
}

const SHA256_RE = /^[0-9a-f]{64}$/;

/** Blob path inside a partition: `blobs/<sha[0:2]>/<sha>`. */
export function blobPath(partitionRoot: string, sha: string): string {
  if (!SHA256_RE.test(sha)) throw new Error(`"${sha}" is not a sha256 hex digest`);
  return join(partitionRoot, STORE_BLOBS_DIR, sha.slice(0, 2), sha);
}

/** The `lstat` identity a stamp reads off one fs entry (`bigint`, so ctime is ns). */
function lstatIdentity(path: string): string {
  const st = lstatSync(path, { bigint: true });
  return `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`;
}

/**
 * Availability stamp of the blob `sha` under `partitionRoot`: the `lstat`
 * identity of the blob file plus that of its `blobs/<ab>` folder, or
 * `"absent"`. `lstat`, not `stat`: the reader accepts a blob only as a
 * regular file of the recorded size and sha (and its folder only as a real
 * folder), so the stamp must move when an identity changes without size or
 * mtime moving - a symlink replaced by the real file or folder (`mv`,
 * `cp -p`, `rsync -a` keeps both), or a same-size blob repaired in place
 * with its mtime kept, where only ctime moves. A malformed sha reads as
 * absent, like a blob that is not there.
 */
export function blobStamp(partitionRoot: string, sha: string): string {
  try {
    const blob = lstatIdentity(blobPath(partitionRoot, sha));
    const folder = lstatIdentity(join(partitionRoot, STORE_BLOBS_DIR, sha.slice(0, 2)));
    return `${blob};${folder}`;
  } catch {
    return "absent";
  }
}

/**
 * The fingerprint lines for the `<partition>/<sha>` identities a cached
 * read or fold skipped: one `"blob <identity>=<stamp>"` line each, or
 * `null` when any of them is present. Callers stamp after the build: a
 * blob absent then was absent during it, so the skip was correct and the
 * lines belong with the shard part of the fingerprint. A blob present
 * after the build arrived during it (or is there but refused), so no line
 * a later read could match exists - `null` tells the caller to leave the
 * read uncached.
 */
export function pendingBlobStampLines(
  root: string,
  identities: ReadonlyArray<string>,
): string | null {
  let lines = "";
  for (const identity of identities.toSorted()) {
    const slashAt = identity.indexOf("/");
    const partition = identity.slice(0, slashAt) as StorePartition;
    const sha = identity.slice(slashAt + 1);
    const stamp = blobStamp(partitionDir(root, partition), sha);
    if (stamp === "absent") lines += `blob ${identity}=absent\n`;
    else return null;
  }
  return lines;
}

/** Device-local lock target of one shard (the lock is `<target>.lock`, never in the store). */
export function shardLockTarget(
  deviceStateDir: string,
  partition: StorePartition,
  rel: string,
): string {
  return join(deviceStateDir, STORE_LOCKS_DIR, partition, ...rel.split("/"));
}
