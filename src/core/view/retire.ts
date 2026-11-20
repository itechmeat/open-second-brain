/**
 * Pages that leave the view (task 3.2, design D16 item 10): a topic
 * renamed, merged or undone, a report removed, or a topic folder another
 * topic now takes. Split from `render.ts`, which calls it before it
 * renders the pages of a pass.
 *
 * Two kinds of page leave:
 *
 *  - a page of a retiring folder (`topics/`, `reports/`, `sources/`) a
 *    render record names and the store no longer renders;
 *  - a page the store still renders whose file on disk names another
 *    topic in its id line: the folder slot passed from one topic to
 *    another (a rename, or a topic with an earlier clock that synced in
 *    late), so the old topic's page and the user's files in its folder
 *    belong elsewhere now.
 *
 * Either way an edit the page carries, and every conflict copy of it, is
 * ingested first, as before a render; the page leaves its name by one
 * atomic rename, so an edit that lands right before it is captured too;
 * and the user's companion files of a topic folder follow the topic to
 * its current folder. A topic page whose file is already gone (a pass
 * that died after removing it) still has its companions moved, by the
 * topic its last render record names.
 *
 * Every page path comes from store records any device can write, so it
 * passes the exact shape check and the inside-the-view check of
 * `page-path.ts` before any file operation; any other path is ignored.
 */

import { type BigIntStats, statSync } from "node:fs";
import { identityOfStats, sameIdentity } from "../fs-identity.ts";
import { basename, dirname } from "node:path";

import { compareCodeUnits } from "../store/compare.ts";
import type { StoreHandle } from "../store/store-open.ts";
import type { ViewCatchUp } from "./catch-up.ts";
import {
  VIEW_RENDER_KIND,
  VIEW_RETIRING_DIRS,
  VIEW_TOPIC_ARCHIVE_PAGE,
  VIEW_TOPIC_PAGE,
} from "./constants.ts";
import { pageLines } from "./corrections.ts";
import { pageFileInside, retiringPageFile } from "./page-path.ts";
import {
  capturePage,
  conflictCopies,
  listCompanions,
  moveCompanions,
  NotAPageFileError,
  readPage,
  removeEmptyFolder,
} from "./page-io.ts";
import type { PageStats } from "./page-stats.ts";
import type { PageModel } from "./pages.ts";
import { topicOfIdLine } from "./topic-pages.ts";
import {
  bytesSum,
  lastRender,
  loadBase,
  ownSums,
  type RenderBase,
  type ReplacedReason,
} from "./view-records.ts";

/** What retiring needs from the render pass it runs in. */
export interface RetireContext {
  readonly store: StoreHandle;
  /** The pass's current read (an ingest replaces it). */
  read(): ViewCatchUp;
  /** The pages the store renders now (rebuilt after an ingest). */
  models(): ReadonlyMap<string, PageModel>;
  readonly stats: PageStats;
  /** Store a version that is not the writer's own render; returns the records written. */
  ingest(page: string, base: RenderBase | null, text: string, reason: ReplacedReason): number;
}

/** What happened to one page that left. */
export interface RetireReport {
  readonly page: string;
  readonly status: "removed" | "base-pending" | "deferred";
  readonly ingested: number;
  readonly detail?: string;
}

const COMPANION_SKIP: ReadonlySet<string> = new Set([VIEW_TOPIC_PAGE, VIEW_TOPIC_ARCHIVE_PAGE]);

function hasContent(bytes: Buffer | null): bytes is Buffer {
  return bytes !== null && pageLines(bytes.toString("utf8")).some((l) => l.trim() !== "");
}

const archiveFirst = (page: string): number => (basename(page) === VIEW_TOPIC_ARCHIVE_PAGE ? 0 : 1);

function byFolder(a: string, b: string): number {
  return compareCodeUnits(dirname(a), dirname(b)) || archiveFirst(a) - archiveFirst(b);
}

/** The folder a topic's page lives in now, from the models of this pass. */
function currentTopicFolder(ctx: RetireContext, topic: string | null): string | null {
  if (topic === null) return null;
  for (const model of ctx.models().values()) {
    if (model.topic === topic && basename(model.page) === VIEW_TOPIC_PAGE)
      return dirname(model.page);
  }
  return null;
}

/** The topic the last render record of `page` names, or `null`. */
function renderedTopic(ctx: RetireContext, page: string): string | null {
  const topic = lastRender(ctx.read(), page)?.record.body["topic"];
  return typeof topic === "string" ? topic : null;
}

