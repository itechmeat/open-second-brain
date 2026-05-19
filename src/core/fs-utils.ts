/**
 * Shared filesystem utilities used across all core modules.
 *
 * Centralises the repeated `existsSync + statSync.isFile/isDirectory` and
 * `stem` (basename without extension) patterns that were previously
 * copy-pasted across 4+ files.
 */

import { existsSync, statSync } from "node:fs";

/** True when `p` exists and is a regular file. Never throws. */
export function isFile(p: string): boolean {
  if (!existsSync(p)) return false;
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** True when `p` exists and is a directory. Never throws. */
export function isDir(p: string): boolean {
  if (!existsSync(p)) return false;
  try {
    return statSync(p).isDirectory();
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
