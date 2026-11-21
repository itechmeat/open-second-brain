/**
 * Bi-temporal validity of a fact (Belief lifecycle suite, A2,
 * t_3ba9c404): the `valid_from` / `valid_until` keys, the half-open
 * interval rule and the instant normaliser the `temporal-replace` writer
 * stores. Pure, with no writer import, so the readers (the claim graph,
 * the truth store, page lint, stale-dependency checks) depend on this
 * module rather than on the writer and its store routing.
 */

import { isoSecond } from "../time.ts";

// ----- Constants ------------------------------------------------------------

/** Frontmatter key: bi-temporal event-time start (inclusive). */
export const VALID_FROM_KEY = "valid_from";
/** Frontmatter key: bi-temporal event-time end (exclusive, half-open). */
export const VALID_UNTIL_KEY = "valid_until";
/** Date-only fact shape (whole-day validity). */
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Full ISO-8601 UTC instant shape. */
const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

// ----- Errors ---------------------------------------------------------------

/** Every failure path in this module raises this typed error. */
export class TemporalReplaceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TemporalReplaceError";
  }
}

// ----- Point-in-time evaluation ---------------------------------------------

/** A bi-temporal fact's validity bounds, as stored in frontmatter. */
export interface ValidityBounds {
  readonly valid_from?: unknown;
  readonly valid_until?: unknown;
}

/**
 * Convert a stored boundary to a UTC-milliseconds instant. A date-only
 * boundary (`YYYY-MM-DD`) resolves to that day's `T00:00:00Z` start so
 * whole-day facts evaluate consistently against any probe within the
 * day. Returns `null` for an absent or unparseable boundary.
 */
export function boundaryToMs(value: unknown): number | null {
  if (typeof value !== "string" || value === "") return null;
  const iso = DATE_ONLY_RE.test(value) ? `${value}T00:00:00Z` : value;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Evaluate whether a fact is valid at `probeMs` under half-open
 * `[valid_from, valid_until)` semantics. An absent bound is unbounded on
 * that side. `valid_from` is inclusive, `valid_until` exclusive - so two
 * facts sharing a boundary T (predecessor `valid_until = T`, successor
 * `valid_from = T`) never overlap at T and leave no gap around it.
 */
export function isValidAt(fact: ValidityBounds, probeMs: number): boolean {
  const from = boundaryToMs(fact.valid_from);
  const until = boundaryToMs(fact.valid_until);
  if (from !== null && probeMs < from) return false;
  if (until !== null && probeMs >= until) return false;
  return true;
}

// ----- Replacement ----------------------------------------------------------

interface NormalizedInstant {
  /** The exact string stored on disk (date-only preserved verbatim). */
  readonly stored: string;
}

/** Whether `YYYY-MM-DD` names a day the calendar has (no month 13, no 30 February). */
function isCalendarDay(day: string): boolean {
  const ms = Date.parse(`${day}T00:00:00Z`);
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === day;
}

export function normalizeInstant(at: string | Date): NormalizedInstant {
  if (at instanceof Date) {
    if (Number.isNaN(at.getTime())) {
      throw new TemporalReplaceError("temporalReplace: 'at' is an invalid Date");
    }
    return { stored: isoSecond(at) };
  }
  const value = at.trim();
  if (DATE_ONLY_RE.test(value)) {
    // A real calendar day, kept as spelled: `2026-13-01` or `2026-02-30`
    // would be stored, then read as no bound at all.
    if (!isCalendarDay(value)) {
      throw new TemporalReplaceError(`temporalReplace: 'at' is not a calendar date: ${at}`);
    }
    return { stored: value };
  }
  if (ISO_INSTANT_RE.test(value)) {
    const ms = Date.parse(value);
    if (Number.isNaN(ms) || !isCalendarDay(value.slice(0, 10))) {
      throw new TemporalReplaceError(`temporalReplace: 'at' is not a valid instant: ${at}`);
    }
    // Canonicalize sub-second precision away to the log/heading shape.
    return { stored: isoSecond(new Date(ms)) };
  }
  throw new TemporalReplaceError(
    `temporalReplace: 'at' must be an ISO-8601 UTC instant or a YYYY-MM-DD date; got ${JSON.stringify(at)}`,
  );
}
