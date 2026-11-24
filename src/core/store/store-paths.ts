/**
 * Where the brain store lives (design D1): the store root, its partitions,
 * shards and blobs, and the device-local state directory beside it.
 *
 * The store root comes from `OPEN_SECOND_BRAIN_STORE_ROOT`, then the
 * `store_root` machine-config key, then a default. With a vault the
 * default is the reserved hidden folder `.open-second-brain-store/` in the
 * vault root ({@link vaultStoreRoot}), so the store rides the sync the user
 * already has for the vault and reaches every machine with no setup. With
 * no vault it is a per-user folder under the platform data directory
 * (`platform-dirs.ts`). One exception keeps the 2.0.0 default: a machine
 * whose store still sits at the per-user folder (it switched before the
 * default moved) keeps using it until the automatic relocation moved it
 * into the vault (`store-relocation.ts`) and left a `relocated.json` there.
 *
 * Any other root inside the configured vault is refused with an error
 * naming the setting that put it there: the store's machine files stay out
 * of the user's notes, and the reserved folder is the one place the note
 * tools, the walkers and the search index are built to skip.
 *
 * The device-local state directory (locks, the persisted clock, later the
 * index and caches) is `<state root>/stores/<store id>`, outside the store
 * and never synced. Every resolver takes an injected platform source so
 * Windows paths can be tested from any host; the process forms read the
 * running process.
 */

import { existsSync, lstatSync, realpathSync } from "node:fs";
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
  STORE_IDENTITY_FILE,
  STORE_PARTITIONS,
  STORE_RELOCATED_FILE,
  STORE_VAULT_DIR,
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
import { readRelocationMarker, storeIdsAt } from "./relocation-target.ts";
import { isUlid } from "./ulid.ts";

/** Everything {@link resolveStoreRoot} reads, injected. */
export interface StoreRootSource extends PlatformDirsEnv {
  /** Parsed machine config (`key: value`). */
  readonly config: Readonly<Record<string, string>>;
  /** Path of the machine config file; relative values anchor to its directory. */
  readonly configPath: string;
  /** The configured vault, or `null` when none is configured. */
  readonly vault: string | null;
  /**
   * Whether a file exists (default: the file system, when the source
   * describes this host; never, for another platform's paths). Asked only
   * for the default root, to tell a 2.0.0 store left at the per-user
   * folder that has not been relocated into the vault yet.
   */
  readonly exists?: (path: string) => boolean;
}

/** Which setting supplied the root. */
export type StoreRootOrigin = "env" | "config" | "default";

/**
 * Where a default root sits: the reserved folder of the vault, or the
 * per-user folder (no vault, or a 2.0.0 store there not relocated yet).
 * Always `external` for a root a setting named.
 */
export type StoreRootPlacement = "vault" | "external";

export interface ResolvedStoreRoot {
  readonly root: string;
  readonly origin: StoreRootOrigin;
  readonly placement: StoreRootPlacement;
  /**
   * The default root is the per-user folder only because a store there
   * still waits to be relocated into the vault (the root the relocation
   * moves it to is {@link vaultStoreRoot} of the vault).
   */
  readonly relocationPending: boolean;
}

/** A configured store root that sits inside the configured vault. */
export class StoreRootInsideVaultError extends Error {
  readonly root: string;
  readonly vault: string;
  readonly setting: string;
  readonly origin: StoreRootOrigin;

