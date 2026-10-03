/**
 * Vault-contained note path resolution (write-time-integrity-
 * governance). One guard shared by every governance surface that
 * reads or writes a caller-supplied vault-relative path (labels,
 * attributes, their CLI/MCP show branches, tier restore): lexical
 * containment first, then symlink canonicalization - a symlink
 * inside the vault pointing outside it must not pass.
 */

import { existsSync, realpathSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

export interface ResolveNotePathOptions {
  /** When true (default), a missing file is an error. */
  readonly mustExist?: boolean;
  /**
   * The vault-relative paths the caller may read. An existing note it may
   * not read is refused with the error a missing note gets, so the
   * refusal does not confirm the note exists. Absent, every note may be
   * resolved.
   */
  readonly readable?: (rel: string) => boolean;
}

/**
 * Resolve `relPath` against the vault root, refusing lexical
 * traversal and symlink escapes. Returns the canonical absolute path.
 */
export function resolveNotePath(
  vault: string,
  relPath: string,
  opts: ResolveNotePathOptions = {},
): string {
  const vaultRoot = resolve(vault);
  const path = resolve(vaultRoot, relPath);
  if (path !== vaultRoot && !path.startsWith(vaultRoot + sep)) {
    throw new Error(`note path resolves outside the vault: ${relPath}`);
  }
  if (!existsSync(path)) {
    if (opts.mustExist === false) return path;
    throw new Error(`note does not exist: ${relPath}`);
  }
  if (
    opts.readable !== undefined &&
    !opts.readable(relative(vaultRoot, path).split(sep).join("/"))
  ) {
    throw new Error(`note does not exist: ${relPath}`);
  }
  // Canonicalize both sides: a symlinked vault root is fine, a
  // symlinked NOTE that escapes the canonical root is not.
  const realRoot = realpathSync(vaultRoot);
  const realPath = realpathSync(path);
  if (realPath !== realRoot && !realPath.startsWith(realRoot + sep)) {
    throw new Error(`note path resolves outside the vault via a symlink: ${relPath}`);
  }
  return realPath;
}
