/**
 * The minimal human view pages (design D7, D13 phase 2; task 2.9):
 * `about-me.md`, `history/<YYYY>-W<ww>.md` and `decisions.md`, built from
 * store records only, never from the legacy `Brain/` tree.
 *
 * Every page is a list of lines, each with a key naming what the line
 * shows (`pref:<id>`, `rec:<record id>`, a heading), so an edit the user
 * makes to a line can be mapped back to the record it came from. Page
 * shape:
 *
 *  - the first line is one HTML comment with the store id and the page;
 *  - no frontmatter, and no Obsidian-only links: a `[[target|alias]]` in
 *    quoted text is written as its plain text;
 *  - headings, introductions and labels are generated prose in the
 *    `view.language` language (`i18n.ts`); quoted source text (a rule's
 *    principle, a note, a decision's choice) is kept as written.
 *
 * What a page shows:
 *
 *  - about-me: confirmed preferences, grouped by their scope (the subject);
 *  - decisions: `decision-record` and `decision-resolved` log events, newest first;
 *  - history: per ISO week (UTC), day by day, the notes (`note` log events),
 *    decisions, and the rules confirmed that day.
 *
 * Privacy: pages are rendered from the `shared` partition only, and a
 * shared record that carries a `<private>` region is left out of the fold,
 * so nothing private reaches a page a machine without the private
 * partition, or a phone that syncs only the view, can see. A rule whose
 * later versions are private (a private edit of a shared rule) shows its
 * last shared version: text the shared partition already holds, and so
 * every machine of the store already sees.
 */

import { DAY_MS, LOG_EVENT_KIND, PREFERENCE_EVIDENCE_KIND } from "../store/constants.ts";
import { compareRecords, type StoreRecord } from "../store/envelope.ts";
import { foldPreferences, type PreferenceState } from "../store/fold-preferences.ts";
import { parseHlc } from "../store/hlc.ts";
import { valueCarriesPrivateRegion } from "../store/private-region.ts";
import { compareCodeUnits } from "../store/compare.ts";
import {
  VIEW_ABOUT_ME_PAGE,
  VIEW_DECISIONS_PAGE,
  VIEW_HISTORY_DIR,
  VIEW_PAGE_EXT,
} from "./constants.ts";
import type { ViewStrings } from "./i18n.ts";

/** One line of a page and the key of what it shows (`null`: layout only). */
export interface PageLine {
  readonly key: string | null;
  readonly text: string;
}

/** A page: its path relative to the view folder (`/`-separated) and its lines. */
export interface PageModel {
  readonly page: string;
  readonly lines: ReadonlyArray<PageLine>;
}

/** Key of the id comment line; never mapped to a record. */
export const ID_LINE_KEY = "#id";

/** Log event types the pages show. */
const NOTE_EVENT = "note";
const DECISION_RECORD_EVENT = "decision-record";
const DECISION_RESOLVED_EVENT = "decision-resolved";

/** The confirmed and retired statuses of a preference. */
const CONFIRMED = "confirmed";
const RETIRED = "retired";

const WIKILINK_RE = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

/** One line of quoted source text: no newlines, no Obsidian-only links. */
export function plainText(text: string): string {
  return text
    .replaceAll(WIKILINK_RE, (_all, target: string, alias: string | undefined) =>
      (alias ?? target).trim(),
    )
    .replaceAll(/\s+/g, " ")
    .trim();
}

/** The id comment line of `page`. */
export function idLine(storeId: string, page: string): PageLine {
  return {
    key: ID_LINE_KEY,
    text: `<!-- open-second-brain-view store=${storeId} page=${page} -->`,
  };
}

const BLANK: PageLine = { key: null, text: "" };

function principleOf(state: PreferenceState): string | null {
  const principle = state.fields["principle"];
  return typeof principle === "string" && plainText(principle) !== "" ? plainText(principle) : null;
}

/**
 * Every preference as the `shared` partition alone folds it: a record that
 * carries a `<private>` region is left out of the fold, and records in
 * `private` are never read, so a private edit of a shared rule leaves the
 * page showing the rule's last shared version.
 */
export function sharedPreferences(shared: ReadonlyArray<StoreRecord>): PreferenceState[] {
  const usable = shared.filter(
    (r) => r.kind === PREFERENCE_EVIDENCE_KIND || !valueCarriesPrivateRegion(r.body),
  );
  return [...foldPreferences(usable).preferences.values()];
}

/** The confirmed preferences with a principle, in id order. */
export function confirmedPreferences(prefs: ReadonlyArray<PreferenceState>): PreferenceState[] {
  return prefs.filter(
    (p) => p.exists && p.fields["status"] === CONFIRMED && principleOf(p) !== null,
  );
}

function subjectOf(state: PreferenceState): string {
  const scope = state.fields["scope"];
  return typeof scope === "string" ? plainText(scope) : "";
}

