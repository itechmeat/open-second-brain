/**
 * Whether the search index is store-aware, and where it then lives
 * (design D5, task 1.8).
 *
 * A store is "in use" when the resolved store root (environment, machine
 * config, then the per-user default; see `store/store-paths.ts`) holds at
 * least one partition carrying the store identity file. Nothing here
 * creates a store or writes into one: the probe only reads `store.json`.
 *
 * When a store is in use the index lives in the store's device-local state
 * directory, one file per vault:
 * `<device state>/index/<vault key>/brain.sqlite`. When no store is in use
 * (every install before migration) the legacy vault location stays, and an
 * explicit `search_db_path` / `OPEN_SECOND_BRAIN_SEARCH_DB` override wins
 * in both cases (see `../paths.ts`).
 */

import { mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { DERIVED_STORE_FILE } from "../../brain/path-constants.ts";
import { defaultConfigPath } from "../../config.ts";
import { sha256Hex } from "../../integrity/digest.ts";
import { atomicWriteFileSync } from "../../fs-atomic.ts";
import { processDirsEnv, type PlatformDirsEnv } from "../../platform-dirs.ts";
import { STORE_PARTITIONS, type StorePartition } from "../../store/constants.ts";
import { readStoreId } from "../../store/store-open.ts";
import { isUlid } from "../../store/ulid.ts";
import {
  deviceStateDirFor,
  partitionDir,
  resolveStoreRoot,
  storesStateDir,
  StoreRootInsideVaultError,
} from "../../store/store-paths.ts";
import {
  STORE_INDEX_DIR,
  STORE_INDEX_ROOT_FILE,
  STORE_INDEX_VAULT_KEY_LENGTH,
} from "./constants.ts";

/** A store the index reads, as this machine holds it. */
export interface IndexedStore {
  readonly root: string;
  readonly storeId: string;
  /** Device-local state directory of the store (never synced). */
  readonly deviceStateDir: string;
  /** Partitions this machine holds, in {@link STORE_PARTITIONS} order. */
  readonly partitions: ReadonlyArray<StorePartition>;
}

/**
 * What a read-only look at a store root found: the store, no store (no
 * partition holds an identity file), or `unknown` when it could not tell
 * (an identity file is unreadable, or the partitions disagree about the
 * store id: a broken store is not indexed; the store's own open refuses it
 * by name).
 */
export type StoreProbe =
  | { readonly kind: "store"; readonly store: IndexedStore }
  | { readonly kind: "absent" }
  /** `root`: the store root probed, `null` when it could not be resolved. */
  | { readonly kind: "unknown"; readonly root: string | null };

/** Read-only probe of the store at `root`; see {@link StoreProbe}. */
export function probeStoreRoot(root: string, dirs: PlatformDirsEnv = processDirsEnv()): StoreProbe {
  const held: StorePartition[] = [];
  const ids = new Set<string>();
  for (const partition of STORE_PARTITIONS) {
    let id: string | null;
    try {
      id = readStoreId(partitionDir(root, partition));
    } catch {
      return { kind: "unknown", root };
    }
    if (id === null) continue;
    held.push(partition);
    ids.add(id);
  }
  if (held.length === 0) return { kind: "absent" };
  if (ids.size !== 1) return { kind: "unknown", root };
  const storeId = [...ids][0]!;
  return {
    kind: "store",
    store: { root, storeId, deviceStateDir: deviceStateDirFor(storeId, dirs), partitions: held },
  };
}

/** The held store at `root`, or `null` when there is none or it cannot be read. */
export function probeIndexedStore(
  root: string,
  dirs: PlatformDirsEnv = processDirsEnv(),
): IndexedStore | null {
  const probe = probeStoreRoot(root, dirs);
  return probe.kind === "store" ? probe.store : null;
}

export interface ResolveIndexedStoreOptions {
  readonly vault: string;
  /** Parsed machine config (`key: value`); empty when no file was read. */
  readonly config: Readonly<Record<string, string>>;
  /** Path of the machine config file; relative `store_root` values anchor to its directory. */
  readonly configPath?: string | null;
  readonly dirs?: PlatformDirsEnv;
}

/**
 * Which store the index of `vault` reads. A store root configured inside
 * the vault is not in use (`absent`): the store's own resolver refuses it
 * by name wherever a store is opened, and the index must not fail every
 * search over it. A root that cannot be resolved at all is `unknown`.
 */
export function resolveIndexedStoreProbe(opts: ResolveIndexedStoreOptions): StoreProbe {
  const dirs = opts.dirs ?? processDirsEnv();
  let root: string;
  try {
    root = resolveStoreRoot({
      ...dirs,
      config: opts.config,
      configPath: opts.configPath ?? defaultConfigPath(),
      vault: opts.vault,
    }).root;
  } catch (err) {
    return err instanceof StoreRootInsideVaultError
      ? { kind: "absent" }
      : { kind: "unknown", root: null };
  }
  return probeStoreRoot(root, dirs);
}

/** The store the index of `vault` reads, or `null` when none is in use or it cannot be read. */
export function resolveIndexedStore(opts: ResolveIndexedStoreOptions): IndexedStore | null {
  const probe = resolveIndexedStoreProbe(opts);
  return probe.kind === "store" ? probe.store : null;
}

/**
 * The directory name of a vault's index under a store: a short hash of the
 * vault's real path. The real path follows symlinks and, on macOS and
 * Windows, answers the on-disk spelling of each segment (drive letter
 * included), so one vault reached through a link or a different casing
 * keeps one index. A vault that does not exist yet hashes its resolved path.
 */
export function vaultIndexKey(vault: string): string {
  let real: string;
  try {
    real = realpathSync.native(vault);
  } catch {
    real = resolve(vault);
  }
  return sha256Hex(real).slice(0, STORE_INDEX_VAULT_KEY_LENGTH);
}

/** The index file of `vault` inside `store`'s device-local state. */
export function storeIndexPath(store: IndexedStore, vault: string): string {
  return join(store.deviceStateDir, STORE_INDEX_DIR, vaultIndexKey(vault), DERIVED_STORE_FILE);
}

/** The store root `deviceStateDir`'s store was last read at, or `null`. */
function rememberedRoot(deviceStateDir: string): string | null {
  try {
    return readFileSync(join(deviceStateDir, STORE_INDEX_DIR, STORE_INDEX_ROOT_FILE), "utf8");
  } catch {
    return null;
  }
}

/**
 * Note on this machine that `store` was read at its root, for
 * {@link lastStoreIndexPath}. Best effort: a failure only means a later
 * `unknown` probe uses the legacy location instead.
 */
export function rememberStoreRoot(store: IndexedStore): void {
  if (rememberedRoot(store.deviceStateDir) === store.root) return;
  try {
    const dir = join(store.deviceStateDir, STORE_INDEX_DIR);
    mkdirSync(dir, { recursive: true });
    atomicWriteFileSync(join(dir, STORE_INDEX_ROOT_FILE), store.root);
  } catch {
    // the next resolve tries again
  }
}

/**
 * The index of `vault` this machine last wrote under a store last read at
 * `root`, or `null` when it holds none: for a probe that answered
 * `unknown`. A store.json a sync tool is rewriting, or two partitions that
 * briefly disagree, tell nothing about where the index lives, and falling
 * back to the vault's legacy location would read and write a different
 * database (a stale one, or an empty one rebuilt in full) until the store
 * reads again. The store id is what names the index directory, so every
 * store directory of this machine whose store was last read at `root`
 * ({@link rememberStoreRoot}) is looked in, and the most recently written
 * index wins. A store retired or moved away from `root` is never picked.
 */
export function lastStoreIndexPath(
  vault: string,
  root: string | null,
  dirs: PlatformDirsEnv = processDirsEnv(),
): string | null {
  if (root === null) return null;
  let ids: string[];
  try {
    ids = readdirSync(storesStateDir(dirs)).filter((name) => isUlid(name));
  } catch {
    return null;
  }
  const key = vaultIndexKey(vault);
  let best: { readonly path: string; readonly mtimeMs: number } | null = null;
  for (const id of ids) {
    const stateDir = deviceStateDirFor(id, dirs);
    if (rememberedRoot(stateDir) !== root) continue;
    const path = join(stateDir, STORE_INDEX_DIR, key, DERIVED_STORE_FILE);
    let mtimeMs: number;
    try {
      const stat = statSync(path);
      if (!stat.isFile()) continue;
      mtimeMs = stat.mtimeMs;
    } catch {
      continue;
    }
    if (best === null || mtimeMs > best.mtimeMs) best = { path, mtimeMs };
  }
  return best?.path ?? null;
}
