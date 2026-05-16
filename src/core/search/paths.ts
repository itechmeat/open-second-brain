/**
 * Resolve the on-disk location of the search index file.
 *
 * Default: `<vault>/.open-second-brain/brain.sqlite`. Overridable
 * through CLI `--db` or config `search_db_path`.
 */

import { join } from "node:path";

export function resolveIndexPath(vault: string, override: string | null): string {
  if (override !== null) {
    const trimmed = override.trim();
    if (trimmed !== "") return trimmed;
  }
  return join(vault, ".open-second-brain", "brain.sqlite");
}
