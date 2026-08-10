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

export function resolveIndexPath(vault: string, override: string | null): string {
  if (override !== null) {
    const trimmed = override.trim();
    if (trimmed !== "") return trimmed;
  }
  return join(vault, DERIVED_STORE_DIR, DERIVED_STORE_FILE);
}
