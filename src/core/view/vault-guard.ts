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
 * temp files and its folders (history, topics, reports, sources).
 *
 * A topic page is never written by a note tool (spec `topics` "Direct
 * page write is refused"): the refusal for a path in the topics folder
 * names the topic event tool to use instead, and one in the reports or
 * sources folder names the tool that writes those.
 */

import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";

import { toPosix } from "../path-safety.ts";
import {
  VIEW_ABOUT_ME_PAGE,
  VIEW_DECISIONS_PAGE,
  VIEW_HISTORY_DIR,
  VIEW_PAGE_EXT,
  VIEW_REPORTS_DIR,
  VIEW_SOURCES_DIR,
  VIEW_TEMP_PREFIX,
  VIEW_TOPICS_DIR,
} from "./constants.ts";
import { isRetiringPageShape } from "./page-path.ts";
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

/** The view writer's folders. */
const VIEW_DIRS: ReadonlySet<string> = new Set([
  VIEW_HISTORY_DIR,
  VIEW_TOPICS_DIR,
  VIEW_REPORTS_DIR,
  VIEW_SOURCES_DIR,
]);

/** What to use instead of a note tool, per view folder. */
const INSTEAD: Readonly<Record<string, string>> = Object.freeze({
  [VIEW_TOPICS_DIR]:
    "a topic page is rendered from topic events: record them with the `brain_topic` tool " +
    "(or the `o2b topic` command) instead",
  [VIEW_REPORTS_DIR]:
    "a report page is rendered from the report: write it with `brain_research_report` instead",
  [VIEW_SOURCES_DIR]:
    "a source page is rendered from the source summary: write it with `brain_ingest_source` instead",
});

/** Folders a user's own notes may share with a view at the vault root. */
const SHARED_ROOT_DIRS: ReadonlySet<string> = new Set([
  VIEW_TOPICS_DIR,
  VIEW_REPORTS_DIR,
  VIEW_SOURCES_DIR,
]);

/** A sync tool's conflict-copy suffix after a page's stem, as `page-io.ts` recognises it. */
const COPY_SUFFIX_RE = /(?:\.sync-conflict-[^/]*| \([^)/]*conflicted copy[^)/]*\))(\.md)$/i;

/**
 * Whether `path`, under a top folder a view at the vault root shares with
 * the user's notes (`topics/`, `reports/`, `sources/`), is the view's: a
 * page the renderer writes, a sync tool's conflict copy of one, a writer
 * temp file in a topic folder, or (with `container`) the shared folder or
 * a topic folder itself. A user's own `topics/plan.md` stays theirs.
 */
function isSharedRootViewPath(path: string, container: boolean): boolean {
  const parts = path.split("/");
  if (parts.length === 1) return container;
  const name = parts.at(-1)!;
  if (name.startsWith(VIEW_TEMP_PREFIX)) return true;
  if (isRetiringPageShape(path) || isRetiringPageShape(path.replace(COPY_SUFFIX_RE, "$1"))) {
    return true;
  }
  return (
    container &&
    parts[0] === VIEW_TOPICS_DIR &&
    parts.length === 2 &&
    isRetiringPageShape(`${path}/topic.md`)
  );
}

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
    if (SHARED_ROOT_DIRS.has(top)) return isSharedRootViewPath(path, opts.container === true);
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
  const refusal = `the human view folder is written by the view writer only, not via ${surface}: ${relPath}`;
  const instead = INSTEAD[viewFolderOf(viewRel, relPath) ?? ""];
  return instead === undefined ? refusal : `${refusal}; ${instead}`;
}

/** The view folder (`topics`, `history`, ...) a vault-relative path inside the view sits in. */
function viewFolderOf(viewRel: string, relPath: string): string | null {
  const path = fold(posix.normalize(relPath)).replace(/\/+$/, "");
  const view = fold(viewRel);
  const inside = view === "" || view === "." ? path : path.slice(view.length + 1);
  const top = inside.split("/")[0] ?? "";
  return inside.includes("/") && VIEW_DIRS.has(top) ? top : null;
}