/** The `about-me.md` page. */
export function aboutMePage(
  storeId: string,
  prefs: ReadonlyArray<PreferenceState>,
  strings: ViewStrings,
): PageModel {
  const lines: PageLine[] = [idLine(storeId, VIEW_ABOUT_ME_PAGE), BLANK];
  lines.push({ key: "h:title", text: `# ${strings.aboutTitle}` }, BLANK);
  lines.push({ key: "p:intro", text: strings.aboutIntro });
  const bySubject = new Map<string, PreferenceState[]>();
  for (const pref of prefs) {
    const subject = subjectOf(pref);
    bySubject.set(subject, [...(bySubject.get(subject) ?? []), pref]);
  }
  if (bySubject.size === 0) lines.push(BLANK, { key: "p:empty", text: strings.aboutEmpty });
  // Named subjects in code unit order, the general one last.
  const subjects = [...bySubject.keys()].toSorted((a, b) =>
    a === "" ? 1 : b === "" ? -1 : compareCodeUnits(a, b),
  );
  for (const subject of subjects) {
    const title = subject === "" ? strings.generalSubject : subject;
    lines.push(BLANK, { key: `h:subject:${subject}`, text: `## ${title}` }, BLANK);
    for (const pref of bySubject.get(subject)!) {
      lines.push({ key: `pref:${pref.id}`, text: `- ${principleOf(pref)!}` });
    }
  }
  return { page: VIEW_ABOUT_ME_PAGE, lines };
}

/** A dated entry of the history and decisions pages. */
export interface ViewEntry {
  readonly key: string;
  /** UTC day, `YYYY-MM-DD`. */
  readonly day: string;
  readonly kind: "note" | "decision" | "rule" | "retired";
  readonly text: string;
  readonly review?: string;
  /** Fold position, for a stable order within a day. */
  readonly order: StoreRecord;
  /**
   * When it happened, in ms: the time the record's body states (a log
   * event's `timestamp`, a rule's `confirmed_at`, a retirement's
   * `retired_at`), else its clock. A record imported by the store
   * migration carries the clock of the import, so only the body's time
   * says when the legacy event happened.
   */
  readonly at: number;
}

/** The time a body states, else the record's clock, in ms. */
function momentOf(record: StoreRecord, timestamp: unknown): number {
  if (typeof timestamp === "string") {
    const ms = Date.parse(timestamp);
    if (Number.isFinite(ms)) return ms;
  }
  return parseHlc(record.hlc)!.physical;
}

function dayOf(record: StoreRecord, timestamp: unknown): string {
  return new Date(momentOf(record, timestamp)).toISOString().slice(0, 10);
}

function textField(body: unknown, field: string): string | null {
  if (typeof body !== "object" || body === null) return null;
  const value = (body as Record<string, unknown>)[field];
  return typeof value === "string" && plainText(value) !== "" ? plainText(value) : null;
}

/**
 * The record that retired `pref`, when the user did (an edit of the
 * profile page, or a command): the winning `status` is `retired` and its
 * record has human authority. Retirements by an agent or by dream are not
 * history a person needs to read.
 */
function humanRetirement(pref: PreferenceState): StoreRecord | null {
  if (!pref.exists || pref.fields["status"] !== RETIRED || principleOf(pref) === null) return null;
  const winner = pref.history.find((r) => r.id === pref.fieldWinners["status"]);
  return winner !== undefined && winner.body["authority"] === "human" ? winner : null;
}

/**
 * Notes and decisions from shared log events, the day each confirmed rule
 * was confirmed, and the day the user retired a rule. `prefs` is every
 * shared preference ({@link sharedPreferences}).
 */
export function viewEntries(
  shared: ReadonlyArray<StoreRecord>,
  prefs: ReadonlyArray<PreferenceState>,
): ViewEntry[] {
  const entries: ViewEntry[] = [];
  for (const record of shared) {
    if (record.kind !== LOG_EVENT_KIND || valueCarriesPrivateRegion(record.body)) continue;
    const type = record.body["event_type"];
    const payload = record.body["body"];
    const day = dayOf(record, record.body["timestamp"]);
    const at = momentOf(record, record.body["timestamp"]);
    const key = `rec:${record.id}`;
    if (type === NOTE_EVENT) {
      const text = textField(payload, "text");
      if (text !== null) entries.push({ key, day, kind: "note", text, order: record, at });
    } else if (type === DECISION_RECORD_EVENT || type === DECISION_RESOLVED_EVENT) {
      const text = textField(payload, type === DECISION_RECORD_EVENT ? "chosen" : "choice");
      if (text === null) continue;
      const review = textField(payload, "review_date") ?? undefined;
      entries.push({
        key,
        day,
        kind: "decision",
        text,
        ...(review !== undefined ? { review } : {}),
        order: record,
        at,
      });
    }
  }
  for (const pref of prefs) {
    const retiredBy = humanRetirement(pref);
    if (retiredBy !== null) {
      const retiredAt = (retiredBy.body["fields"] as Record<string, unknown> | undefined)?.[
        "retired_at"
      ];
      entries.push({
        key: `retired:${pref.id}`,
        day: dayOf(retiredBy, retiredAt),
        kind: "retired",
        text: principleOf(pref)!,
        order: retiredBy,
        at: momentOf(retiredBy, retiredAt),
      });
      continue;
    }
    if (confirmedPreferences([pref]).length === 0) continue;
    // The record whose confirmation holds now (the status field's winner),
    // not the first that ever confirmed it: a rule confirmed, retired and
    // confirmed again is new on the day of the confirmation in force.
    const confirmedBy = pref.history.find((r) => r.id === pref.fieldWinners["status"]);
    if (confirmedBy === undefined) continue;
    const confirmedAt = (confirmedBy.body["fields"] as Record<string, unknown>)["confirmed_at"];
    entries.push({
      key: `rule:${pref.id}`,
      day: dayOf(confirmedBy, confirmedAt),
      kind: "rule",
      text: principleOf(pref)!,
      order: confirmedBy,
      at: momentOf(confirmedBy, confirmedAt),
    });
  }
  return entries;
}

