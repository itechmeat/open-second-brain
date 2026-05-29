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
 *   2. ISO-8601 duration `P[n]Y[n]M[n]W[n]D` (relative to `now`)
 *        -> { valid_from: now, valid_until: now + duration }
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

  const duration = matchDuration(text, opts.now);
  if (duration) return duration;

  const lone = LONE_DATE_RE.exec(text);
  if (lone) {
    return { valid_from: `${lone[1]}T00:00:00Z` };
  }

  return {};
}

function matchDuration(text: string, now: Date): TemporalConstraints | null {
  const m = DURATION_RE.exec(text);
  if (!m) return null;
  const years = m[1] ? Number(m[1]) : 0;
  const months = m[2] ? Number(m[2]) : 0;
  const weeks = m[3] ? Number(m[3]) : 0;
  const days = m[4] ? Number(m[4]) : 0;
  // Reject a bare `P` (no component matched).
  if (years === 0 && months === 0 && weeks === 0 && days === 0) return null;

  const end = new Date(now.getTime());
  if (years) end.setUTCFullYear(end.getUTCFullYear() + years);
  if (months) end.setUTCMonth(end.getUTCMonth() + months);
  const extraDays = weeks * 7 + days;
  if (extraDays) end.setUTCDate(end.getUTCDate() + extraDays);

  return { valid_from: isoSecond(now), valid_until: isoSecond(end) };
}
