/**
 * The device-local marker a removal of the legacy tree leaves (task 2.5),
 * in a leaf module so the doctor reads it without the migration's
 * catalogue in its import graph.
 */

import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { pathIsInsideOn } from "../path-safety.ts";
import type { StoreHandle } from "../store/store-open.ts";
import { migrationDir } from "./journal.ts";

/** The device-local marker of a removal, read by the doctor. */
export const LEGACY_REMOVED_MARKER = "legacy-removed.json";

export interface LegacyRemovalMarker {
  readonly vault: string;
  readonly at: string;
  readonly archive: string;
  readonly forced: boolean;
  readonly stopped: ReadonlyArray<string>;
}

/** The real path of `path` (links and junctions resolved), or `path` when it cannot be resolved. */
function realOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * Whether two vault paths name the same folder, by the platform's own
 * rules: case-insensitive on Windows (`C:\\Vault` and `c:\\vault`), exact
 * elsewhere, and on the host with links and junctions resolved, as the
 * migration gate compares them. `platform` is the host's unless a test
 * names one.
 */
export function sameVaultPath(
  a: string,
  b: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const rules = platform === "win32" ? "win32" : "posix";
  const host = platform === process.platform;
  const left = host ? realOrSelf(a) : a;
  const right = host ? realOrSelf(b) : b;
  return pathIsInsideOn(rules, left, right) && pathIsInsideOn(rules, right, left);
}

/** This machine's removal marker for `vault`, or null. */
export function readRemovalMarker(
  store: Pick<StoreHandle, "deviceStateDir">,
  vault: string,
): LegacyRemovalMarker | null {
  try {
    const marker = JSON.parse(
      readFileSync(join(migrationDir(store), LEGACY_REMOVED_MARKER), "utf8"),
    ) as LegacyRemovalMarker;
    return typeof marker.vault === "string" && sameVaultPath(marker.vault, vault) ? marker : null;
  } catch {
    return null;
  }
}

export function writeRemovalMarker(
  store: Pick<StoreHandle, "deviceStateDir">,
  marker: LegacyRemovalMarker,
): void {
  mkdirSync(migrationDir(store), { recursive: true });
  writeFileSync(
    join(migrationDir(store), LEGACY_REMOVED_MARKER),
    `${JSON.stringify(marker, null, 2)}\n`,
  );
}
