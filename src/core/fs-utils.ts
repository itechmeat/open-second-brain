/**
 * Shared filesystem utilities used across all core modules.
 *
 * Centralises the repeated `existsSync + statSync.isFile/isDirectory` and
 * `stem` (basename without extension) patterns that were previously
 * copy-pasted across 4+ files.
 */

import { statSync, type Stats } from "node:fs";

/**
 * Stat `p`, keeping a genuine absence apart from a failure to look.
 *
 * `undefined` means ENOENT on this path: nothing is there. Every OTHER
 * errno - an unreadable parent directory, a symlink loop, a name too long
 * - is a failure to ANSWER the question, and propagates. This is the split
 * `discoverConfig` makes for the plugin config, for the same reason:
 * answering "not there" for a path that is there but unreachable sends the
 * operator a remedy that tells them to create what already exists, and
 * hides the permission problem that is the real fault.
 *
 * `throwIfNoEntry: false` is what makes the split free rather than a cost:
 * it suppresses ENOENT alone and raises every other errno, so the common
 * absent case pays one syscall and constructs no error.
 */
export function statOrAbsent(p: string): Stats | undefined {
  return statSync(p, { throwIfNoEntry: false });
}

/**
 * True when `p` exists and is a regular file. False when it is absent,
 * when it is something other than a regular file, AND when it cannot be
 * stat'ed at all.
 *
 * That third case is a deliberate leniency, which is why this stays a
 * separate verb from {@link statOrAbsent} rather than wrapping it
 * silently: callers asking only "is this a candidate worth opening" act
 * identically on "absent" and "unreachable", and a probe that raises would
 * make them all grow a catch. Any caller whose OUTPUT distinguishes the
 * two - a diagnostic that prints "missing" and a remedy - must use
 * {@link statOrAbsent} and report the reason.
 */
export function isFile(p: string): boolean {
  try {
    return statOrAbsent(p)?.isFile() ?? false;
  } catch {
    return false;
  }
}

/**
 * True when `p` exists and is a directory; false when absent, when it is
 * not a directory, and when it cannot be stat'ed. See {@link isFile} for
 * when that leniency is the wrong verb.
 */
export function isDir(p: string): boolean {
  try {
    return statOrAbsent(p)?.isDirectory() ?? false;
  } catch {
    return false;
  }
}

/**
 * Extract the filename without its extension.
 * `stem("notes.md")` → `"notes"`, `stem(".gitignore")` → `".gitignore"`.
 */
export function stem(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? filename.slice(0, dot) : filename;
}
