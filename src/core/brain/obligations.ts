/**
 * Recurring obligations as first-class Brain entities (upstream parity
 * with obsidian-second-brain `/obsidian-recurring`, t_f7b82ba4).
 *
 * A recurring obligation is a periodic commitment - a weekly review, a
 * monthly report, a quarterly backup audit - that the operator wants
 * tracked with a cadence and a deterministically computed next-due
 * date. Each obligation is a Markdown page at
 * `Brain/obligations/<slug>.md`: operator-readable in Obsidian, greppable,
 * versionable. The kernel never calls a model - cadence arithmetic is
 * pure calendar math over UTC dates, so the same inputs always yield the
 * same next-due date.
 *
 *   - `add`    creates the page; `next_due` starts at the anchor date.
 *   - `done`   records a completion and advances `next_due` by one cadence
 *              interval from the completion date.
 *   - `list`   reads every page, sorted by next-due, with an overdue flag.
 *   - `show`   reads one page.
 *   - `remove` retires the page into `Brain/obligations/archive/`.
 */

import { createHash } from "node:crypto";
import { join } from "node:path";

import {
  claimedTitleSlot,
  identitySuffixedStemsOf,
  IDENTITY_SUFFIX_HEX_LENGTH,
  isIdentitySuffixedStem,
  locateTitledPage,
  titleIdentity,
  titleSlug,
  type TitledPageLocation,
  type TitledPageLookup,
} from "../vault.ts";
import { BRAIN_OBLIGATIONS_REL } from "./path-constants.ts";
import { obligationPath, obligationsArchiveDir, obligationsDir, validateIsoDate } from "./paths.ts";
import { isoDate, isoSecond } from "./time.ts";
import {
  assertLaneWrite,
  acquireLaneLock,
  lanePageExists,
  lanePagesInStore,
  laneStems,
  listLaneFiles,
  moveLanePage,
  parseLanePage,
  readLaneFile,
  removeLanePage,
  writeLaneText,
} from "../store/lane-pages.ts";

/**
 * Supported cadences. Day-based cadences add a fixed number of days;
 * calendar cadences (`monthly`/`quarterly`/`yearly`) add whole months
 * with end-of-month clamping. `every-<N>-days` covers any custom
 * day interval (N ≥ 1).
 */
export type ObligationCadence =
  | "daily"
  | "weekly"
  | "biweekly"
  | "monthly"
  | "quarterly"
  | "yearly"
  | `every-${number}-days`;

const FIXED_CADENCE_DAYS: Record<string, number> = {
  daily: 1,
  weekly: 7,
  biweekly: 14,
};

const CALENDAR_CADENCE_MONTHS: Record<string, number> = {
  monthly: 1,
  quarterly: 3,
  yearly: 12,
};

const EVERY_N_DAYS_RE = /^every-(\d+)-days$/u;
const HISTORY_HEADER = "## Completions";

export interface ObligationPage {
  readonly slug: string;
  readonly title: string;
  readonly cadence: ObligationCadence;
  readonly createdAt: string;
  /** First due date; `next_due` derives from completions or this. */
  readonly anchor: string;
  /** Most recent completion date, or null if never completed. */
  readonly lastDone: string | null;
  /** Deterministically computed next due date (`YYYY-MM-DD`). */
  readonly nextDue: string;
  readonly agent: string;
  /** Completion dates, newest first. */
  readonly completions: ReadonlyArray<string>;
  readonly notes: string;
  readonly path: string;
}

export interface AddObligationInput {
  readonly title: string;
  readonly cadence: string;
  readonly agent: string;
  /** First due date (`YYYY-MM-DD`); defaults to today (UTC). */
  readonly anchor?: string;
  readonly notes?: string;
  readonly now?: Date;
  /**
   * The caller's reach ({@link ObligationReadable}). A page an older
   * release stored under the title's Latin-only slug that the caller may
   * not read is not this title's duplicate: the obligation is written
   * under the title's own slug, as over an absent page. A page at that
   * slug is refused whoever may read it, because adding would replace it.
   */
  readonly readable?: ObligationReadable;
  /**
   * The slot {@link obligationSlotPlan} chose for this title: its own slug,
   * or the identity-suffixed slot a derived obligation takes when another
   * obligation holds that slug. Any other value is refused, and so is a
   * slot a page occupies.
   */
  readonly slot?: string;
}

