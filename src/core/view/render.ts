/**
 * The render pass of the view writer (design D7 "Render protocol", tasks
 * 2.8 and 2.9). Only the view writer renders; every other machine's pass
 * writes no page and names the writer.
 *
 * A pass:
 *
 *  1. catches up on every held partition (and stops when a shard could
 *     not be read: a render over a partial read could hide records);
 *  2. hands the role over when the user moved it (`writer.ts`), and waits
 *     one catch-up after a fresh claim;
 *  3. under the device-local render lock, for every page:
 *     a. compares the file on disk with the writer's own renders of it;
 *        a file that is none of them is a human edit, diffed against the
 *        merge base of the last render and stored as human records
 *        (`corrections.ts`, `view-records.ts`);
 *     b. ingests each conflict copy a sync tool made of the page the same
 *        way, then removes it;
 *     c. renders the page from the store, three-way merges base, the
 *        user's file and the render (the user wins), and writes it only
 *        when its bytes change (`page-io.ts`), re-checking right before
 *        the replacement and capturing the bytes it replaces; a racing
 *        edit in those bytes is ingested and the page rendered again;
 *     d. writes the render record with the new merge base;
 *  4. before the pages, removes the pages of a retiring folder (topics,
 *     reports, sources) the store no longer renders (a renamed, merged or
 *     undone topic, a removed report), ingesting any edit they carry
 *     first, and moves a renamed topic's companion files to its new
 *     folder;
 *  5. writes a `view-pass` heartbeat when it wrote nothing for a day.
 *
 * A missing or empty page is never read as an edit (deleting a page does
 * not retire every rule on it); it is rendered again.
 */

import { PartitionUnavailableError } from "../store/appender.ts";
import { SETTING_VIEW_LANGUAGE } from "../store/constants.ts";
import { foldSettings, settingValue } from "../store/fold-settings.ts";
import { withLocalLock } from "../store/local-lock.ts";
import { textCarriesPrivateRegion, valueCarriesPrivateRegion } from "../store/private-region.ts";
import type { StoreHandle } from "../store/store-open.ts";
import {
  catchUpSettings,
  catchUpWhere,
  partitionRecords,
  withOwnRecord,
  type ViewCatchUp,
} from "./catch-up.ts";
import { foldTopics } from "../topics/fold.ts";
import { VIEW_RENDER_ATTEMPTS } from "./constants.ts";
import { applyCorrections, foldCorrections, pageLines, reviewedEdits } from "./corrections.ts";
import {
  finishDefaultFolder,
  prepareDefaultFolder,
  takeDefaultFolderNotice,
} from "./default-folder.ts";
import { viewStrings } from "./i18n.ts";
import { matchLines, mergeLines } from "./line-diff.ts";
import { lanePages } from "./lane-view-pages.ts";
import {
  capturePage,
  conflictCopies,
  NotAPageFileError,
  readPage,
  replacePage,
  type ReplaceHooks,
} from "./page-io.ts";
import {
  aboutMePage,
  confirmedPreferences,
  decisionsPage,
  historyPages,
  isViewInput,
  sharedPreferences,
  viewEntries,
  type PageModel,
} from "./pages.ts";
import {
  bytesSum,
  clearIntent,
  heartbeat,
  ingestedSinceLastRender,
  ingestVersion,
  lastRender,
  loadBase,
  ownSums,
  pendingIntents,
  writeBase,
  writeIntent,
  writeRender,
  type RecordOptions,
  type RenderBase,
  type ReplacedReason,
} from "./view-records.ts";
import { claimSettled, releaseIfRequested, renderLockTarget } from "./writer.ts";
import {
  readPageStats,
  sameStat,
  settledStat,
  statPage,
  writePageStats,
  type PageStats,
} from "./page-stats.ts";
import { pageFileInside } from "./page-path.ts";
import { retirePages, type RetireContext } from "./retire.ts";
import { topicPages } from "./topic-pages.ts";
import { viewHeldRecords } from "./topic-held.ts";
import { withHeldDecisions } from "../topics/held-decisions.ts";
import { decisionTitlesOfCatchUp } from "../topics/decision-titles.ts";
import { foldViewWriter } from "./writer-fold.ts";
import type { ViewTargetOrigin } from "./target.ts";

