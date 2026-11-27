/**
 * The titles of decision pages, for every surface that names a decision
 * from its log event (the view's decisions and history pages, a topic's
 * decision items and held listing, and the planning text of a decision
 * event, `candidates.ts`), and for the doctor's check of review
 * obligations that still carry a private decision's title outside
 * `private` (`doctor/review-obligation-check.ts`,
 * {@link privateDecisionTitlesOf}).
 *
 * A `decision-record` or `decision-resolved` event names the decision
 * page it belongs to (`decision: [[decision-<slug>]]`) and, since decision
 * events carry one, the decision's `title`. An event a release wrote
 * before that names only the page and the option chosen, so a surface
 * that read the event alone showed "одна страница" where `decision show`
 * has "Тема-четыре release format t4: одна страница". The page itself
 * holds the title: on a store-only machine as a `lane-entry` record of the
 * `decisions` lane (imported by the store migration, or written there),
 * on an unswitched one as the same record the dual write keeps beside the
 * legacy file. So the titles are read from the records the caller already
 * holds, folded once per read ({@link decisionTitlesOf}), never with a
 * store read per event.
 *
 * Privacy is judged on the version the fold lets win, never before it: a
 * caller passes every version of a page it read, since dropping a private
 * later version would let an older public one win and name a shared event
 * with a title the page no longer shows. A title whose page is private (its winning record is in the
 * `private` partition, carries a `<private>` region, or its fields reserve
 * the page) names only a record that is private itself
 * (`withPrivate`); a shared surface falls back to what the event says.
 *
 * Completeness: a title is used only when the read of the page versions is
 * known complete. A shard read only in part, or a page version whose body
 * has not arrived (a pending blob, quarantined or not), can hide the newer
 * version that wins, and the fold would pick an older one: its title, and
 * its privacy, would be the wrong ones. Such a read gives no title at all
 * (`complete: false`), and the surface says what the event says. This
 * module is the one owner of "the title for this event, or none"
 * ({@link decisionEventTitle} over {@link decisionTitlesOf}): every surface
 * goes through it, with the completeness of its own read.
 *
 * The page is addressed by the link exactly as the event wrote it: an old
 * event links the page under the slug it was written with, and that page
 * keeps its name, so no slug is resolved here.
 */

import { BLOB_REF_KEY, type StorePartition } from "../store/constants.ts";
import type { StoreRecord } from "../store/envelope.ts";
import { foldLaneEntries, LANE_ENTRY_KIND, LANE_ENTRY_REMOVE_KIND } from "../store/lane-records.ts";
import { isPrivateFrontmatter } from "../store/private-page.ts";
import { valueCarriesPrivateRegion } from "../store/private-region.ts";

/** The lane of `Brain/decisions/`, where every decision page lives. */
const DECISIONS_LANE = "decisions";

/** `[[decision-<slug>]]`, an alias allowed: the page an event names. */
const DECISION_LINK_RE = /^\[\[\s*(decision-[^\]|]+?)\s*(?:\|[^\]]*)?\]\]$/u;

/** Whether `record` is a write or a removal of a decision page. */
export function isDecisionPageRecord(record: StoreRecord): boolean {
  return (
    (record.kind === LANE_ENTRY_KIND || record.kind === LANE_ENTRY_REMOVE_KIND) &&
    record.body["lane"] === DECISIONS_LANE
  );
}

/**
 * What a read of the `events` stream keeps to name decisions: every
 * decision page version, and every lane entry whose body is still a blob
 * reference (its lane is in the body, so it may be a decision page that
 * has not arrived; the reader counts it as pending, {@link pageReadComplete}).
 */
export function isDecisionPageInput(record: StoreRecord): boolean {
  if (isDecisionPageRecord(record)) return true;
  return (
    (record.kind === LANE_ENTRY_KIND || record.kind === LANE_ENTRY_REMOVE_KIND) &&
    typeof record.body[BLOB_REF_KEY] === "string"
  );
}

/** The decision page entry (`decision-<slug>`) a decision event's `decision` link names, or null. */
export function decisionPageEntryOf(link: unknown): string | null {
  if (typeof link !== "string") return null;
  return DECISION_LINK_RE.exec(link.trim())?.[1] ?? null;
}

/** The titles of the decision pages a reader holds. */
export interface DecisionTitles {
  /**
   * Whether the read the titles come from held every version of every
   * page it may hold; `false` gives no title for any link.
   */
  readonly complete: boolean;
  /**
   * The title of the page `link` names, or null when the reader holds no
   * live page with one, or the page is private and `withPrivate` is false.
   */
  of(link: unknown, withPrivate: boolean): string | null;
}

/** No page titles: a surface reads the event alone. */
export const NO_DECISION_TITLES: DecisionTitles = Object.freeze({ complete: true, of: () => null });

/** The titles of a read that may miss a page version: none, and it says so. */
const INCOMPLETE_TITLES: DecisionTitles = Object.freeze({ complete: false, of: () => null });

/** The page versions a reader holds, and whether that read is complete. */
export interface DecisionPageRead {
  /** Every record read (any other than a decision page is ignored), every version kept. */
  readonly records: ReadonlyArray<StoreRecord>;
  /** The ids of those read from the `private` partition. */
  readonly privateIds?: ReadonlySet<string>;
  /**
   * Whether the read held every page version it may hold: no shard of the
   * `events` stream read only in part, and no lane entry left out with a
   * body that has not arrived ({@link pageReadComplete}).
   */
  readonly complete: boolean;
}