function moveFolderCompanions(
  ctx: RetireContext,
  target: string,
  page: string,
  topic: string | null,
  only?: ReadonlySet<string>,
): void {
  const moved = currentTopicFolder(ctx, topic);
  if (moved === null || moved === dirname(page)) return;
  const to = pageFileInside(target, `${moved}/${VIEW_TOPIC_PAGE}`);
  const from = pageFileInside(target, page);
  if (to === null || from === null) return;
  moveCompanions(dirname(from), dirname(to), COMPANION_SKIP, only);
}

/**
 * The companion names in the folder of each page, read before anything
 * moves: when topics exchange folders, a folder receives another topic's
 * files before its own leave, and only the names it held at the start
 * are its topic's.
 */
function companionsAtStart(target: string, pages: ReadonlyArray<string>): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const page of pages) {
    const path = pageFileInside(target, page);
    if (path !== null) out.set(page, new Set(listCompanions(dirname(path), COMPANION_SKIP)));
  }
  return out;
}

/** Take one page out of the view; `null` when there was nothing to take. */
function retireOne(
  ctx: RetireContext,
  target: string,
  page: string,
  path: string,
  options: { readonly keepFolder: boolean; readonly companions?: ReadonlySet<string> },
): RetireReport | null {
  const copies = conflictCopies(path);
  if (readPage(path) === null && copies.length === 0) {
    // The page went before its companions did (a pass that died between).
    if (basename(page) === VIEW_TOPIC_PAGE) {
      moveFolderCompanions(ctx, target, page, renderedTopic(ctx, page), options.companions);
      if (!options.keepFolder) removeEmptyFolder(dirname(path));
    }
    return null;
  }
  const last = lastRender(ctx.read(), page);
  const base = last === null ? null : loadBase(ctx.store, last);
  if (last !== null && base === null) {
    return { page, status: "base-pending", ingested: 0, detail: "the merge base has not synced" };
  }
  const own = ownSums(ctx.read(), page);
  let ingested = 0;
  for (const copy of copies) {
    // A name that is not a regular file (a folder, a link) is refused
    // where it is. A copy is taken out of its name before it is read, as
    // the page is: one a sync tool writes again meanwhile is left for the
    // next pass, never removed.
    readPage(copy);
    const captured = capturePage(copy);
    if (captured === null) continue;
    try {
      if (hasContent(captured.bytes) && !own.has(bytesSum(captured.bytes))) {
        ingested += ctx.ingest(page, base, captured.bytes.toString("utf8"), "conflict-copy");
      }
    } catch (err) {
      captured.restore();
      throw err;
    }
    captured.discard();
  }
  const captured = capturePage(path);
  if (captured !== null) {
    try {
      if (hasContent(captured.bytes) && !own.has(bytesSum(captured.bytes))) {
        const text = captured.bytes.toString("utf8");
        ingested += ctx.ingest(page, base, text, base ? "edit" : "foreign");
      }
    } catch (err) {
      captured.restore();
      throw err;
    }
    captured.discard();
    if (basename(page) === VIEW_TOPIC_PAGE) {
      const firstLine = pageLines(captured.bytes.toString("utf8"))[0] ?? "";
      // The writer's own render record says whose page it was; the id line,
      // which a user can edit, decides only when that record names none.
      const owner = renderedTopic(ctx, page) ?? topicOfIdLine(firstLine);
      moveFolderCompanions(ctx, target, page, owner, options.companions);
    }
  }
  if (!options.keepFolder) removeEmptyFolder(dirname(path));
  ctx.stats.delete(page);
  return { page, status: "removed", ingested };
}

/**
 * The topic the id line of the page file at `path` names, or `null`. A
 * name that is not a regular file (a folder, a link) names no owner: the
 * render of that page reports it as refused, and the rest of the pass goes on.
 */
function ownerOnDisk(path: string): string | null {
  let disk: Buffer | null;
  try {
    disk = readPage(path);
  } catch (err) {
    if (err instanceof NotAPageFileError) return null;
    throw err;
  }
  return disk === null ? null : topicOfIdLine(pageLines(disk.toString("utf8"))[0] ?? "");
}

/**
 * Live topic pages whose file is another topic's: the slot passed to a new
 * topic. Whose a page is comes from the writer's own last render record of
 * it; the id line on disk, which a user's edit or a sync merge can change,
 * decides only for a page rendered before render records named a topic.
 */
