/**
 * The only page paths the view writer ever touches on disk (review
 * finding: a forged `view-render` record). A page path comes from store
 * records any device that syncs `shared` can write, so it is checked
 * twice before any file operation:
 *
 *  1. against the exact shape the renderer produces for its folders
 *     (`topics/<YYYY-MM-DD>-<slug>/topic.md` and `archive.md`,
 *     `reports/<entry>.md`, `sources/<entry>.md`): forward slashes only,
 *     no `..`, no backslash, no empty segment, no drive or root;
 *  2. by resolving it under the view folder and requiring the result to
 *     stay strictly inside that folder, on the host's own path rules, as
 *     text and on disk (no symbolic link below the view folder, and the
 *     real path of the page's folder inside the real view folder).
 *
 * A path that fails either check is never read, captured, ingested,
 * moved or removed.
 */

import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { VIEW_REPORTS_DIR, VIEW_SOURCES_DIR, VIEW_TOPICS_DIR } from "./constants.ts";

/** A topic folder: the creation day and a slug of letters and digits of any script, hyphen-joined. */
const TOPIC_FOLDER_RE = /^\d{4}-\d{2}-\d{2}-[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$/u;
const TOPIC_PAGE_RE = /^(?:topic|archive)\.md$/;
/** A report or source entry file: the lane entry id the renderer accepts, then `.md`. */
const ENTRY_PAGE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*\.md$/;
/** Names Windows reserves for devices, refused with any extension. */
export const RESERVED_DEVICE_NAME_RE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

/** Whether `page` has the exact shape of a page the renderer writes in a retiring folder. */
export function isRetiringPageShape(page: string): boolean {
  if (page.includes("\\") || page.includes("\u0000")) return false;
  const parts = page.split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) return false;
  if (parts[0] === VIEW_TOPICS_DIR) {
    return parts.length === 3 && TOPIC_FOLDER_RE.test(parts[1]!) && TOPIC_PAGE_RE.test(parts[2]!);
  }
  if (parts[0] === VIEW_REPORTS_DIR || parts[0] === VIEW_SOURCES_DIR) {
    return (
      parts.length === 2 &&
      parts[1]!.length <= 140 &&
      ENTRY_PAGE_RE.test(parts[1]!) &&
      !RESERVED_DEVICE_NAME_RE.test(parts[1]!)
    );
  }
  return false;
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** Whether `path` exists and is a symbolic link (or, on Windows, a junction). */
function isLink(path: string): boolean | null {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return null; // absent: nothing below it exists either
  }
}

/**
 * The file of view page `page` under the view folder `target`, or `null`
 * when it would resolve to the folder itself or outside it, as text or on
 * disk: no folder below the view folder, nor the page itself, may be a
 * symbolic link, and the real path of the page's folder must stay inside
 * the real path of the view folder. The view folder itself may be a link.
 */
export function pageFileInside(target: string, page: string): string | null {
  const root = resolve(target);
  const file = resolve(root, ...page.split("/"));
  if (!inside(root, file)) return null;
  let at = root;
  for (const part of relative(root, file).split(sep)) {
    at = join(at, part);
    const link = isLink(at);
    if (link === null) break;
    if (link) return null;
  }
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    return file; // no view folder yet: nothing below it can be a link
  }
  let folder = dirname(file);
  while (folder !== root && isLink(folder) === null) folder = dirname(folder);
  if (folder === root) return file;
  try {
    return inside(realRoot, realpathSync(folder)) ? file : null;
  } catch {
    return null;
  }
}

/** The file of a page in a retiring folder, when both checks pass; `null` otherwise. */
export function retiringPageFile(target: string, page: string): string | null {
  return isRetiringPageShape(page) ? pageFileInside(target, page) : null;
}
