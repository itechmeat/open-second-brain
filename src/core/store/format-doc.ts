/**
 * The store's public format document (`FORMAT.md`, task 1.1), shipped
 * beside this module and written into the store root and every partition.
 *
 * The document's first line carries its format version as an HTML
 * comment (`<!-- open-second-brain-store-format: N -->`). A copy on disk
 * is replaced only by a document of a strictly newer version (or when it
 * declares none), so an older release running on one machine never
 * downgrades the description that travels with the data, and two releases
 * that ship the same version with different prose never rewrite each
 * other's copy on every open (sync churn, conflict copies).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { atomicWriteText } from "../fs-atomic.ts";
import { STORE_FORMAT_FILE } from "./constants.ts";

const VERSION_MARKER_RE = /^<!-- open-second-brain-store-format: (\d+) -->/;

/** File mode of the format document: readable by every tool that opens the store. */
const FORMAT_DOC_MODE = 0o644;

let shipped: string | undefined;

/** The format document this release ships. */
export function shippedFormatDoc(): string {
  shipped ??= readFileSync(
    join(fileURLToPath(new URL(".", import.meta.url)), STORE_FORMAT_FILE),
    "utf8",
  );
  return shipped;
}

/** The format version a document declares on its first line, or `null` when it declares none. */
export function formatDocVersion(text: string): number | null {
  const match = VERSION_MARKER_RE.exec(text);
  return match === null ? null : Number(match[1]);
}

/**
 * Write the shipped format document into `dir` unless a copy of the same
 * or a newer format version is already there. Returns whether it wrote.
 */
export function writeFormatDoc(dir: string): boolean {
  const text = shippedFormatDoc();
  const target = join(dir, STORE_FORMAT_FILE);
  let existing: string | null = null;
  try {
    existing = readFileSync(target, "utf8");
  } catch {
    existing = null;
  }
  if (existing === text) return false;
  if (existing !== null) {
    const onDisk = formatDocVersion(existing);
    const ours = formatDocVersion(text);
    if (onDisk !== null && ours !== null && onDisk >= ours) return false;
  }
  return atomicWriteText(target, text, { mode: FORMAT_DOC_MODE });
}