/**
 * Whether the caller may read the page at a vault-relative path. A page
 * it may not read is resolved exactly as an absent one, and is never
 * parsed. Absent, every page may be read.
 */
export type ObligationReadable = (rel: string) => boolean;

/** The vault-relative page of an obligation file stem, as listed (no slug fold). */
export function obligationStemRel(stem: string): string {
  return `${BRAIN_OBLIGATIONS_REL}/${stem}.md`;
}

export interface CompleteObligationInput {
  /** A title or slug, resolved here, or a target resolved once by the caller. */
  readonly slug: string | ObligationTarget;
  /** Completion date (`YYYY-MM-DD`); defaults to today (UTC). */
  readonly date?: string;
  readonly now?: Date;
}

export interface RemoveObligationResult {
  readonly slug: string;
  readonly archivePath: string;
}

export class ObligationError extends Error {}

/** The refusal for a slug that names no active obligation page. */
export function noObligationError(slug: string): ObligationError {
  return new ObligationError(`no obligation: ${slug}`);
}

/** The refusal for a page that stores an obligation's title but whose cadence cannot be read. */
export function unreadableObligationError(slug: string): ObligationError {
  return new ObligationError(
    `obligation ${slug} cannot be read (its cadence is invalid): fix or remove it first`,
  );
}

/** Validate and narrow an arbitrary cadence string. */
export function parseCadence(raw: string): ObligationCadence {
  const value = raw.trim().toLowerCase();
  if (value in FIXED_CADENCE_DAYS || value in CALENDAR_CADENCE_MONTHS) {
    return value as ObligationCadence;
  }
  const match = EVERY_N_DAYS_RE.exec(value);
  if (match) {
    const n = Number.parseInt(match[1]!, 10);
    if (n >= 1) return `every-${n}-days`;
  }
  throw new ObligationError(
    `unknown cadence: ${JSON.stringify(raw)} (expected daily, weekly, biweekly, monthly, quarterly, yearly, or every-<N>-days)`,
  );
}