/**
 * Whether a read of the `events` stream held every decision page version:
 * `unreadable` shards it could not read in full (or that are gone), and
 * `pendingKinds` the envelope kinds of the records it left out pending.
 * A pending lane entry of any lane counts, since the lane is in its body.
 * Absent `pendingKinds` (a read that did not count them) is incomplete.
 */
export function pageReadComplete(
  unreadable: number,
  pendingKinds: Iterable<readonly [string, number]> | undefined,
): boolean {
  if (unreadable > 0 || pendingKinds === undefined) return false;
  for (const [kind, n] of pendingKinds) {
    if (n > 0 && (kind === LANE_ENTRY_KIND || kind === LANE_ENTRY_REMOVE_KIND)) return false;
  }
  return true;
}

/**
 * The titles of a whole-store catch-up (`view/catch-up.ts`), the read of
 * the view render, topic planning and the decide pass: complete only when
 * it named no unreadable shard and counted no pending lane entry, in
 * `partitions` (default: every partition it read).
 */
export function decisionTitlesOfCatchUp(
  read: {
    readonly records: ReadonlyMap<StorePartition, ReadonlyArray<StoreRecord>>;
    readonly unreadable: ReadonlyArray<unknown>;
    readonly pendingKinds?: ReadonlyMap<StorePartition, ReadonlyMap<string, number>>;
  },
  partitions: ReadonlyArray<StorePartition> = [...read.records.keys()],
): DecisionTitles {
  const pending =
    read.pendingKinds === undefined
      ? undefined
      : partitions.flatMap((p) => [...(read.pendingKinds!.get(p) ?? new Map<string, number>())]);
  const records = partitions.flatMap((p) => read.records.get(p) ?? []);
  const privateIds = new Set((read.records.get("private") ?? []).map((r) => r.id));
  return decisionTitlesOf({
    records,
    privateIds: partitions.includes("private") ? privateIds : new Set(),
    complete: pageReadComplete(read.unreadable.length, pending),
  });
}

/** A live decision page's title, and whether its winning version is private. */
interface PageTitle {
  readonly title: string;
  readonly private: boolean;
}

/**
 * The title of every live decision page among `read.records`, by entry,
 * folded once over every version; privacy judged on the version that
 * wins. The caller has checked that the read is complete.
 */
function pageTitlesOf(read: DecisionPageRead): ReadonlyMap<string, PageTitle> {
  const privateIds = read.privateIds ?? new Set<string>();
  const pages = read.records.filter(isDecisionPageRecord);
  const titles = new Map<string, PageTitle>();
  if (pages.length === 0) return titles;
  const byId = new Map(pages.map((r) => [r.id, r]));
  for (const state of foldLaneEntries(pages).entries.values()) {
    const value = state.value;
    if (value === null || value.lane !== DECISIONS_LANE) continue;
    const title = value.fields["title"];
    if (typeof title !== "string" || title.trim() === "") continue;
    const winner = byId.get(state.winner);
    const isPrivate =
      privateIds.has(state.winner) ||
      (winner !== undefined && valueCarriesPrivateRegion(winner.body)) ||
      isPrivateFrontmatter(value.fields);
    titles.set(value.entry, { title: title.trim(), private: isPrivate });
  }
  return titles;
}

/**
 * The titles of the decision pages among `read.records`, folded once over
 * every version; none when the read is not complete.
 */
export function decisionTitlesOf(read: DecisionPageRead): DecisionTitles {
  if (!read.complete) return INCOMPLETE_TITLES;
  const titles = pageTitlesOf(read);
  if (titles.size === 0) return NO_DECISION_TITLES;
  return {
    complete: true,
    of(link, withPrivate) {
      const entry = decisionPageEntryOf(link);
      const found = entry === null ? undefined : titles.get(entry);
      if (found === undefined || (found.private && !withPrivate)) return null;
      return found.title;
    },
  };
}

/**
 * The titles of the live decision pages among `read.records` whose
 * winning version is private (the same verdict {@link decisionTitlesOf}
 * gives), for a local reader that looks for what still names such a
 * page outside `private` (the doctor's review obligation check). Empty
 * when the read is not complete: a missed version could make another
 * title the one that wins.
 */
export function privateDecisionTitlesOf(read: DecisionPageRead): ReadonlySet<string> {
  if (!read.complete) return new Set();
  const titles = new Set<string>();
  for (const page of pageTitlesOf(read).values()) {
    if (page.private) titles.add(page.title);
  }
  return titles;
}

/**
 * The title a decision event names, or none: its own `title`, else the
 * title of the page it links when `titles` comes from a complete read and
 * the page may name this record (`withPrivate`), else null. The one place
 * a surface takes a decision's title from.
 */
export function decisionEventTitle(
  payload: Readonly<Record<string, unknown>>,
  titles: DecisionTitles,
  withPrivate: boolean,
): string | null {
  const own = payload["title"];
  if (typeof own === "string" && own.trim() !== "") return own.trim();
  return titles.of(payload["decision"], withPrivate);
}
