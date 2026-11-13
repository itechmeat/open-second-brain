/**
 * Where the compiled digests live (design D14 item 7, task 2.10).
 *
 * `active.md` and `lessons.md` are derived from the preference fold, the
 * operational log and the dead-ends. On an unswitched machine they stay
 * the vault files `Brain/active.md` and `Brain/lessons.md`, written by
 * `dream` and the verbs that change preference state. On a store-only
 * machine they are rendered on demand for the hooks and the MCP
 * resources and kept as a cache in the device-local state, never in the
 * vault: `<state>/open-second-brain/stores/<store id>/digests/<vault
 * key>/<file>`, where the vault key is a digest of the vault path (one
 * cache per vault a machine reads with this store). A store-only machine
 * with no readable store keeps the cache beside the stores, under
 * `digests/` of the stores directory.
 *
 * The cache holds exactly the bytes a write of the digest would store,
 * frontmatter and `generated_at` included, and is rewritten only when the
 * rendered body changes, as the vault file is: a reader that serves the
 * cache's bytes serves the same generation until something changes.
 *
 * A leaf: the renderers (`active.ts`, `lessons.ts`) import it, and it
 * imports neither.
 */

import { createHash } from "node:crypto";
import { accessSync, constants, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { configuredStore } from "../store/read/store-entities.ts";
import { storeOnlyMode } from "../store/store-only.ts";
import { deviceStateDirFor, storesStateDir } from "../store/store-paths.ts";
import { BRAIN_ACTIVE_FILE, BRAIN_LESSONS_FILE } from "./path-constants.ts";
import { brainActivePath, brainLessonsPath } from "./paths.ts";
import { noVaultRoot } from "../platform-dirs.ts";

/** A compiled digest. */
export type CompiledDigest = "active" | "lessons";

const DIGESTS_DIR = "digests";

/**
 * The folder of every digest cache of the store `storeId`.
 */
export function digestCacheRoot(storeId: string): string {
  return join(deviceStateDirFor(storeId), DIGESTS_DIR);
}
const VAULT_KEY_CHARS = 16;
/** The cache directory of the digests of a machine with no vault. */
const NO_VAULT_DIGEST_KEY = "no-vault";

/** Whether the digests of `vault` are rendered on demand into the device-local cache. */
export function digestsRenderedOnDemand(vault: string | null, configPath?: string): boolean {
  // No vault (or its stand-in path): store-only, and the digests have no
  // vault file (D14 item 7).
  if (vault === null || isNoVaultPath(vault)) return true;
  // A machine that holds its own switch record renders on demand whatever
  // state the vault folder is in (unmounted, briefly unreadable), as the
  // rest of its machine state does (`machineStateLocation`).
  const mode = storeOnlyMode({ vault, ...(configPath !== undefined ? { configPath } : {}) });
  if (mode.reason === "device-switched") return true;
  // Otherwise a vault path that names no directory, or one this process
  // cannot list, is a configuration fault, not a store-only machine:
  // whether it holds a legacy tree is unknowable, and its readers find
  // nothing, as before.
  if (!listable(vault)) return false;
  return mode.storeOnly;
}

/**
 * The rest of the no-vault test `machineStateLocation` makes, past null: a
 * blank path or the stand-in path. A plain boolean: a caller narrows with
 * its own `vault === null ||` (the path is a string either way).
 */
function isNoVaultPath(vault: string): boolean {
  return vault.trim() === "" || vault === noVaultRoot();
}

function listable(dir: string): boolean {
  try {
    accessSync(dir, constants.R_OK | constants.X_OK);
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** The device-local cache file of one digest of `vault`. */
export function digestCachePath(
  vault: string | null,
  digest: CompiledDigest,
  configPath?: string,
): string {
  const store = configuredStore(configPath);
  const base = store === null ? storesStateDir() : deviceStateDirFor(store.storeId);
  // Keyed by the vault, or with no vault by a fixed name (a vault key is
  // 16 hex characters, so the two never meet).
  // The stand-in path the hooks pass is no vault too: one cache per machine.
  const key =
    vault === null || isNoVaultPath(vault)
      ? NO_VAULT_DIGEST_KEY
      : createHash("sha256").update(resolve(vault)).digest("hex").slice(0, VAULT_KEY_CHARS);
  return join(base, DIGESTS_DIR, key, digest === "active" ? BRAIN_ACTIVE_FILE : BRAIN_LESSONS_FILE);
}

/**
 * The file one digest of `vault` lives in: the vault file on an
 * unswitched machine, the device-local cache on a store-only one.
 */
export function compiledDigestPath(
  vault: string | null,
  digest: CompiledDigest,
  configPath?: string,
): string {
  if (vault === null || digestsRenderedOnDemand(vault, configPath)) {
    return digestCachePath(vault, digest, configPath);
  }
  return digest === "active" ? brainActivePath(vault) : brainLessonsPath(vault);
}
