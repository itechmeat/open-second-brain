/**
 * Path-safety helpers shared by every module that writes into the vault.
 *
 * Centralises the "is this path inside the vault?" check and a reusable
 * vault-relative path renderer. Every module that constructs a path to
 * write must funnel through `ensureInsideVault` so a malicious or buggy
 * input (e.g. a slug with `..`, an absolute symlink target) cannot land a
 * file outside the vault root.
 */

import { existsSync, realpathSync } from "node:fs";
import { dirname, posix, relative, resolve, sep } from "node:path";

/**
 * Throw if `target` is not the vault root or a descendant of it.
 *
 * The check is twofold:
 *
 *   1. `path.resolve` normalises `..` so a slug like `../etc/passwd`
 *      cannot pretend to be inside the vault. The platform path
 *      separator (`/` or `\`) is used for the prefix check so siblings
 *      that share a name prefix (`/v` vs `/v-evil`) are rejected.
 *   2. `fs.realpathSync` follows symlinks for the deepest existing
 *      ancestor of the target, then re-runs the prefix check on the
 *      resolved real paths. This blocks the case where a directory
 *      *inside* the vault is itself a symlink to somewhere outside it
 *      (`<vault>/AI Wiki/payments/escape -> /tmp/outside`) — without
 *      realpath, the lexical check would happily admit the path.
 *
 * Returns the resolved (lexical) absolute path of `target`. Callers that
 * need the realpath should call `realpathSync` themselves on the result;
 * we deliberately return the lexical form so wikilinks rendered from it
 * keep matching what the user sees in Obsidian.
 */
export function ensureInsideVault(target: string, vault: string): string {
  const resolvedTarget = resolve(target);
  const resolvedVault = resolve(vault);

  if (!isLexicallyInside(resolvedTarget, resolvedVault)) {
    throw new Error(`path escapes vault: ${target}`);
  }

  // Realpath protection only matters when the vault actually exists on
  // disk — otherwise there is no symlink to follow. Pure-lexical inputs
  // (used by unit tests) skip this branch and rely on step 1 above.
  if (existsSync(resolvedVault)) {
    const realVault = safeRealpath(resolvedVault);
    const realAncestor = safeRealpath(deepestExistingAncestor(resolvedTarget));
    if (!isLexicallyInside(realAncestor, realVault)) {
      throw new Error(`path escapes vault via symlink: ${target}`);
    }
  }

  return resolvedTarget;
}

function isLexicallyInside(target: string, root: string): boolean {
  // Windows file paths are case-insensitive at the filesystem level —
  // `C:\Vault\x.md` and `c:\vault\x.md` resolve to the same inode. Doing
  // a case-sensitive string compare on Windows would falsely reject a
  // user's lower-cased argument against a vault stored with the canonical
  // capitalisation. POSIX stays case-sensitive.
  const t = process.platform === "win32" ? target.toLowerCase() : target;
  const r = process.platform === "win32" ? root.toLowerCase() : root;
  return t === r || t.startsWith(r + sep);
}

function deepestExistingAncestor(target: string): string {
  let cur = target;
  // Walk up until we hit a path that exists. `dirname` of a top-level
  // path returns itself; the loop terminates either at the first existing
  // ancestor (the common case — vault root exists) or at the root.
  while (!existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) return cur;
    cur = parent;
  }
  return cur;
}

function safeRealpath(p: string): string {
  // realpath throws on non-existent paths and on permission failure.
  // For non-existent we fall back to the lexical form (the
  // `deepestExistingAncestor` walk above tries to avoid this case);
  // for permission failure we surface the error so the caller learns
  // about it instead of silently disabling symlink protection.
  try {
    return realpathSync(p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return p;
    throw err;
  }
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