  constructor(
    root: string,
    vault: string,
    origin: StoreRootOrigin,
    linkedTo: string | null = null,
  ) {
    const setting =
      origin === "env"
        ? `the ${STORE_ROOT_ENV} environment variable`
        : origin === "config"
          ? `\`${STORE_ROOT_CONFIG_KEY}\` in the machine config`
          : "the default store root";
    const remedy =
      origin === "default"
        ? `set \`${STORE_ROOT_CONFIG_KEY}\` in the machine config to a directory outside the vault`
        : `change ${setting} to a directory outside the vault, or remove it to use the default ` +
          `(the vault's ${STORE_VAULT_DIR}/ folder)`;
    const linked =
      linkedTo === null
        ? ""
        : `the vault's ${STORE_VAULT_DIR}/ folder is a link to ${linkedTo}, another place in ` +
          "the vault, so it is not the reserved folder (replace the link with a folder); ";
    super(
      `the brain store root ${root} (from ${setting}) is inside the vault ${vault}; ${linked}` +
        `the only store root allowed inside the vault is its ${STORE_VAULT_DIR}/ folder: ${remedy}.`,
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

/**
 * The per-user store root: `<data base>/open-second-brain/store`. The
 * default with no vault, and the 2.0.0 default of every installation.
 */
export function defaultStoreRoot(source: PlatformDirsEnv = processDirsEnv()): string {
  return pathsFor(source.platform).join(dataBaseDir(source), APP_DIR_NAME, STORE_DEFAULT_DIR);
}

/** The reserved store folder of `vault`: `<vault>/.open-second-brain-store`. */
export function vaultStoreRoot(vault: string, platform: string = process.platform): string {
  return pathsFor(platform).join(vault, STORE_VAULT_DIR);
}

function samePath(a: string, b: string, platform: string): boolean {
  return isPathInside(a, b, platform) && isPathInside(b, a, platform);
}

/**
 * Where the vault's reserved store folder leads when it is a link (or sits
 * under one) to another place inside the vault, such as the legacy
 * `Brain/` tree or the vault itself; null when it is a real folder, an
 * alias of the reserved folder, or leads out of the vault. A store there
 * would be written into the user's notes, or moved out with the legacy
 * tree, so such a folder is no store root.
 */
export function reservedFolderLeadsIntoVault(vault: string, platform: string): string | null {
  const reserved = resolveLinks(vaultStoreRoot(vault, platform), platform);
  const real = resolveLinks(vault, platform);
  if (!isPathInside(reserved, real, platform)) return null;
  return samePath(reserved, vaultStoreRoot(real, platform), platform) ? null : reserved;
}

/**
 * Whether `root` is exactly the reserved store folder of `vault` (symlinks
 * and case judged): the same path as written, or the same path once
 * symlinks are resolved on both. Each equality is judged on one pair; a
 * root inside the folder as written whose link leads back out (to the
 * vault itself) is not the folder, and neither is a reserved folder that
 * is itself a link to another place in the vault
 * ({@link reservedFolderLeadsIntoVault}).
 */
export function isVaultStoreRoot(root: string, vault: string, platform: string): boolean {
  const reserved = vaultStoreRoot(vault, platform);
  const match =
    samePath(root, reserved, platform) ||
    samePath(resolveLinks(root, platform), resolveLinks(reserved, platform), platform);
  return match && reservedFolderLeadsIntoVault(vault, platform) === null;
}

/**
 * Whether `root` may not be a store root because of `vault`: it is the
 * vault or inside it, and is not the vault's reserved store folder. Every
 * "store root inside the vault" refusal asks this one predicate.
 */
export function storeRootForbiddenInVault(root: string, vault: string, platform: string): boolean {
  return isPathInsideResolved(root, vault, platform) && !isVaultStoreRoot(root, vault, platform);
}

/**
 * The store at a 2.0.0 default root, as the resolver sees it: `none` (no
 * partition carries the identity file), `active` (a store not relocated
 * away), `moved` (its `relocated.json` is a valid marker of the store that
 * root holds) or `unreadable` (a marker is there and cannot be read,
 * `relocation-target.ts`). A valid marker of another store (a store put
 * back at the old root beside an earlier move's marker) names no move of
 * the one there: that one is `active`. Another platform's paths are
 * judged by existence alone.
 */
export function externalStoreState(
  root: string,
  platform: string,
  exists: (path: string) => boolean,
): "none" | "active" | "moved" | "unreadable" {
  const paths = pathsFor(platform);
  if (!STORE_PARTITIONS.some((p) => exists(paths.join(root, p, STORE_IDENTITY_FILE)))) {
    return "none";
  }
  if (!exists(paths.join(root, STORE_RELOCATED_FILE))) return "active";
  if (platform !== process.platform) return "moved";
  const read = readRelocationMarker(root);
  if (read.kind === "unreadable") return "unreadable";
  // Gone since `exists` saw it (or an injected `exists` describes files
  // this host does not hold): judged by existence, as before.
  if (read.kind === "absent") return "moved";
  // The marker must be the move of the store this root holds. Identity
  // files that cannot be read (or are not there to read) leave the open
  // to refuse them, as before; only another store's identity is `active`.
  const ids = storeIdsAt(root);
  if (ids.size === 0 || ids.has(read.marker.store_id) || ids.has("unreadable")) return "moved";
  return "active";
}

/**
 * Whether the vault store folder `dest`, which a committed move's marker
 * names, holds exactly that store now (`storeId`). A folder that holds no
 * store yet (its identity files not synced back), another store, or one
 * that cannot be read does not: a fresh store is never created there in
 * its place, and the old root is named so the open refuses with the
 * relocation's reason (`store-open.ts`).
 */
function holdsMovedStore(dest: string, storeId: string): boolean {
  const ids = storeIdsAt(dest);
  return ids.size === 1 && ids.has(storeId);
}

function hostExists(platform: string): (path: string) => boolean {
  return platform === process.platform ? (path) => existsSync(path) : () => false;
}

/**
 * Resolve the store root from an injected source. Throws
 * {@link StoreRootInsideVaultError} when the root is the vault or inside
 * it, unless it is the vault's reserved store folder.
 */
export function resolveStoreRoot(source: StoreRootSource): ResolvedStoreRoot {
  const paths = pathsFor(source.platform);
  const env = source.env[STORE_ROOT_ENV]?.trim();
  const configured = source.config[STORE_ROOT_CONFIG_KEY]?.trim();
  let resolved: ResolvedStoreRoot;
  if (env) {
    resolved = {
      root: paths.resolve(expandHome(env, source)),
      origin: "env",
      placement: "external",
      relocationPending: false,
    };
  } else if (configured) {
    const expanded = expandHome(configured, source);
    const root = paths.isAbsolute(expanded)
      ? paths.normalize(expanded)
      : paths.resolve(paths.dirname(source.configPath), expanded);
    resolved = { root, origin: "config", placement: "external", relocationPending: false };
  } else {
    resolved = defaultRoot(source);
  }
  if (source.vault !== null && source.vault.trim() !== "") {
    const vault = expandHome(source.vault.trim(), source);
    if (storeRootForbiddenInVault(resolved.root, vault, source.platform)) {
      throw new StoreRootInsideVaultError(
        resolved.root,
        vault,
        resolved.origin,
        reservedFolderLeadsIntoVault(vault, source.platform),
      );
    }
    if (resolved.origin !== "default" && isVaultStoreRoot(resolved.root, vault, source.platform)) {
      resolved = { ...resolved, placement: "vault" };
    }
  }
  return resolved;
}

/** The default root of `source` (module docblock). */
function defaultRoot(source: StoreRootSource): ResolvedStoreRoot {
  const external = defaultStoreRoot(source);
  const vault = source.vault?.trim() ?? "";
  if (vault === "") {
    return { root: external, origin: "default", placement: "external", relocationPending: false };
  }
  const exists = source.exists ?? hostExists(source.platform);
  const state = externalStoreState(external, source.platform, exists);
  if (state === "active") {
    return { root: external, origin: "default", placement: "external", relocationPending: true };
  }
  // A marker that cannot be read: the old root is named, and opening it
  // refuses with the marker's path (`store-open.ts`), as a stale handle's
  // write does, so neither a new process nor `store init` takes the vault
  // folder for the store while the old one may hold its records.
  if (state === "unreadable") {
    return { root: external, origin: "default", placement: "external", relocationPending: false };
  }
  const inVault = vaultStoreRoot(
    pathsFor(source.platform).resolve(expandHome(vault, source)),
    source.platform,
  );
  // A move committed into this very folder whose store is not there now
  // (not synced back yet, replaced, removed): the old root is named, so
  // the open refuses with the relocation's reason, and nothing creates a
  // fresh store, or binds another one, where the moved store belongs.
  if (state === "moved" && source.platform === process.platform) {
    const marker = readRelocationMarker(external);
    if (
      marker.kind === "valid" &&
      samePath(
        resolveLinks(marker.marker.to, source.platform),
        resolveLinks(inVault, source.platform),
        source.platform,
      ) &&
      !holdsMovedStore(marker.marker.to, marker.marker.store_id)
    ) {
      return { root: external, origin: "default", placement: "external", relocationPending: false };
    }
  }
  return { root: inVault, origin: "default", placement: "vault", relocationPending: false };
}

/**
 * The store root for this process: the environment, the machine config at
 * `configPath` (default: the resolved config path) and the configured vault
 * (or `vault`, when the caller resolved it already and goes on with it).
 */
export function resolveConfiguredStoreRoot(
  configPath?: string,
  vault?: string | null,
): ResolvedStoreRoot {
  const path = configPath ?? defaultConfigPath();
  return resolveStoreRoot({
    platform: process.platform,
    home: homedir(),
    env: process.env,
    config: discoverConfig(path).data,
    configPath: path,
    vault: vault === undefined ? resolveVault(path) : vault,
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
 * folder). The identity is never stored - it is compared only inside
 * fingerprints. `pendingBlobStampLines` keeps the `"absent"` lines of a
 * cached read, so there a stamp moves whenever an identity changes without
 * size or mtime moving - a symlink replaced by the real file or folder
 * (`mv`, `cp -p`, `rsync -a` keeps both), or a same-size blob repaired in
 * place with its mtime kept, where only ctime moves. The incomplete-fold
 * stamp (`lane-fold-cache.ts`) uses the full identity itself, so its memo
 * moves with a refused blob's repair too. A malformed sha reads as
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
