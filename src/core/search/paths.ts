/**
 * Resolve the on-disk location of the search index file.
 *
 * Default: `<vault>/.open-second-brain/brain.sqlite`. Overridable
 * through CLI `--db` or config `search_db_path`.
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

/** Environment variable that overrides the store location. */
export const SEARCH_DB_ENV = "OPEN_SECOND_BRAIN_SEARCH_DB";

/** Machine-config key that overrides the store location. */
export const SEARCH_DB_CONFIG_KEY = "search_db_path";

export function resolveIndexPath(vault: string, override: string | null): string {
  if (override !== null) {
    const trimmed = override.trim();
    if (trimmed !== "") return trimmed;
  }
  return join(vault, DERIVED_STORE_DIR, DERIVED_STORE_FILE);
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
export function resolveConfiguredIndexPath(vault: string, configPath?: string): string {
  const path = configPath ?? defaultConfigPath();
  const config = discoverConfig(path).data;
  return resolveIndexPath(
    vault,
    envOrConfig(process.env, config, SEARCH_DB_ENV, SEARCH_DB_CONFIG_KEY),
  );
}
