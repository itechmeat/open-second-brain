/**
 * A read-only description of where the brain store lives on this machine
 * (design D12, task 2.11): the store root, each partition, the
 * device-local state directory and the human view's target folder, with
 * the setting that put each there and whether each exists. `o2b store path` prints it and `second_brain_status`
 * carries it, so no skill or agent has to know a path by heart.
 *
 * Nothing here creates, refreshes or repairs anything. A store that does
 * not exist yet is described with the paths it would use; a store that
 * cannot be read (a root inside the vault, a corrupt identity file,
 * partitions of two stores) is described as far as possible and carries
 * the reason in {@link StoreLocationReport.error}.
 */

import { statSync } from "node:fs";
import { homedir } from "node:os";

import { defaultConfigPath, discoverConfig, resolveVault } from "../config.ts";

import { resolveViewTargetFrom, ViewTargetError } from "../view/target.ts";
import { STORE_PARTITIONS, type StorePartition } from "./constants.ts";
import { heldPartitions, readStoreId } from "./store-open.ts";
import {
  deviceStateDirFor,
  partitionDir,
  resolveStoreRoot,
  storesStateDir,
  StoreRootInsideVaultError,
  type StoreRootOrigin,
  type StoreRootSource,
} from "./store-paths.ts";

/** The environment variable that moves every state directory, the store's included. */
const STATE_HOME_ENV = "XDG_STATE_HOME";

export interface StorePartitionLocation {
  readonly name: StorePartition;
  readonly path: string;
  /** The partition carries the store identity file, so this machine holds it. */
  readonly held: boolean;
  readonly exists: boolean;
}

export interface DeviceStateLocation {
  /**
   * `store`: the directory of this store. `all-stores`: no store id is
   * known yet, so the directory that will hold the store's own is named.
   */
  readonly scope: "store" | "all-stores";
  readonly path: string;
  /** The state directory is moved only by the environment, never by the machine config. */
  readonly origin: Exclude<StoreRootOrigin, "config">;
  readonly exists: boolean;
}

export interface ViewTargetLocation {
  /** The folder the human view is rendered into, or `null` when none is configured. */
  readonly path: string | null;
  /** `none`: neither the environment nor the machine config names a folder. */
  readonly origin: "env" | "config" | "none";
  readonly exists: boolean;
  /** Why the view writer cannot use the folder (it lies inside the store), or `null`. */
  readonly error: string | null;
}

export interface StoreLocationReport {
  readonly root: {
    readonly path: string;
    readonly origin: StoreRootOrigin;
    readonly exists: boolean;
  };
  /** At least one partition holds a valid identity and all agree on it. */
  readonly initialized: boolean;
  readonly storeId: string | null;
  readonly partitions: ReadonlyArray<StorePartitionLocation>;
  readonly deviceStateDir: DeviceStateLocation;
  readonly viewTarget: ViewTargetLocation;
  /** Why the store cannot be used as it is, or `null`. */
  readonly error: string | null;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Whether a single partition holds a readable identity; a corrupt one does not count. */
function holdsIdentity(dir: string): boolean {
  try {
    return readStoreId(dir) !== null;
  } catch {
    return false;
  }
}

function describeViewTarget(source: StoreRootSource, storeRoot: string): ViewTargetLocation {
  try {
    const target = resolveViewTargetFrom(source, storeRoot, source.vault);
    if (target === null) return { path: null, origin: "none", exists: false, error: null };
    return {
      path: target.dir,
      origin: target.origin,
      exists: isDirectory(target.dir),
      error: null,
    };
  } catch (err) {
    if (!(err instanceof ViewTargetError)) throw err;
    return { ...err.target, exists: isDirectory(err.target.path), error: err.message };
  }
}

/** Describe the store `source` resolves to. Never throws for a store problem; see the module header. */
export function describeStoreLocation(source: StoreRootSource): StoreLocationReport {
  let root: { path: string; origin: StoreRootOrigin };
  let error: string | null = null;
  try {
    const resolved = resolveStoreRoot(source);
    root = { path: resolved.root, origin: resolved.origin };
  } catch (err) {
    if (!(err instanceof StoreRootInsideVaultError)) throw err;
    root = { path: err.root, origin: err.origin };
    error = err.message;
  }

  let storeId: string | null = null;
  if (error === null) {
    try {
      storeId = heldPartitions(root.path).storeId;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }

  const partitions = STORE_PARTITIONS.map((name): StorePartitionLocation => {
    const path = partitionDir(root.path, name);
    return { name, path, held: error === null && holdsIdentity(path), exists: isDirectory(path) };
  });

  // The test `stateBaseDir` uses to pick the path: set and non-empty.
  const stateHome = source.env[STATE_HOME_ENV];
  const stateOrigin = stateHome !== undefined && stateHome.length > 0 ? "env" : "default";
  const statePath = storeId === null ? storesStateDir(source) : deviceStateDirFor(storeId, source);
  return {
    root: { ...root, exists: isDirectory(root.path) },
    initialized: storeId !== null,
    storeId,
    partitions,
    deviceStateDir: {
      scope: storeId === null ? "all-stores" : "store",
      path: statePath,
      origin: stateOrigin,
      exists: isDirectory(statePath),
    },
    viewTarget: describeViewTarget(source, root.path),
    error,
  };
}

/**
 * {@link describeStoreLocation} for this process: the environment, the
 * machine config at `configPath` (default: the resolved config path) and
 * the configured vault, the same inputs `resolveConfiguredStoreRoot` reads.
 */
export function describeConfiguredStoreLocation(
  configPath?: string,
  vault?: string | null,
): StoreLocationReport {
  const path = configPath ?? defaultConfigPath();
  return describeStoreLocation({
    platform: process.platform,
    home: homedir(),
    env: process.env,
    config: discoverConfig(path).data,
    configPath: path,
    // The vault the caller looks at (`null`: none), else the configured one.
    vault: vault !== undefined ? vault : resolveVault(path),
  });
}