export interface ViewPassOptions extends RecordOptions {
  /** The view folder; `null` when none is configured (nothing is written). */
  readonly target: string | null;
  /**
   * Where the target came from: `default` is the vault's own default
   * folder, the only one the release's rename may touch.
   */
  readonly targetOrigin?: ViewTargetOrigin;
  readonly hooks?: ReplaceHooks;
  /**
   * Asked before each page: `true` stops the pass there and reports the
   * remaining pages as deferred (a hook's time budget). The pass only
   * ever stops between pages.
   */
  readonly shouldStop?: () => boolean;
}

/** What happened to one page. */
export interface PageReport {
  readonly page: string;
  readonly status:
    | "written"
    | "unchanged"
    | "removed"
    | "refused"
    | "busy"
    | "base-pending"
    | "deferred";
  /** Human records written from edits of this page. */
  readonly ingested: number;
  readonly detail?: string;
}

export type ViewPassReport =
  | { readonly status: "incomplete-read"; readonly shards: ReadonlyArray<string> }
  | { readonly status: "no-writer" }
  | { readonly status: "not-writer"; readonly writer: string }
  | { readonly status: "released"; readonly to: string }
  | { readonly status: "waiting-for-claim" }
  | { readonly status: "no-target" }
  | {
      readonly status: "rendered";
      readonly pages: ReadonlyArray<PageReport>;
      /** One line the user reads once (the old view folder keeps a file of their own). */
      readonly notice?: string;
    };

/** Every page the store renders to now, with the user's corrections applied. */
export function buildPages(store: StoreHandle, read: ViewCatchUp): Map<string, PageModel> {
  const shared = partitionRecords(read, "shared");
  const lang = settingValue(foldSettings(shared), SETTING_VIEW_LANGUAGE);
  const strings = viewStrings(typeof lang === "string" ? lang : null);
  const all = sharedPreferences(shared);
  const prefs = confirmedPreferences(all);
  // The decision page titles of this read, for every page that names a
  // decision: every shared version folded, none when the read missed one
  // (`topics/decision-titles.ts`).
  const titles = decisionTitlesOfCatchUp(read, ["shared"]);
  const entries = viewEntries(shared, all, titles);
  const corrections = foldCorrections(shared);
  // Topic records that carry a `<private>` region stay off the pages, as
  // every other record family's do.
  const plain = shared.filter((r) => !valueCarriesPrivateRegion(r.body));
  // A topic shows the decisions it holds as decision items, derived from
  // the same shared records (`topics/held-decisions.ts`).
  const topics = withHeldDecisions(foldTopics(plain), plain, new Set(), titles);
  // A topic page lists the notes and signals it holds (`topic-held.ts`).
  const records = viewHeldRecords(read, topics);
  const models = [
    aboutMePage(store.storeId, prefs, strings),
    decisionsPage(store.storeId, entries, strings),
    ...historyPages(store.storeId, entries, strings),
    ...topicPages(store.storeId, topics, strings, { records }),
    ...lanePages(store.storeId, shared, strings),
  ];
  return new Map(models.map((m) => [m.page, applyCorrections(m, corrections)]));
}

