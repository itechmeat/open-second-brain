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

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

import { atomicWriteFileSync } from "../fs-atomic.ts";
import { slugify } from "../vault.ts";
import { parseFrontmatter } from "../vault.ts";
import { obligationPath, obligationsArchiveDir, obligationsDir, validateIsoDate } from "./paths.ts";
import { isoDate, isoSecond } from "./time.ts";

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
}

export interface CompleteObligationInput {
  readonly slug: string;
  /** Completion date (`YYYY-MM-DD`); defaults to today (UTC). */
  readonly date?: string;
  readonly now?: Date;
}

export interface RemoveObligationResult {
  readonly slug: string;
  readonly archivePath: string;
}

export class ObligationError extends Error {}

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
  const path = obligationPath(vault, slug);
  if (!existsSync(path)) return null;
  const [meta, body] = parseFrontmatter(path);
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
  const title = input.title.trim();
  if (title.length === 0) throw new ObligationError("obligation title must not be empty");
  const cadence = parseCadence(input.cadence);
  const now = input.now ?? new Date();
  const today = isoDate(now);
  const anchor = input.anchor ? requireIsoDate(input.anchor, "anchor") : today;
  const slug = slugify(title);
  if (existsSync(obligationPath(vault, slug))) {
    throw new ObligationError(`obligation already exists: ${slug} (remove it first to recreate)`);
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
  mkdirSync(obligationsDir(vault), { recursive: true });
  const path = obligationPath(vault, slug);
  atomicWriteFileSync(path, render(page));
  return Object.freeze({ ...page, path });
}

/** Record a completion and advance next-due by one cadence interval. */
export function completeObligation(vault: string, input: CompleteObligationInput): ObligationPage {
  const slug = slugify(input.slug);
  const prior = parsePage(vault, slug);
  if (prior === null) throw new ObligationError(`no obligation: ${slug}`);
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
  atomicWriteFileSync(prior.path, render(page));
  return Object.freeze({ ...page, path: prior.path });
}

/** One obligation, or null. */
export function showObligation(vault: string, slug: string): ObligationPage | null {
  return parsePage(vault, slugify(slug));
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
  if (!existsSync(dir)) return [];
  const today = isoDate(options.now ?? new Date());
  const todayMs = Date.parse(`${today}T00:00:00Z`);
  const out: ObligationListItem[] = [];
  for (const name of readdirSync(dir)) {
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
export function removeObligation(vault: string, slug: string): RemoveObligationResult {
  const normalized = slugify(slug);
  const activePath = obligationPath(vault, normalized);
  if (!existsSync(activePath)) throw new ObligationError(`no obligation: ${normalized}`);
  const archiveDir = obligationsArchiveDir(vault);
  mkdirSync(archiveDir, { recursive: true });
  let archivePath = join(archiveDir, `${normalized}.md`);
  for (let suffix = 2; existsSync(archivePath); suffix++) {
    archivePath = join(archiveDir, `${normalized}-${suffix}.md`);
  }
  try {
    renameSync(activePath, archivePath);
  } catch {
    atomicWriteFileSync(archivePath, readFileSync(activePath, "utf8"));
    rmSync(activePath, { force: true });
  }
  return Object.freeze({ slug: normalized, archivePath });
}
