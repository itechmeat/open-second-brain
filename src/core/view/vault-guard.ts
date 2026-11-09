/**
 * The human view folder, seen from the note-write tools (spec
 * `human-view`): when the operator places the view folder inside the
 * vault, the note tools must leave it alone, the same way they leave
 * `Brain/` alone.
 *
 * A change to a view page that the view writer did not render is read
 * back as a human edit (`corrections.ts`): a reworded rule line on
 * `about-me.md` becomes a human-authority `preference-set`, a deleted one
 * retires the rule. A caller with agent authority writing through
 * `create_note`, `update_note`, the write batch or the folder lifecycle
 * would otherwise forge such an edit. So those tools refuse a path in the
 * view folder.
 *
 * When the view folder is the vault root itself, only the names the view
 * writer owns are refused: its pages, their sync-conflict copies, its
 * temp files and the history folder.
 */

import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";

import { toPosix } from "../path-safety.ts";
import {
  VIEW_ABOUT_ME_PAGE,
  VIEW_DECISIONS_PAGE,
  VIEW_HISTORY_DIR,
  VIEW_PAGE_EXT,
  VIEW_TEMP_PREFIX,
} from "./constants.ts";
import { configuredViewTargetDir } from "./target.ts";

/**
 * The real path of `path`, or of its deepest existing ancestor with the
 * missing tail appended: a view folder that does not exist yet must be
 * spelled the way its vault is (a link on the way, `/var` that is really
 * `/private/var`), or the containment test would miss it.
 */
function realOrResolved(path: string): string {
  let head = resolve(path);
  const tail: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(head), ...tail.toReversed());
    } catch {
      const parent = dirname(head);
      if (parent === head) return resolve(path);
      tail.push(basename(head));
      head = parent;
    }
  }
}

/** Case folding of the filesystems that ignore case by default. */
function fold(path: string): string {
  return process.platform === "win32" || process.platform === "darwin" ? path.toLowerCase() : path;
}

/** The configured view folder relative to `vault`, as {@link viewFolderInVault} finds it. */
function inVault(vault: string, dir: string | null): string | null {
  if (dir === null) return null;
  const rel = relative(realOrResolved(vault), realOrResolved(dir));
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return toPosix(rel);
}

/**
 * The configured view folder as a forward-slash path relative to `vault`
 * (`""` for the vault root), or `null` when no view folder is configured,
 * it lies outside the vault, or the machine config cannot be read.
 */
export function viewFolderInVault(vault: string, configPath?: string): string | null {
  try {
    return inVault(vault, configuredViewTargetDir(configPath));
  } catch {
    return null;
  }
}

const PAGE_STEMS = [VIEW_ABOUT_ME_PAGE, VIEW_DECISIONS_PAGE].map((page) =>
  page.slice(0, -VIEW_PAGE_EXT.length),
);

/** Whether a top-level name at the vault root is one the view writer owns. */
function isViewName(name: string): boolean {
  if (name.startsWith(VIEW_TEMP_PREFIX) || name === VIEW_HISTORY_DIR) return true;
  return PAGE_STEMS.some(
    (stem) =>
      name === `${stem}${VIEW_PAGE_EXT}` ||
      name.startsWith(`${stem} (`) ||
      name.startsWith(`${stem}.sync-conflict`),
  );
}

/**
 * Whether the vault-relative `relPath` is in the view folder `viewRel`
 * (from {@link viewFolderInVault}). With `container`, a folder that holds
 * the view folder counts too: moving or deleting it moves the view.
 */
export function isInViewFolder(
  viewRel: string,
  relPath: string,
  opts: { readonly container?: boolean } = {},
): boolean {
  const path = fold(posix.normalize(relPath)).replace(/\/+$/, "");
  const view = fold(viewRel);
  if (view === "" || view === ".") {
    const top = path.split("/")[0] ?? "";
    return isViewName(top);
  }
  if (path === view || path.startsWith(`${view}/`)) return true;
  return opts.container === true && (path === "" || view.startsWith(`${path}/`));
}

/**
 * The refusal reason when `relPath` is in the configured view folder of
 * `vault`, or `null` when the path is free to write.
 */
export function viewFolderRefusal(
  vault: string,
  relPath: string,
  surface: string,
  opts: { readonly container?: boolean; readonly configPath?: string } = {},
): string | null {
  let dir: string | null;
  try {
    dir = configuredViewTargetDir(opts.configPath);
  } catch (err) {
    // Fail closed: the view folder cannot be placed, so no path is free.
    return (
      `the machine config cannot be read, so ${surface} cannot check the path against the ` +
      `human view folder: ${relPath} (${err instanceof Error ? err.message : String(err)})`
    );
  }
  const viewRel = inVault(vault, dir);
  if (viewRel === null || !isInViewFolder(viewRel, relPath, opts)) return null;
  return `the human view folder is written by the view writer only, not via ${surface}: ${relPath}`;
}
