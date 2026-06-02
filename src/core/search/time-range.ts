/**
 * Time-aware recall (recall-trust-suite, Feature D): parse the `since` /
 * `until` query parameters into absolute unix-ms bounds.
 *
 * Accepted forms:
 *   - ISO datetime  — `2026-05-01T10:30:00Z` (passed through)
 *   - ISO date      — `2026-05-01` (day-start for `since`, day-end for
 *                     `until`, UTC, so a bare until-date includes its day)
 *   - relative      — `today`, `yesterday`, `last week`, `last month`
 *   - shorthand     — `<n>h` / `<n>d` / `<n>w` back from now
 *
 * Pure against an injected clock — same input and now, same output —
 * and deterministic across locales (no natural-language month names,
 * no local timezone: everything resolves in UTC). Unparseable input
 * throws `SearchError("INVALID_INPUT")` — explicit, never silent.
 */

import { SearchError } from "./types.ts";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

/** `since` snaps to range starts, `until` to range ends (inclusive). */
export type RangeEdge = "since" | "until";

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const SHORTHAND_RE = /^(\d{1,4})([hdw])$/;

function utcDayStart(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function invalid(raw: string): SearchError {
  return new SearchError(
    "INVALID_INPUT",
    `unparseable time point: ${JSON.stringify(raw)} ` +
      "(expected ISO date/datetime, 'today', 'yesterday', 'last week', 'last month', or <n>h/<n>d/<n>w)",
  );
}

/** Resolve one time point against the injected clock. Throws on junk. */
export function parseTimePoint(raw: string, nowMs: number, edge: RangeEdge): number {
  const text = raw.trim().toLowerCase();
  if (text === "") throw invalid(raw);

  if (text === "today") {
    const start = utcDayStart(nowMs);
    return edge === "since" ? start : nowMs;
  }
  if (text === "yesterday") {
    const start = utcDayStart(nowMs) - DAY_MS;
    return edge === "since" ? start : start + DAY_MS - 1;
  }
  if (text === "last week") return nowMs - WEEK_MS;
  if (text === "last month") return nowMs - 30 * DAY_MS;

  const shorthand = SHORTHAND_RE.exec(text);
  if (shorthand) {
    const n = Number(shorthand[1]);
    const unit = shorthand[2] === "h" ? HOUR_MS : shorthand[2] === "d" ? DAY_MS : WEEK_MS;
    return nowMs - n * unit;
  }

  const date = ISO_DATE_RE.exec(text);
  if (date) {
    const ms = Date.UTC(Number(date[1]), Number(date[2]) - 1, Number(date[3]));
    // Reject phantom dates like 2026-13-45 that Date.UTC would roll over.
    const check = new Date(ms);
    if (
      check.getUTCFullYear() !== Number(date[1]) ||
      check.getUTCMonth() !== Number(date[2]) - 1 ||
      check.getUTCDate() !== Number(date[3])
    ) {
      throw invalid(raw);
    }
    return edge === "since" ? ms : ms + DAY_MS - 1;
  }

  // Full ISO datetime (with time component). Require a "T" so bare
  // words never sneak through. Date.parse treats an offset-less
  // datetime as LOCAL time, which would make the resolved bounds
  // machine-dependent — normalise to UTC by appending "Z" when no
  // explicit designator is present, preserving the all-UTC contract.
  if (text.includes("t")) {
    const trimmed = raw.trim();
    const hasOffset = /(?:z|[+-]\d{2}:?\d{2})$/i.test(trimmed);
    const parsed = Date.parse(hasOffset ? trimmed : `${trimmed}Z`);
    if (Number.isFinite(parsed)) return parsed;
  }
  throw invalid(raw);
}

export interface ResolvedTimeRange {
  readonly sinceMs: number | null;
  readonly untilMs: number | null;
}

/** Resolve both edges and validate their order. Absent fields stay open. */
export function resolveTimeRange(
  opts: { readonly since?: string; readonly until?: string },
  nowMs: number,
): ResolvedTimeRange {
  const sinceMs = opts.since !== undefined ? parseTimePoint(opts.since, nowMs, "since") : null;
  const untilMs = opts.until !== undefined ? parseTimePoint(opts.until, nowMs, "until") : null;
  if (sinceMs !== null && untilMs !== null && sinceMs > untilMs) {
    throw new SearchError("INVALID_INPUT", "'since' must not be after 'until'");
  }
  return Object.freeze({ sinceMs, untilMs });
}

/** True when a document mtime (unix seconds) falls inside the range. */
export function mtimeInRange(mtimeSeconds: number, range: ResolvedTimeRange): boolean {
  const ms = mtimeSeconds * 1000;
  if (range.sinceMs !== null && ms < range.sinceMs) return false;
  if (range.untilMs !== null && ms > range.untilMs) return false;
  return true;
}