function textOf(lines: ReadonlyArray<string>): string {
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

function hasContent(bytes: Buffer | null): bytes is Buffer {
  return bytes !== null && pageLines(bytes.toString("utf8")).some((l) => l.trim() !== "");
}

interface PageContext {
  readonly store: StoreHandle;
  readonly options: ViewPassOptions;
  read: ViewCatchUp;
  /** The pages as `read` renders them; dropped when an ingest changes the records. */
  models?: Map<string, PageModel>;
  /** Device-local stats of the pages as the writer last left them. */
  readonly stats: PageStats;
}

function modelOf(ctx: PageContext, page: string): PageModel | undefined {
  ctx.models ??= buildPages(ctx.store, ctx.read);
  return ctx.models.get(page);
}

/**
 * The no-change case without reading the page: its file is exactly as the
 * writer left it (same size, modification and change time, file id), that
 * text is the last render, no conflict copy exists, and the page would
 * render to the same bytes.
 */
function unchangedByStat(ctx: PageContext, page: string, path: string): boolean {
  const cached = ctx.stats.get(page);
  const last = lastRender(ctx.read, page);
  if (cached === undefined || last === null || last.record.body["sum"] !== cached.sum) return false;
  if (!sameStat(cached, statPage(path)) || conflictCopies(path).length > 0) return false;
  const model = modelOf(ctx, page);
  return model !== undefined && bytesSum(textOf(model.lines.map((l) => l.text))) === cached.sum;
}

/** Store a version that is not the writer's own render; returns the records written. */
function ingest(
  ctx: PageContext,
  page: string,
  base: RenderBase | null,
  text: string,
  reason: ReplacedReason,
): { records: number; isPrivate: boolean; refused: boolean } {
  // The same bytes seen twice (a conflict copy of an edit already read, a
  // race that delivered them again) are stored once.
  const seen = ingestedSinceLastRender(ctx.read, page).get(bytesSum(text));
  if (seen !== undefined) return { records: 0, isPrivate: seen === "private", refused: false };
  // An edit that cannot be trusted line by line (`reviewedEdits`) is kept
  // as bytes only (`view-replaced`, recoverable), never as human records.
  const reviewed =
    base === null || reason === "foreign"
      ? { records: [], refusal: null }
      : reviewedEdits(page, pageLines(base.text), base.keys, pageLines(text));
  const done = ingestVersion(ctx.store, page, text, reason, reviewed.records, ctx.options);
  ctx.read = catchUpWhere(ctx.store, isViewInput, ctx.options.now);
  delete ctx.models;
  return {
    records: done.records,
    isPrivate: done.partition === "private",
    refused: reviewed.refusal !== null,
  };
}

function renderOnePage(ctx: PageContext, page: string, path: string): PageReport {
  if (unchangedByStat(ctx, page, path)) return { page, status: "unchanged", ingested: 0 };
  // The observation clock: wall-clock time (not the pass clock, it is
  // compared with file times), captured before this pass reads or writes
  // the page. A stat taken later proves the bytes only if the page's times
  // are older than this by the racy window: a clock read after the render
  // could be past a same-size edit that landed between the read and the
  // stat, and would vouch for it as the writer's own render.
  const observedAtMs = Date.now();
  const report = renderPageNow(ctx, page, path);
  const stat = statPage(path);
  const last = lastRender(ctx.read, page);
  // Cached only when this pass left the writer's own render on disk: a
  // page left as found (its base not synced, refused, busy) must be read
  // again next pass, or an edit on it would never be ingested. A stat
  // too recent to vouch for the bytes is not kept either: an edit saved
  // at the same size in the same tick of the volume's clock keeps it.
  const settled = report.status === "written" || report.status === "unchanged";
  if (stat !== null && last !== null && settled && settledStat(stat, observedAtMs)) {
    ctx.stats.set(page, { ...stat, sum: last.record.body["sum"] as string });
  } else {
    ctx.stats.delete(page);
  }
  return report;
}

function renderPageNow(ctx: PageContext, page: string, path: string): PageReport {
  let ingested = 0;
  for (let attempt = 0; attempt < VIEW_RENDER_ATTEMPTS; attempt++) {
    const last = lastRender(ctx.read, page);
    const base = last === null ? null : loadBase(ctx.store, last);
    if (last !== null && base === null) {
      return { page, status: "base-pending", ingested, detail: "the merge base has not synced" };
    }
    const own = ownSums(ctx.read, page);
    const disk = readPage(path);
    let edited = false;
    let privateEdit = false;
    if (hasContent(disk) && !own.has(bytesSum(disk))) {
      const done = ingest(ctx, page, base, disk.toString("utf8"), base ? "edit" : "foreign");
      ingested += done.records;
      // A refused edit is not merged: the page is rendered back whole.
      edited = base !== null && !done.refused;
      privateEdit = done.isPrivate;
    }
    for (const copy of conflictCopies(path)) {
      // A name that is not a regular file (a folder, a link) is refused
      // where it is. A copy is taken out of its name before it is read: one
      // a sync tool writes again meanwhile is left for the next pass.
      readPage(copy);
      const captured = capturePage(copy);
      if (captured === null) continue;
      try {
        if (hasContent(captured.bytes) && !own.has(bytesSum(captured.bytes))) {
          const done = ingest(ctx, page, base, captured.bytes.toString("utf8"), "conflict-copy");
          ingested += done.records;
          privateEdit ||= done.isPrivate;
        }
      } catch (err) {
        captured.restore();
        throw err;
      }
      captured.discard();
    }
    const model = modelOf(ctx, page);
    if (model === undefined) return { page, status: "unchanged", ingested };
    const rendered = model.lines.map((l) => l.text);
    let lines = rendered;
    if (edited && !privateEdit && base !== null) {
      lines = mergeLines(pageLines(base.text), pageLines(disk!.toString("utf8")), rendered);
      if (textCarriesPrivateRegion(textOf(lines))) lines = rendered;
    }
    const match = matchLines(lines, rendered);
    const keys = lines.map((_, i) => (match[i]! >= 0 ? model.lines[match[i]!]!.key : null));
    const text = textOf(lines);
    const bytes = Buffer.from(text, "utf8");
    const intent = {
      page,
      ...(model.topic !== undefined ? { topic: model.topic } : {}),
      sum: bytesSum(bytes),
      base: writeBase(ctx.store, page, { text, keys }),
      bytes: bytes.length,
    };
    if (disk !== null && disk.equals(bytes)) {
      // Already on disk: an edit the render now matches still needs its base recorded.
      if (!own.has(intent.sum)) {
        ctx.read = withOwnRecord(ctx.read, "shared", writeRender(ctx.store, intent, ctx.options));
      }
      return { page, status: edited ? "written" : "unchanged", ingested };
    }
    writeIntent(ctx.store, intent);
    const outcome = replacePage(path, bytes, disk, ctx.options.hooks);
    if (outcome.status === "changed") {
      clearIntent(ctx.store, page);
      continue;
    }
    if (outcome.status === "placed") {
      ctx.read = withOwnRecord(ctx.read, "shared", writeRender(ctx.store, intent, ctx.options));
    }
    clearIntent(ctx.store, page);
    const replaced = outcome.replaced;
    const raced =
      hasContent(replaced) &&
      (disk === null || !replaced.equals(disk)) &&
      !ownSums(ctx.read, page).has(bytesSum(replaced));
    if (raced) {
      const done = ingest(ctx, page, base, replaced.toString("utf8"), "race");
      ingested += done.records;
    }
    outcome.discard();
    if (outcome.status === "placed" && !raced) return { page, status: "written", ingested };
  }
  return { page, status: "busy", ingested, detail: "the page kept changing during the render" };
}

/** Write the render records a dead pass left only as intents. */
function recoverIntents(ctx: PageContext, target: string): void {
  let wrote = false;
  for (const intent of pendingIntents(ctx.store)) {
    const path = pageFileInside(target, intent.page);
    let disk: Buffer | null = null;
    try {
      disk = path === null ? null : readPage(path);
    } catch (err) {
      if (!(err instanceof NotAPageFileError)) throw err;
    }
    const recorded = ownSums(ctx.read, intent.page).has(intent.sum);
    if (disk !== null && bytesSum(disk) === intent.sum && !recorded) {
      writeRender(ctx.store, intent, ctx.options);
      wrote = true;
    }
    clearIntent(ctx.store, intent.page);
  }
  // Read again only when a render record was written: the pass's own read
  // (taken under the render lock) already holds everything else, and a
  // second whole-store read cost a large store as much as the first.
  if (wrote) ctx.read = catchUpWhere(ctx.store, isViewInput, ctx.options.now);
}

/** Errors of a page another program holds; the page is rendered on a later pass. */
const PAGE_BUSY_CODES: ReadonlySet<string> = new Set(["EBUSY", "EPERM", "EACCES"]);

function renderPages(ctx: PageContext, target: string): PageReport[] {
  recoverIntents(ctx, target);
  const reports: PageReport[] = [];
  ctx.models ??= buildPages(ctx.store, ctx.read);
  const retire: RetireContext = {
    store: ctx.store,
    read: () => ctx.read,
    models: () => (ctx.models ??= buildPages(ctx.store, ctx.read)),
    stats: ctx.stats,
    ingest: (page, base, text, reason) => ingest(ctx, page, base, text, reason).records,
  };
  reports.push(...retirePages(retire, target, pageFailure, ctx.options.shouldStop));
  ctx.models ??= buildPages(ctx.store, ctx.read);
  // The page list of this pass: an ingest may rebuild the models, and a
  // page it renamed is retired by the next pass.
  for (const page of ctx.models.keys()) {
    if (ctx.options.shouldStop?.() === true) {
      reports.push({ page, status: "deferred", ingested: 0, detail: "the time budget ran out" });
      continue;
    }
    // A page whose folder is a link (or leads out of the view) is never written.
    const path = pageFileInside(target, page);
    if (path === null) {
      reports.push({
        page,
        status: "refused",
        ingested: 0,
        detail: "the page path leaves the view",
      });
      continue;
    }
    try {
      reports.push(renderOnePage(ctx, page, path));
    } catch (err) {
      reports.push(pageFailure(page, err));
    }
  }
  return reports;
}

/** The report of a page whose render or removal failed for a reason a later pass may not have. */
function pageFailure(page: string, err: unknown): PageReport {
  if (err instanceof PartitionUnavailableError || err instanceof NotAPageFileError) {
    return { page, status: "refused", ingested: 0, detail: err.message };
  }
  if (PAGE_BUSY_CODES.has((err as NodeJS.ErrnoException).code ?? "")) {
    // Windows refuses to rename a page another program holds open.
    return { page, status: "busy", ingested: 0, detail: (err as Error).message };
  }
  throw err;
}

/** One render pass on this machine. */
export function runViewPass(store: StoreHandle, options: ViewPassOptions): ViewPassReport {
  // The writer records first: a machine that is not the writer reads
  // nothing else.
  const settings = catchUpSettings(store, options.now);
  if (settings === null) return { status: "incomplete-read", shards: ["shared/settings"] };
  const state = foldViewWriter(settings);
  if (state.writer === null) return { status: "no-writer" };
  if (state.writer !== store.device) return { status: "not-writer", writer: state.writer };
  const to = releaseIfRequested(store, state, options);
  if (to !== null) return { status: "released", to };
  if (!claimSettled(store, state)) return { status: "waiting-for-claim" };
  return withLocalLock(renderLockTarget(store), (): ViewPassReport => {
    // Asked again under the lock: another pass may have handed the role
    // over while this one waited, and no render starts after a release.
    const settled = catchUpSettings(store, options.now);
    if (settled === null) return { status: "incomplete-read", shards: ["shared/settings"] };
    const current = foldViewWriter(settled);
    if (current.writer !== store.device) {
      return current.writer === null
        ? { status: "no-writer" }
        : { status: "not-writer", writer: current.writer };
    }
    const handed = releaseIfRequested(store, current, options);
    if (handed !== null) return { status: "released", to: handed };
    // The catch-up is taken under the lock too: a pass that rendered while
    // this one waited wrote render records a read from before the wait
    // would not know, and its pages would then read as a human edit.
    const read = catchUpWhere(store, isViewInput, options.now);
    if (read.unreadable.length > 0) {
      return { status: "incomplete-read", shards: read.unreadable.map((s) => s.path) };
    }
    const ctx: PageContext = { store, options, read, stats: readPageStats(store) };
    const target = options.target;
    // The default folder of an earlier release is renamed by the machine
    // that writes the view, before the pages are rendered (the pages go
    // into the new folder) and settled after it (an old folder that
    // arrived by sync is removed then).
    const defaultFolder = target !== null && options.targetOrigin === "default" ? target : null;
    if (defaultFolder !== null) prepareDefaultFolder(defaultFolder);
    const pages = target === null ? [] : renderPages(ctx, target);
    let notice: string | undefined;
    if (defaultFolder !== null) {
      // Only a page that is on disk (written, unchanged, or removed on
      // purpose) proves that the new folder holds it. A page that failed
      // (its merge base has not synced, the file is busy, the write was
      // refused) or was deferred is not there, and the legacy copy of it
      // must not be deleted for a page that was never written.
      const rendered = new Set(
        pages
          .filter(
            (p) => p.status === "written" || p.status === "unchanged" || p.status === "removed",
          )
          .map((p) => p.page),
      );
      const oldFolder = finishDefaultFolder(defaultFolder, rendered, (page, bytes) =>
        ownSums(ctx.read, page).has(bytesSum(bytes)),
      );
      notice = takeDefaultFolderNotice(store.deviceStateDir, oldFolder, defaultFolder) ?? undefined;
    }
    writePageStats(store, ctx.stats);
    // The daily "alive" record only for a genuinely idle pass: a view
    // folder to render to, and every page already as rendered. A writer
    // that renders nothing (no folder, pages refused or busy) stays
    // silent, so the doctor's silent-writer check can say so.
    const idle = target !== null && pages.every((p) => p.status === "unchanged");
    if (idle) heartbeat(store, ctx.read, options);
    return target === null
      ? { status: "no-target" }
      : { status: "rendered", pages, ...(notice !== undefined ? { notice } : {}) };
  });
}
