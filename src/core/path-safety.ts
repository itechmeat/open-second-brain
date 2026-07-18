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
 *      (`<vault>/Brain/payments/escape -> /tmp/outside`) — without
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
  if (existsSync(resolvedVault) && !realpathInsideVault(resolvedTarget, resolvedVault)) {
    throw new Error(`path escapes vault via symlink: ${target}`);
  }

  return resolvedTarget;
}

/**
 * Step 2 of {@link ensureInsideVault} as a non-throwing predicate: does
 * `target`'s realpath (following symlinks for its deepest existing
 * ancestor) resolve inside `vault`? Returns true when the vault does not
 * exist on disk (no symlink to follow). Shared with the doctor's
 * `symlink-escape` lint so the two-step check lives in exactly one place.
 */
export function realpathInsideVault(target: string, vault: string): boolean {
  const resolvedVault = resolve(vault);
  if (!existsSync(resolvedVault)) return true;
  const realVault = safeRealpath(resolvedVault);
  const realAncestor = safeRealpath(deepestExistingAncestor(resolve(target)));
  return isLexicallyInside(realAncestor, realVault);
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
 * Convert an OS-native path to POSIX form (forward slashes).
 *
 * Returns the input unchanged on POSIX hosts (`sep === "/"`); on
 * Windows, replaces every `\\` separator with `/`. Used by the
 * vault walkers when they project absolute or vault-relative OS
 * paths into the POSIX form that `matchIgnore` and Obsidian
 * wikilinks both expect.
 */
export function toPosix(p: string): string {
  return sep === "/" ? p : p.split(sep).join("/");
}

/**
 * Canonical vault-relative note identity: forward-slash POSIX form plus
 * Unicode NFC.
 *
 * The same note has byte-different vault-relative paths across devices:
 * macOS (APFS/HFS+) stores filenames decomposed (NFD), while Linux and
 * Android store them precomposed (NFC). On a Syncthing peer set that
 * splits one note into two identities, defeating incremental-index
 * change detection (constant re-index churn) and surfacing phantom
 * cross-device duplicates. Funnelling every path that keys a note's
 * identity (the index change-detection key, provenance stamping)
 * through this helper collapses both forms to one NFC identity.
 *
 * Idempotent: an already-POSIX, already-NFC path - the Linux common
 * case - returns byte-identical, so the normalisation is invisible on
 * the dominant platform and only the macOS NFD path actually converges.
 */
export function canonicalNotePath(p: string): string {
  return toPosix(p).normalize("NFC");
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
