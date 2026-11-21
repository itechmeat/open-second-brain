/**
 * Where a switched machine still keeps a legacy file: the archive its
 * legacy-tree removal moved the tree into, inside this machine's
 * device-local state (`removal.ts`). A plain directory, so one file is one
 * read. Readers use it to recover what a release before an import did not
 * carry into the store (the vault map, the bytes of a rule file); it is
 * absent on a machine that never removed the tree here, and once the
 * operator deletes the archive.
 */

import { join } from "node:path";

import { processDirsEnv } from "../platform-dirs.ts";
import { configuredStore } from "../store/read/store-entities.ts";
import { deviceStateDirFor } from "../store/store-paths.ts";
import { readRemovalMarker } from "./removal-marker.ts";

/**
 * The path in this machine's legacy archive of `vault` of the file at
 * vault-relative `rel` (`/` or native separators), or `null` when this
 * machine holds no archive of the vault. The file itself may be absent.
 */
export function legacyArchivePath(vault: string, rel: string, configPath?: string): string | null {
  const store = configuredStore(configPath);
  if (store === null) return null;
  const marker = readRemovalMarker(
    { deviceStateDir: deviceStateDirFor(store.storeId, processDirsEnv()) },
    vault,
  );
  return marker === null ? null : join(marker.archive, ...rel.split(/[\\/]/));
}
