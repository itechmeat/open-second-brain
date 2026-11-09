/**
 * Resolve the on-disk location of the search index file.
 *
 * Default: `<vault>/.open-second-brain/brain.sqlite`. When a brain store
 * is in use (see `brain-store/location.ts`) the default is the store's
 * device-local state instead: `<device state>/index/<vault key>/brain.sqlite`.
 * Either default is overridable through CLI `--db` or config
 * `search_db_path`. With no vault the index can only live in the store's
 * device-local state, keyed by the store id (design D14 item 14).
 *
 * The two name components come from `brain/path-constants.ts`, the leaf
 * module that already owns every vault-relative name in this project.
 * They live there rather than here because the snapshot family needs to
 * name the same file, and a second copy of the literal is precisely how
 * an archiver and an indexer end up disagreeing about which file is the
 * store. This module remains the ONLY resolver: callers that need the
 * path ask it, and never re-join the parts themselves.
 */

import { join } from "node:path";

import { DERIVED_STORE_DIR, DERIVED_STORE_FILE } from "../brain/path-constants.ts";
import { defaultConfigPath, discoverConfig } from "../config.ts";
import { envOrConfig } from "../validate.ts";
import {
  lastStoreIndexPath,
  rememberStoreRoot,
  resolveIndexedStoreProbe,
  storeIndexPath,
  type IndexedStore,
  type StoreProbe,
} from "./brain-store/location.ts";

/** Environment variable that overrides the store location. */
export const SEARCH_DB_ENV = "OPEN_SECOND_BRAIN_SEARCH_DB";

/** Machine-config key that overrides the store location. */
export const SEARCH_DB_CONFIG_KEY = "search_db_path";

/**
 * No vault, no store and no override: there is nowhere an index can live
 * (design D14 item 14). The remedy names both ways out.
 */
export class NoIndexLocationError extends Error {
  constructor() {
    super(
      "the search index has no location: no vault is configured and no brain store is in use; " +
        "run `o2b store init` to create the store, or configure a vault",
    );
    this.name = "NoIndexLocationError";
  }
}

export function resolveIndexPath(
  vault: string | null,
  override: string | null,
  store: IndexedStore | null = null,
): string {
  if (override !== null) {
    const trimmed = override.trim();
    if (trimmed !== "") return trimmed;
  }
  if (store !== null) return storeIndexPath(store, vault);
  if (vault === null) throw new NoIndexLocationError();
  return join(vault, DERIVED_STORE_DIR, DERIVED_STORE_FILE);
}

/**
 * {@link resolveIndexPath} for a store probe. A probe that could not tell
 * whether a store is in use keeps the store index this machine last wrote
 * for the vault under a store last read at the same root
 * (`lastStoreIndexPath`; a `store` probe records that root), so a passing failure to read
 * store.json neither reads a stale legacy index nor rebuilds an empty one;
 * the legacy location is used only when no such index exists. An explicit
 * override wins as always.
 */
export function resolveIndexPathForProbe(
  vault: string | null,
  override: string | null,
  probe: StoreProbe,
): string {
  const overridden = override !== null && override.trim() !== "";
  if (probe.kind === "store") rememberStoreRoot(probe.store);
  if (probe.kind === "unknown" && !overridden) {
    const last = lastStoreIndexPath(vault, probe.root);
    if (last !== null) return last;
  }
  return resolveIndexPath(vault, override, probe.kind === "store" ? probe.store : null);
}

/**
 * The store location a caller holding no resolved search config should
 * use: the default, unless the environment or the machine config moves it.
 *
 * It exists because {@link resolveIndexPath} answers only the default when
 * handed `null`, and a caller that does not know about the override reads
 * that as the truth. The snapshot family did: on a vault carrying a
 * `search_db_path` override it would have archived, or refused to find, a
 * file the search layer never reads - and if a stale database happened to
 * sit at the default location it would have archived that and reported
 * success. The pack stamp shipped the same bug against the same key.
 *
 * The config read is the discovering form, so a vault that was never
 * registered resolves to the default rather than throwing. An
 * unconfigured store is a real state, and refusing it by name belongs to
 * the caller that tries to use it, not here.
 */
export function resolveConfiguredIndexPath(vault: string | null, configPath?: string): string {
  const path = configPath ?? defaultConfigPath();
  const config = discoverConfig(path).data;
  return resolveIndexPathForProbe(
    vault,
    envOrConfig(process.env, config, SEARCH_DB_ENV, SEARCH_DB_CONFIG_KEY),
    resolveIndexedStoreProbe({ vault, config, configPath: path }),
  );
}