function foreignPages(ctx: RetireContext, target: string): string[] {
  const out: string[] = [];
  for (const model of ctx.models().values()) {
    if (model.topic === undefined) continue;
    const path = pageFileInside(target, model.page);
    if (path === null) continue;
    // A page already gone still names, in its last render record, whose
    // folder this was: that topic's files must still leave it. The disk
    // is read only when no render record says it.
    const owner = renderedTopic(ctx, model.page) ?? ownerOnDisk(path);
    if (owner !== null && owner !== model.topic) out.push(model.page);
  }
  return out.toSorted(byFolder);
}

/** Whether `a` and `b` are one file on disk (a case-insensitive file system, or a link). */
function sameFile(a: string, b: string): boolean {
  return sameFileStats(bigStatOrNull(a), bigStatOrNull(b));
}

function bigStatOrNull(path: string): BigIntStats | null {
  try {
    return statSync(path, { bigint: true, throwIfNoEntry: false }) ?? null;
  } catch {
    return null;
  }
}

/**
 * Whether two `bigint` stats are one file, failing toward "the same" when
 * the filesystem reports no inode. The answer spares a retiring page that
 * may be the live page's own file under another spelling (a case-only
 * difference on a case-insensitive volume): a wrong "same" leaves a stale
 * page in the view, a wrong "different" retires the live page and ingests
 * its text under the retired name. With an inode on both sides the exact
 * identity decides (`fs-identity.ts`). Without one (a network share, a
 * FAT-family volume) one file always shows the same device, size and
 * change times under both names, so those equal means "same": the live
 * page is never retired, and two different files are taken for one only
 * when all four agree, which only spares a page. Exported for tests.
 */
export function sameFileStats(a: BigIntStats | null, b: BigIntStats | null): boolean {
  if (a === null || b === null) return false;
  const left = identityOfStats(a);
  const right = identityOfStats(b);
  if (left !== null && right !== null) return sameIdentity(left, right);
  return a.dev === b.dev && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

/** Pages a render record names in a retiring folder that the store no longer renders. */
function retiredPages(ctx: RetireContext, target: string): string[] {
  const live = ctx.models();
  const livePaths = new Map<string, string>();
  for (const page of live.keys()) {
    const file = pageFileInside(target, page);
    if (file !== null) livePaths.set(page.toLowerCase(), file);
  }
  const out = new Set<string>();
  for (const records of ctx.read().records.values()) {
    for (const record of records) {
      const page = record.body["page"];
      if (record.kind !== VIEW_RENDER_KIND || typeof page !== "string" || live.has(page)) continue;
      if (!VIEW_RETIRING_DIRS.some((dir) => page.startsWith(`${dir}/`))) continue;
      const file = retiringPageFile(target, page);
      if (file === null) continue;
      // On a case-insensitive file system a page whose path differs from a
      // live page's only in case is that live page's file: never retired.
      const twin = livePaths.get(page.toLowerCase());
      if (twin !== undefined && sameFile(file, twin)) continue;
      out.add(page);
    }
  }
  return [...out].toSorted(byFolder);
}

/**
 * Retire every page that left the view, in the order that keeps a
 * user's files with the right topic: first the pages whose folder slot
 * another topic took (their companions move out before anything moves
 * in), then the pages no longer rendered. `onFailure` turns an error of
 * one page into its report; the other pages still retire.
 */
export function retirePages<R>(
  ctx: RetireContext,
  target: string,
  onFailure: (page: string, err: unknown) => R,
  shouldStop?: () => boolean,
): Array<RetireReport | R> {
  const reports: Array<RetireReport | R> = [];
  const foreign = foreignPages(ctx, target);
  const companions = companionsAtStart(target, foreign);
  const run = (page: string, keepFolder: boolean): void => {
    const path = keepFolder ? pageFileInside(target, page) : retiringPageFile(target, page);
    if (path === null) return;
    // The pass's time budget holds here too: the rest wait for a later pass.
    if (shouldStop?.() === true) {
      reports.push({ page, status: "deferred", ingested: 0, detail: "the time budget ran out" });
      return;
    }
    try {
      const own = companions.get(page);
      const report = retireOne(ctx, target, page, path, {
        keepFolder,
        ...(own !== undefined ? { companions: own } : {}),
      });
      if (report !== null) reports.push(report);
    } catch (err) {
      reports.push(onFailure(page, err));
    }
  };
  for (const page of foreign) run(page, true);
  for (const page of retiredPages(ctx, target)) run(page, false);
  return reports;
}
