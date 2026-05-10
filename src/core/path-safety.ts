/**
 * Path-safety helpers shared by every module that writes into the vault.
 *
 * Centralises the "is this path inside the vault?" check and a reusable
 * vault-relative path renderer. Every module that constructs a path to
 * write must funnel through `ensureInsideVault` so a malicious or buggy
 * input (e.g. a slug with `..`, an absolute symlink target) cannot land a
 * file outside the vault root.
 */

import { posix, relative, resolve, sep } from "node:path";

/**
 * Throw if `target` (after `path.resolve`) is not the vault root or a
 * descendant of it. The platform path separator is used for the prefix
 * check so the same code works on POSIX and Windows.
 *
 * Returns the resolved absolute path of `target` for callers that want
 * to use it directly (avoids a second `resolve` round-trip).
 */
export function ensureInsideVault(target: string, vault: string): string {
  const resolvedTarget = resolve(target);
  const resolvedVault = resolve(vault);
  if (
    resolvedTarget !== resolvedVault &&
    !resolvedTarget.startsWith(resolvedVault + sep)
  ) {
    throw new Error(`path escapes vault: ${target}`);
  }
  return resolvedTarget;
}

/**
 * Vault-relative path with forward slashes.
 *
 * Markdown rendering and Obsidian wikilinks both want forward slashes
 * regardless of host OS, so we collapse Windows-style backslashes to
 * `/`. Returns the input unchanged if it is not inside the vault — that
 * guards `ensureInsideVault` callers that want to display the rejected
 * path back to the user without crashing.
 */
export function vaultRelative(target: string, vault: string): string {
  const rel = relative(resolve(vault), resolve(target));
  return rel
    .split(/[\\/]/)
    .filter((p) => p.length > 0)
    .join(posix.sep);
}
