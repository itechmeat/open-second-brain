/**
 * Sizes of files and folders as the removal of the legacy tree and the
 * doctor name them: what a removal deleted as rebuildable, what a vault
 * still holds of this machine's legacy folder. Node builtins only.
 */
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Bytes of the files below `path` (or of `path` itself); what cannot be read counts 0. */
export function treeBytes(path: string): number {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return 0;
  }
  if (!stat.isDirectory()) return stat.isFile() ? stat.size : 0;
  let names: string[];
  try {
    names = readdirSync(path);
  } catch {
    return 0;
  }
  return names.reduce((sum, name) => sum + treeBytes(join(path, name)), 0);
}

/** A size in bytes as a person reads it: "791 MB", "12.5 KB", "300 B" (powers of 1000). */
export function describeBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unit]}`;
}
