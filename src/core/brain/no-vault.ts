/**
 * The no-vault rule of the memory writers and readers (design D14, task
 * 2.10): a machine with no vault configured is store-only, so a branch
 * that reads or writes the legacy `Brain/` tree only runs when a vault
 * exists. Those branches name their vault through {@link legacyVaultOf},
 * which turns a broken invariant into a named error instead of a write to
 * a path relative to the working directory.
 */

import { isAbsolute, win32 } from "node:path";

import { vaultRelative } from "../path-safety.ts";
import { noVaultRoot } from "../platform-dirs.ts";

/** Raised when a legacy-tree branch is reached with no vault. */
export class LegacyTreeWithoutVaultError extends Error {
  constructor(site: string) {
    super(
      `${site}: the legacy Brain/ tree was asked for with no vault configured; ` +
        "with no vault every memory read and write goes to the brain store",
    );
    this.name = "LegacyTreeWithoutVaultError";
  }
}

/** `vault` for a legacy-tree branch; with no vault, a {@link LegacyTreeWithoutVaultError}. */
export function legacyVaultOf(vault: string | null, site: string): string {
  // No vault has three spellings: `null`, a blank string (every join under
  // it is relative to the working directory) and the stand-in root the
  // lane modules are handed (`laneVaultRoot(null)`). None names a tree.
  if (vault === null || vault.trim() === "" || vault === noVaultRoot()) {
    throw new LegacyTreeWithoutVaultError(site);
  }
  return vault;
}

/**
 * `path` relative to `vault`, as the memory readers report it. With no
 * vault the store's rebuilt pages already carry vault-relative paths
 * (`memory-pages.ts`), so the path is returned as it is.
 */
export function vaultRelativeOf(path: string, vault: string | null): string {
  if (vault !== null) return vaultRelative(path, vault);
  // Fail closed: an absolute device path must never pass as a page path.
  if (isAbsolute(path) || win32.isAbsolute(path)) {
    throw new LegacyTreeWithoutVaultError(`vaultRelativeOf(an absolute path)`);
  }
  return path.replaceAll("\\", "/");
}
