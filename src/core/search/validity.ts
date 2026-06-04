/**
 * Event-time validity windows (Time-Aware Recall & Activation Suite,
 * t_b7191486).
 *
 * OSB stores bi-temporal frontmatter (`valid_from` / `valid_until` =
 * event time, file mtime = storage time) but time-range recall used to
 * filter on mtime alone - the classic storage-vs-event-time confusion
 * (the largest LongMemEval failure category). This module makes the
 * declared validity window the authority: a document passes a
 * `since`/`until` filter iff its validity interval INTERSECTS the query
 * window. Storage time is consulted only when no parseable event time
 * exists.
 *
 * Pure functions; the orchestrator (`search.ts`) supplies frontmatter
 * and the resolved range. Accepted value forms are bare ISO dates
 * (day-start for `valid_from`, day-end for `valid_until`, UTC) and ISO
 * datetimes - never relative phrases, which would make stored
 * frontmatter clock-dependent.
 */

import type { ResolvedTimeRange } from "./time-range.ts";
import { mtimeInRange } from "./time-range.ts";

export interface ValidityWindow {
  /** Event-time start (unix ms), or null when open / undeclared. */
  readonly validFromMs: number | null;
  /** Event-time end (unix ms, inclusive), or null when open / undeclared. */
  readonly validUntilMs: number | null;
  /** True when a declared value failed to parse (mtime fallback applies). */
  readonly invalid: boolean;
}

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Parse one frontmatter validity value. `edge` picks day-bound snapping. */
function parseValidityPoint(raw: unknown, edge: "from" | "until"): number | null {
  if (typeof raw !== "string") {
    // YAML may parse a bare date into a Date object.
    if (raw instanceof Date && Number.isFinite(raw.getTime())) return raw.getTime();
    return null;
  }
  const text = raw.trim();
  if (text === "") return null;
  const date = ISO_DATE_RE.exec(text);
  if (date) {
    const ms = Date.UTC(Number(date[1]), Number(date[2]) - 1, Number(date[3]));
    const check = new Date(ms);
    if (
      check.getUTCFullYear() !== Number(date[1]) ||
      check.getUTCMonth() !== Number(date[2]) - 1 ||
      check.getUTCDate() !== Number(date[3])
    ) {
      return null;
    }
    return edge === "from" ? ms : ms + DAY_MS - 1;
  }
  if (text.includes("T") || text.includes("t")) {
    const hasOffset = /(?:z|[+-]\d{2}:?\d{2})$/i.test(text);
    const parsed = Date.parse(hasOffset ? text : `${text}Z`);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/**
 * Read the validity window off a document's frontmatter. Returns null
 * when neither field is declared; `invalid: true` when a declared
 * value failed to parse (the caller falls back to mtime and warns).
 */
export function parseValidityWindow(meta: Record<string, unknown>): ValidityWindow | null {
  const hasFrom = meta["valid_from"] !== undefined && meta["valid_from"] !== null;
  const hasUntil = meta["valid_until"] !== undefined && meta["valid_until"] !== null;
  if (!hasFrom && !hasUntil) return null;
  const validFromMs = hasFrom ? parseValidityPoint(meta["valid_from"], "from") : null;
  const validUntilMs = hasUntil ? parseValidityPoint(meta["valid_until"], "until") : null;
  const invalid = (hasFrom && validFromMs === null) || (hasUntil && validUntilMs === null);
  return Object.freeze({ validFromMs, validUntilMs, invalid });
}

/**
 * Event-time range test: the validity interval must intersect the
 * query window. A null window (no validity fields) and an invalid one
 * both fall back to the mtime rule - never silently dropped.
 */
export function eventTimeInRange(
  window: ValidityWindow | null,
  mtimeSeconds: number,
  range: ResolvedTimeRange,
): boolean {
  if (window === null || window.invalid) return mtimeInRange(mtimeSeconds, range);
  // Interval overlap with open sides: the document's event span is
  // [validFrom, validUntil] (either side open), the query window is
  // [since, until] (either side open).
  if (range.untilMs !== null && window.validFromMs !== null && window.validFromMs > range.untilMs) {
    return false;
  }
  if (
    range.sinceMs !== null &&
    window.validUntilMs !== null &&
    window.validUntilMs < range.sinceMs
  ) {
    return false;
  }
  return true;
}