function requireIsoDate(value: string, label: string): string {
  try {
    validateIsoDate(value);
  } catch {
    throw new ObligationError(`${label} is not a valid calendar date: ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * Soft-parse an ISO date read from disk: return it when it is a valid
 * calendar date, otherwise return the empty string. Unlike
 * {@link requireIsoDate} this never throws, because a frontmatter value
 * edited by hand should not crash listing/rendering of the whole page.
 */
function parseIsoDate(value: unknown): string {
  if (typeof value !== "string") return "";
  try {
    validateIsoDate(value);
    return value;
  } catch {
    return "";
  }
}

function lastDayOfMonth(year: number, monthZeroBased: number): number {
  // Day 0 of the next month is the last day of this month.
  return new Date(Date.UTC(year, monthZeroBased + 1, 0)).getUTCDate();
}

function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split("-").map((part) => Number.parseInt(part, 10)) as [
    number,
    number,
    number,
  ];
  const targetIndex = m - 1 + months;
  const targetYear = y + Math.floor(targetIndex / 12);
  const targetMonth = ((targetIndex % 12) + 12) % 12;
  const clampedDay = Math.min(d, lastDayOfMonth(targetYear, targetMonth));
  const out = new Date(Date.UTC(targetYear, targetMonth, clampedDay));
  return isoDate(out);
}

function addDays(date: string, days: number): string {
  const ms = Date.parse(`${date}T00:00:00Z`) + days * 24 * 3600 * 1000;
  return isoDate(new Date(ms));
}

/**
 * Advance a date by exactly one cadence interval. Pure calendar math:
 * deterministic for a given (cadence, from) pair.
 */
export function nextDueDate(cadence: ObligationCadence, from: string): string {
  requireIsoDate(from, "from");
  if (cadence in FIXED_CADENCE_DAYS) return addDays(from, FIXED_CADENCE_DAYS[cadence]!);
  if (cadence in CALENDAR_CADENCE_MONTHS) return addMonths(from, CALENDAR_CADENCE_MONTHS[cadence]!);
  const match = EVERY_N_DAYS_RE.exec(cadence);
  if (match) return addDays(from, Number.parseInt(match[1]!, 10));
  throw new ObligationError(`unknown cadence: ${JSON.stringify(cadence)}`);
}

function render(page: Omit<ObligationPage, "path">): string {
  const completions =
    page.completions.length === 0
      ? ""
      : `\n${HISTORY_HEADER}\n\n${page.completions.map((c) => `- ${c}`).join("\n")}\n`;
  const lines = [
    "---",
    `title: ${JSON.stringify(page.title)}`,
    `cadence: ${page.cadence}`,
    `created_at: ${page.createdAt}`,
    `anchor: ${page.anchor}`,
    `last_done: ${page.lastDone ?? ""}`,
    `next_due: ${page.nextDue}`,
    `agent: ${JSON.stringify(page.agent)}`,
    "---",
    "",
    page.notes,
    completions,
  ];
  return lines.join("\n");
}

function parsePage(vault: string, slug: string): ObligationPage | null {
  return readEntry(vault, slug)?.page ?? null;
}

/**
 * The page stored at `stem`, read once: its stored title, and the
 * obligation it holds, or null when its cadence cannot be read (such a
 * page is left out of `list`, `show` and `done`, yet `remove` still
 * archives it). Null when there is no page at `stem`.
 */
interface ObligationEntry {
  readonly title: string;
  readonly page: ObligationPage | null;
}

function obligationFingerprint(entry: ObligationEntry): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        title: titleIdentity(entry.title),
        createdAt: entry.page?.createdAt ?? null,
        cadence: entry.page?.cadence ?? null,
        anchor: entry.page?.anchor ?? null,
        agent: entry.page?.agent ?? null,
      }),
    )
    .digest("hex");
}

function readEntry(vault: string, slug: string): ObligationEntry | null {
  const path = obligationPath(vault, slug);
  if (!lanePageExists(vault, path)) return null;
  const [meta, body] = parseLanePage(vault, path);
  const title = typeof meta["title"] === "string" ? meta["title"] : slug;
  return { title, page: pageOf(slug, path, meta, body) };
}

function pageOf(
  slug: string,
  path: string,
  meta: Record<string, unknown>,
  body: string,
): ObligationPage | null {
  const cadenceRaw = typeof meta["cadence"] === "string" ? meta["cadence"] : "";
  let cadence: ObligationCadence;
  try {
    cadence = parseCadence(cadenceRaw);
  } catch {
    return null;
  }
  const headerMatch = /^## Completions$/mu.exec(body);
  const headerIndex = headerMatch?.index ?? -1;
  const notes = (headerIndex < 0 ? body : body.slice(0, headerIndex)).trim();
  const completions: string[] = [];
  if (headerIndex >= 0) {
    for (const line of body.slice(headerIndex + HISTORY_HEADER.length).split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("- ")) completions.push(trimmed.slice(2));
    }
  }
  const lastDoneRaw = typeof meta["last_done"] === "string" ? meta["last_done"].trim() : "";
  // Full calendar validation (not just format): "2024-02-30" would
  // otherwise pass a regex and then yield NaN in the due/overdue math.
  const anchor = parseIsoDate(meta["anchor"]);
  const nextDue = parseIsoDate(meta["next_due"]) || anchor;
  return Object.freeze({
    slug,
    title: typeof meta["title"] === "string" ? meta["title"] : slug,
    cadence,
    createdAt: typeof meta["created_at"] === "string" ? meta["created_at"] : "",
    anchor,
    lastDone: lastDoneRaw.length > 0 ? lastDoneRaw : null,
    nextDue,
    agent: typeof meta["agent"] === "string" ? meta["agent"] : "",
    completions: Object.freeze(completions),
    notes,
    path,
  });
}

/** Create a recurring obligation page. */
export function addObligation(vault: string, input: AddObligationInput): ObligationPage {
  // Vault-identity write guard (context-integrity-gates, Unit J).
  assertLaneWrite(vault);
  const title = input.title.trim();
  if (title.length === 0) throw new ObligationError("obligation title must not be empty");
  const cadence = parseCadence(input.cadence);
  const now = input.now ?? new Date();
  const today = isoDate(now);
  const anchor = input.anchor ? requireIsoDate(input.anchor, "anchor") : today;
  let slug = titleSlug(title);
  if (input.slot !== undefined && input.slot !== slug) {
    // A planned identity-suffixed slot: refused unless it is one of this
    // title's own and nothing sits there.
    const own = suffixedObligationSlots(title).includes(input.slot);
    if (
      !own ||
      lanePageExists(vault, obligationPath(vault, input.slot)) ||
      exactTitleReservation(vault, input.slot, input.readable)
    ) {
      throw new ObligationError(`obligation slot is not free for this title: ${input.slot}`);
    }
    const found = locateEntry(vault, title, input.readable);
    if (found.page !== null && titleIdentity(found.page.title) === titleIdentity(title)) {
      throw new ObligationError(
        `obligation already exists: ${found.slug} (remove it first to recreate)`,
      );
    }
    slug = input.slot;
  } else {
    // The same title an older release stored under its Latin-only slug is
    // the same obligation: refused as it was then, not opened a second time.
    const existing = existingObligationSlug(vault, title, input.readable);
    if (existing !== null) {
      throw new ObligationError(
        `obligation already exists: ${existing} (remove it first to recreate)`,
      );
    }
  }
  const page = {
    slug,
    title,
    cadence,
    createdAt: isoSecond(now),
    anchor,
    lastDone: null,
    // The first occurrence is the anchor itself.
    nextDue: anchor,
    agent: input.agent,
    completions: Object.freeze([] as string[]),
    notes: (input.notes ?? "").trim(),
  };
  const path = obligationPath(vault, slug);
  const handle = acquireLaneLock(vault, path);
  try {
    assertLaneWrite(vault);
    if (lanePageExists(vault, path)) {
      if (input.slot === undefined) {
        throw new ObligationError(
          `obligation already exists: ${slug} (remove it first to recreate)`,
        );
      }
      throw new ObligationError(`obligation slot is not free for this title: ${slug}`);
    }
    if (input.slot !== undefined && exactTitleReservation(vault, input.slot, input.readable)) {
      throw new ObligationError(`obligation slot is not free for this title: ${slug}`);
    }
    if (input.slot === undefined) {
      const existing = existingObligationSlug(vault, title, input.readable);
      if (existing !== null) {
        throw new ObligationError(
          `obligation already exists: ${existing} (remove it first to recreate)`,
        );
      }
    }
    const found = locateEntry(vault, title, input.readable);
    if (found.page !== null && titleIdentity(found.page.title) === titleIdentity(title)) {
      throw new ObligationError(
        `obligation already exists: ${found.slug} (remove it first to recreate)`,
      );
    }
    writeLaneText(vault, path, render(page));
  } finally {
    handle.release();
  }
  return Object.freeze({ ...page, path });
}

/**
 * The obligation page a caller's title or listed slug names, at the
 * caller's reach ({@link locateTitledPage}). A listed slug names the page
 * stored at it, a bare Windows device name an older release wrote (`nul`)
 * included. A title names only a page that stores exactly that title: at
 * its {@link titleSlug}, or at the Latin-only slug an older release gave
 * it. So a title that only keys like a stored one (other punctuation,
 * other case) reaches nothing, and a refusal names the value's own slug.
 * A page the caller may not read is never parsed and answers like an
 * absent one.
 */
function locateEntry(
  vault: string,
  value: string,
  readable?: ObligationReadable,
): TitledPageLocation<ObligationEntry> {
  return locateTitledPage(value, obligationLookup(vault, readable));
}

function obligationLookup(
  vault: string,
  readable: ObligationReadable | undefined,
): TitledPageLookup<ObligationEntry> {
  return {
    read: (stem) =>
      readable === undefined || readable(obligationStemRel(stem)) ? readEntry(vault, stem) : null,
    titleOf: (entry) => entry.title,
    stems: () => laneStems(vault, obligationsDir(vault), ""),
    // A derived obligation (a decision's review) whose slot another
    // obligation holds is filed at its identity-suffixed slot.
    more: (bases) => identitySuffixedStemsOf(laneStems(vault, obligationsDir(vault), ""), bases),
    issued: isIdentitySuffixedStem,
  };
}

/**
 * The obligation page a caller's title or slug resolved to, once. A caller
 * that checks something about the page before it acts (the MCP reach
 * check) passes this to the operation, so the page it checked is the page
 * it acts on even if another writer adds a page under the preferred slug
 * in between.
 */
export interface ObligationTarget {
  /**
   * The page's file stem under `Brain/obligations/`, or the value's own
   * slug when no page matched (what a refusal names).
   */
  readonly stem: string;
  /**
   * False when no page matched: the operation then answers as for an
   * absent page even if a page with another title sits at `stem`.
   */
  readonly found: boolean;
  /** Stable record identity checked at resolution; later operations revalidate it. */
  readonly fingerprint: string | null;
  readonly readable?: ObligationReadable;
}

/**
 * Resolve `value` to the page it names now ({@link locateEntry}), at
 * the caller's reach: a withheld page resolves to the stem an absent one
 * would, so an operation on the target refuses it with the absent page's
 * error.
 */
export function resolveObligationTarget(
  vault: string,
  value: string,
  readable?: ObligationReadable,
): ObligationTarget {
  const located = locateEntry(vault, value, readable);
  const found = located.page !== null;
  return Object.freeze({
    stem: located.slug,
    found,
    fingerprint: found ? obligationFingerprint(located.page!) : null,
    ...(readable ? { readable } : {}),
  });
}

/**
 * The page a title, a listed slug or a resolved target names now, with the
 * stem a refusal names when there is none.
 */
function targetEntry(
  vault: string,
  value: string | ObligationTarget,
): TitledPageLocation<ObligationEntry> {
  if (typeof value === "string") return locateEntry(vault, value);
  if (!value.found || value.readable?.(obligationStemRel(value.stem)) === false) {
    return { slug: value.stem, page: null };
  }
  const page = readEntry(vault, value.stem);
  const fingerprint = page === null ? null : obligationFingerprint(page);
  return { slug: value.stem, page: fingerprint === value.fingerprint ? page : null };
}

/** {@link targetEntry}'s obligation, null when its page is absent or unreadable as one. */
function targetPage(
  vault: string,
  value: string | ObligationTarget,
): TitledPageLocation<ObligationPage> {
  const { slug, page } = targetEntry(vault, value);
  return { slug, page: page?.page ?? null };
}

/** Record a completion and advance next-due by one cadence interval. */
export function completeObligation(vault: string, input: CompleteObligationInput): ObligationPage {
  // Vault-identity write guard (context-integrity-gates, Unit J).
  assertLaneWrite(vault);
  const target =
    typeof input.slug === "string" ? resolveObligationTarget(vault, input.slug) : input.slug;
  const lockPath = obligationPath(vault, target.stem);
  const handle = acquireLaneLock(vault, lockPath);
  try {
    assertLaneWrite(vault);
    const { slug, page: prior } = targetPage(vault, target);
    if (prior === null) throw noObligationError(slug);
    const now = input.now ?? new Date();
    const date = input.date ? requireIsoDate(input.date, "date") : isoDate(now);
    const page = {
      slug: prior.slug,
      title: prior.title,
      cadence: prior.cadence,
      createdAt: prior.createdAt,
      anchor: prior.anchor,
      lastDone: date,
      nextDue: nextDueDate(prior.cadence, date),
      agent: prior.agent,
      completions: Object.freeze([date, ...prior.completions]),
      notes: prior.notes,
    };
    writeLaneText(vault, prior.path, render(page));
    return Object.freeze({ ...page, path: prior.path });
  } finally {
    handle.release();
  }
}

/** One obligation, or null. */
export function showObligation(
  vault: string,
  slug: string | ObligationTarget,
): ObligationPage | null {
  return targetPage(vault, slug).page;
}

/**
 * The slug of the active obligation page adding `title` would collide
 * with, or `null` when there is none: the page at its {@link titleSlug},
 * whatever title it holds and whoever may read it (adding would replace
 * it), a page the caller may read that stores exactly this title under
 * the Latin-only slug an older release gave it, or a slug another
 * obligation the caller may read claims ({@link claimedTitleSlot}), so a
 * lookup by title and by listed slug keep naming one record each. Lets
 * callers (e.g. the inbox-drain pass) detect a collision structurally
 * before attempting a create that {@link addObligation} would reject.
 */
export function existingObligationSlug(
  vault: string,
  title: string,
  readable?: ObligationReadable,
): string | null {
  const slug = titleSlug(title.trim());
  if (lanePageExists(vault, obligationPath(vault, slug))) return slug;
  const located = locateEntry(vault, title, readable);
  if (located.page !== null) return located.slug;
  return claimedTitleSlot(title, obligationLookup(vault, readable));
}

/** How many identity-suffixed slots a derived obligation tries beside a held slug. */
const SUFFIXED_SLOT_ATTEMPTS = 4;

/**
 * The identity-suffixed slots of `title`, in the order a derived
 * obligation tries them: `<slug>-<6 hex>` of the title's identity, then of
 * the identity with a counter, should another obligation hold the first.
 */
function suffixedObligationSlots(title: string): string[] {
  const base = titleSlug(title.trim());
  const identity = titleIdentity(title.trim());
  const out: string[] = [];
  for (let i = 0; i < SUFFIXED_SLOT_ATTEMPTS; i++) {
    const hex = createHash("sha256")
      .update(i === 0 ? identity : `${identity}\u0000${i}`, "utf8")
      .digest("hex")
      .slice(0, IDENTITY_SUFFIX_HEX_LENGTH);
    out.push(`${base}-${hex}`);
  }
  return out;
}

/** Whether a readable obligation title already reserves this listed stem. */
function exactTitleReservation(
  vault: string,
  stem: string,
  readable?: ObligationReadable,
): boolean {
  const page = locateEntry(vault, stem, readable).page;
  return page !== null && titleIdentity(page.title) === titleIdentity(stem);
}

/**
 * Where a derived obligation titled `title` (a decision's review) is
 * filed: the obligation that stores exactly this title, wherever it is
 * (`existing: true`, reused); else its own slug when nothing holds it;
 * else, when another obligation holds that slug (a page there that stores
 * another title, an older release's leftover or a peer's keying-alike
 * one, or a slot another obligation's exact title claims), the first free
 * identity-suffixed slot. So a leftover never blocks the derived record and
 * is never answered as it; both stay reachable by their titles and slugs.
 * Null when every slot is held, which a caller refuses. Throws
 * an {@link ObligationError} when the obligation that stores the
 * title cannot be read as one (its cadence): it is neither reused nor
 * doubled by a second page under the same title.
 */
export function obligationSlotPlan(
  vault: string,
  title: string,
  readable?: ObligationReadable,
): { readonly slug: string; readonly existing: boolean } | null {
  const located = locateEntry(vault, title, readable);
  if (located.page !== null && titleIdentity(located.page.title) === titleIdentity(title)) {
    // Reused only when it is an obligation `list`, `show` and `done` can
    // act on: a page that stores the title but whose cadence cannot be read
    // would answer a decision's review that never comes due.
    if (located.page.page === null) throw unreadableObligationError(located.slug);
    return { slug: located.slug, existing: true };
  }
  if (existingObligationSlug(vault, title, readable) === null) {
    return { slug: titleSlug(title.trim()), existing: false };
  }
  for (const slot of suffixedObligationSlots(title)) {
    if (
      !lanePageExists(vault, obligationPath(vault, slot)) &&
      !exactTitleReservation(vault, slot, readable)
    ) {
      return { slug: slot, existing: false };
    }
  }
  return null;
}

/** True when an active obligation page already exists for `title` ({@link existingObligationSlug}). */
export function obligationExists(vault: string, title: string): boolean {
  return existingObligationSlug(vault, title) !== null;
}

export interface ObligationListItem extends ObligationPage {
  /** True when next-due is strictly before today (UTC). */
  readonly overdue: boolean;
  /** Whole days until next-due; negative when overdue. */
  readonly daysUntilDue: number;
}

/** Active obligations sorted by next-due (earliest first), then slug. */
export function listObligations(
  vault: string,
  options: { now?: Date; overdueOnly?: boolean } = {},
): ObligationListItem[] {
  const dir = obligationsDir(vault);
  if (!lanePageExists(vault, dir)) return [];
  const today = isoDate(options.now ?? new Date());
  const todayMs = Date.parse(`${today}T00:00:00Z`);
  const out: ObligationListItem[] = [];
  for (const name of listLaneFiles(vault, dir, "")) {
    if (!name.endsWith(".md")) continue;
    const page = parsePage(vault, name.replace(/\.md$/u, ""));
    if (page === null) continue;
    const dueMs = Date.parse(`${page.nextDue}T00:00:00Z`);
    const daysUntilDue = Number.isNaN(dueMs)
      ? 0
      : Math.round((dueMs - todayMs) / (24 * 3600 * 1000));
    const overdue = !Number.isNaN(dueMs) && dueMs < todayMs;
    if (options.overdueOnly && !overdue) continue;
    out.push(Object.freeze({ ...page, overdue, daysUntilDue }));
  }
  return out.toSorted((a, b) => {
    if (a.nextDue !== b.nextDue) return a.nextDue < b.nextDue ? -1 : 1;
    return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
  });
}

/** Retire an obligation into Brain/obligations/archive/. */
export function removeObligation(
  vault: string,
  slug: string | ObligationTarget,
): RemoveObligationResult {
  // Vault-identity write guard (context-integrity-gates, Unit J).
  assertLaneWrite(vault);
  const target = typeof slug === "string" ? resolveObligationTarget(vault, slug) : slug;
  const activePath = obligationPath(vault, target.stem);
  const handle = acquireLaneLock(vault, activePath);
  try {
    assertLaneWrite(vault);
    const { slug: normalized, page } = targetEntry(vault, target);
    if (page === null) throw noObligationError(normalized);
    const archiveDir = obligationsArchiveDir(vault);
    let archivePath = join(archiveDir, `${normalized}.md`);
    for (let suffix = 2; lanePageExists(vault, archivePath); suffix++) {
      archivePath = join(archiveDir, `${normalized}-${suffix}.md`);
    }
    try {
      moveLanePage(vault, activePath, archivePath);
    } catch (err) {
      // The store move is already one operation (tombstone and new entry in
      // one write): retrying it as two would leave the obligation both
      // active and archived. Only a legacy rename falls back to copy and
      // remove, and a page gone since the check still throws.
      if (lanePagesInStore(vault)) throw err;
      writeLaneText(vault, archivePath, readLaneFile(vault, activePath));
      removeLanePage(vault, activePath);
    }
    return Object.freeze({ slug: normalized, archivePath });
  } finally {
    handle.release();
  }
}
