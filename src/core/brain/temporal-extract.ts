/**
 * Temporal extraction from signal text (Brain lifecycle suite,
 * Feature 5).
 *
 * A pure, deterministic, LANGUAGE-AGNOSTIC parser. It recognises only
 * formal ISO-8601 tokens, never localized month/day names or
 * natural-language phrases in any specific language - so a vault in any
 * language behaves identically and we never bake a per-language word
 * list into the engine. The extracted constraints map onto the existing
 * bi-temporal `valid_from` / `valid_until` preference fields.
 *
 * Recognised forms, in precedence order (first match wins):
 *
 *   1. ISO interval `YYYY-MM-DD/YYYY-MM-DD`
 *        -> { valid_from: <A>T00:00:00Z, valid_until: <B>T00:00:00Z }
 *   2. ISO-8601 duration `P[n]Y[n]M[n]W[n]D`, anchored to a co-occurring
 *      lone ISO date when present, else to `now`
 *        -> { valid_from: <anchor>, valid_until: <anchor> + duration }
 *   3. Lone ISO date `YYYY-MM-DD`
 *        -> { valid_from: <date>T00:00:00Z }
 *
 * No ISO token -> `{}`. The function never throws.
 */

import { isoSecond } from "./time.ts";

export interface TemporalConstraints {
  readonly valid_from?: string;
  readonly valid_until?: string;
}

const ISO_DATE = String.raw`\d{4}-\d{2}-\d{2}`;
const INTERVAL_RE = new RegExp(`\\b(${ISO_DATE})/(${ISO_DATE})\\b`);
const LONE_DATE_RE = new RegExp(`\\b(${ISO_DATE})\\b`);
// ISO-8601 duration, date components only (time part intentionally
// unsupported - signals express coarse validity windows, not seconds).
// At least one component is required; the all-empty `P` is rejected by
// the post-match guard.
const DURATION_RE = /\bP(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?\b/;

/**
 * Extract bi-temporal constraints from `text` against the injected
 * clock. Returns `{}` when no ISO token is present.
 */
export function extractTemporalConstraints(
  text: string,
  opts: { now: Date },
): TemporalConstraints {
  if (typeof text !== "string" || text.length === 0) return {};

  const interval = INTERVAL_RE.exec(text);
  if (interval) {
    return {
      valid_from: `${interval[1]}T00:00:00Z`,
      valid_until: `${interval[2]}T00:00:00Z`,
    };
  }

  const lone = LONE_DATE_RE.exec(text);
  const duration = parseDuration(text);
  if (duration) {
    // Anchor the window to a co-occurring explicit start date when
    // present (so "from 2026-06-01 for P1Y" keeps June 1 as the start),
    // otherwise to `now`.
    if (lone) {
      const startIso = `${lone[1]}T00:00:00Z`;
      return {
        valid_from: startIso,
        valid_until: isoSecond(addDuration(new Date(startIso), duration)),
      };
    }
    return {
      valid_from: isoSecond(opts.now),
      valid_until: isoSecond(addDuration(opts.now, duration)),
    };
  }

  if (lone) {
    return { valid_from: `${lone[1]}T00:00:00Z` };
  }

  return {};
}

interface DurationParts {
  readonly years: number;
  readonly months: number;
  readonly weeks: number;
  readonly days: number;
}

/** Parse an ISO-8601 date-component duration, or null when none/bare `P`. */
function parseDuration(text: string): DurationParts | null {
  const m = DURATION_RE.exec(text);
  if (!m) return null;
  const years = m[1] ? Number(m[1]) : 0;
  const months = m[2] ? Number(m[2]) : 0;
  const weeks = m[3] ? Number(m[3]) : 0;
  const days = m[4] ? Number(m[4]) : 0;
  if (years === 0 && months === 0 && weeks === 0 && days === 0) return null;
  return { years, months, weeks, days };
}

/** Add a duration to an anchor instant via UTC calendar arithmetic. */
function addDuration(anchor: Date, d: DurationParts): Date {
  const end = new Date(anchor.getTime());
  if (d.years) end.setUTCFullYear(end.getUTCFullYear() + d.years);
  if (d.months) end.setUTCMonth(end.getUTCMonth() + d.months);
  const extraDays = d.weeks * 7 + d.days;
  if (extraDays) end.setUTCDate(end.getUTCDate() + extraDays);
  return end;
}