/** The `decisions.md` page: every decision entry, newest first. */
export function decisionsPage(
  storeId: string,
  entries: ReadonlyArray<ViewEntry>,
  strings: ViewStrings,
): PageModel {
  const lines: PageLine[] = [idLine(storeId, VIEW_DECISIONS_PAGE), BLANK];
  lines.push({ key: "h:title", text: `# ${strings.decisionsTitle}` }, BLANK);
  lines.push({ key: "p:intro", text: strings.decisionsIntro }, BLANK);
  const decisions = entries
    .filter((e) => e.kind === "decision")
    .toSorted((a, b) => a.at - b.at || compareRecords(a.order, b.order))
    .toReversed();
  if (decisions.length === 0) lines.push({ key: "p:empty", text: strings.decisionsEmpty });
  for (const entry of decisions) {
    const review = entry.review !== undefined ? ` (${strings.reviewOn(entry.review)})` : "";
    lines.push({ key: entry.key, text: `- ${entry.day}: ${entry.text}${review}` });
  }
  return { page: VIEW_DECISIONS_PAGE, lines };
}

/** The history line text of one entry, by its kind. */
function historyLabel(strings: ViewStrings, entry: ViewEntry): string {
  switch (entry.kind) {
    case "decision":
      return strings.historyDecision(entry.text);
    case "rule":
      return strings.historyRule(entry.text);
    case "retired":
      return strings.historyRetired(entry.text);
    case "note":
      return entry.text;
  }
}

/** ISO 8601 week of a UTC day: its week-numbering year and week. */
export function isoWeek(day: string): { year: number; week: number } {
  const date = new Date(`${day}T00:00:00Z`);
  const weekday = (date.getUTCDay() + 6) % 7; // Monday 0
  const thursday = new Date(date.getTime() + (3 - weekday) * DAY_MS);
  const year = thursday.getUTCFullYear();
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Weekday = (jan4.getUTCDay() + 6) % 7;
  const week1Monday = jan4.getTime() - jan4Weekday * DAY_MS;
  const week = Math.floor((thursday.getTime() - week1Monday) / (7 * DAY_MS)) + 1;
  return { year, week };
}

/** Page path of the history week `year`-W`week`. */
export function historyPagePath(year: number, week: number): string {
  return `${VIEW_HISTORY_DIR}/${year}-W${String(week).padStart(2, "0")}${VIEW_PAGE_EXT}`;
}

/** One history page per ISO week that has entries. */
export function historyPages(
  storeId: string,
  entries: ReadonlyArray<ViewEntry>,
  strings: ViewStrings,
): PageModel[] {
  const weeks = new Map<string, { year: number; week: number; entries: ViewEntry[] }>();
  for (const entry of entries) {
    const { year, week } = isoWeek(entry.day);
    const path = historyPagePath(year, week);
    const bucket = weeks.get(path) ?? { year, week, entries: [] };
    bucket.entries.push(entry);
    weeks.set(path, bucket);
  }
  const pages: PageModel[] = [];
  for (const [path, bucket] of [...weeks].toSorted(([a], [b]) => compareCodeUnits(a, b))) {
    const lines: PageLine[] = [idLine(storeId, path), BLANK];
    lines.push({ key: "h:title", text: `# ${strings.historyTitle(bucket.year, bucket.week)}` });
    lines.push(BLANK, { key: "p:intro", text: strings.historyIntro });
    const days = bucket.entries.toSorted(
      (a, b) => compareCodeUnits(a.day, b.day) || a.at - b.at || compareRecords(a.order, b.order),
    );
    let current: string | null = null;
    for (const entry of days) {
      if (entry.day !== current) {
        current = entry.day;
        const weekday = strings.weekdays[(new Date(`${entry.day}T00:00:00Z`).getUTCDay() + 6) % 7];
        lines.push(
          BLANK,
          { key: `h:day:${entry.day}`, text: `## ${weekday}, ${entry.day}` },
          BLANK,
        );
      }
      lines.push({ key: entry.key, text: `- ${historyLabel(strings, entry)}` });
    }
    pages.push({ page: path, lines });
  }
  return pages;
}
