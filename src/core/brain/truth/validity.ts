/**
 * Ledger validity windows (truth-correctable-time-aware, contract
 * item 1): the assertion-versus-validity axis for the claim ledger.
 *
 * A claim may carry an optional presence-gated validity window
 * (`validFrom` / `validUntil`, half-open `[validFrom, validUntil)`),
 * stored as a bare ISO date or a canonical UTC timestamp. Window
 * parsing shares the `src/core/search/validity.ts` grammar - the same
 * shapes parse, datetimes with a missing offset read as UTC, and
 * relative phrases never parse, because a stored window must not be
 * clock-dependent - with one ledger-specific difference pinned by this
 * module's own tests: a bare date resolves to its `T00:00:00Z` start on
 * BOTH edges, so the exclusive until bound keeps adjacent bare-date
 * windows (`until: 2026-09-01` then `from: 2026-09-01`) disjoint, the
 * half-open convention `lifecycle/temporal-replace.ts` evaluates
 * frontmatter windows by. This module mirrors that grammar locally
 * rather than importing it, so the Brain layer keeps no dependency on
 * the search layer.
 *
 * Pure functions; no I/O, no clock.
 */

import type { ClaimEvent } from "./types.ts";

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Parse one validity point to unix ms, mirroring the
 * `src/core/search/validity.ts` grammar. A bare date resolves to its
 * day start on BOTH edges - the until bound stays exclusive, so a
 * bare-date window is half-open and adjacent bare-date windows never
 * intersect. Returns null for relative phrases, garbage, and impossible
 * calendar dates - never a guess.
 */
function validityPointMs(raw: string): number | null {
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
    return ms;
  }
  if (text.includes("T") || text.includes("t")) {
    const hasOffset = /(?:z|[+-]\d{2}:?\d{2})$/i.test(text);
    const parsed = Date.parse(hasOffset ? text : `${text}Z`);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/**
 * Whether `raw` is a storable ledger validity point: a bare ISO date
 * (day-snapped at parse time) or a canonical UTC timestamp. Everything
 * else - relative phrases, offset-bearing datetimes, empty strings,
 * garbage - is rejected by the write boundary with a named error.
 */
export function isValidityPoint(raw: string): boolean {
  const text = raw.trim();
  if (text === "") return false;
  if (ISO_DATE_RE.test(text)) return validityPointMs(text) !== null;
  // Canonical UTC only: a timestamp must end in Z (offsets are not
  // canonical and are rejected rather than normalized).
  return /(?:z)$/i.test(text) && validityPointMs(text) !== null;
}

/** The validity window of one claim, in unix ms. */
export interface ClaimWindow {
  /** Window start, or null when open on the from side. */
  readonly fromMs: number | null;
  /** Window end (exclusive), or null when open on the until side. */
  readonly untilMs: number | null;
}

/**
 * The validity window an event carries, or null when the event carries
 * no window at all. A missing bound is unbounded on that side; a
 * present-but-unparseable bound reads as unbounded too (the write
 * boundary rejects unparseable values with a named error, so this
 * branch only tolerates hand-built events).
 */
export function claimWindow(event: ClaimEvent): ClaimWindow | null {
  const hasFrom = typeof event.validFrom === "string" && event.validFrom.trim() !== "";
  const hasUntil = typeof event.validUntil === "string" && event.validUntil.trim() !== "";
  if (!hasFrom && !hasUntil) return null;
  return Object.freeze({
    fromMs: hasFrom ? validityPointMs(event.validFrom!) : null,
    untilMs: hasUntil ? validityPointMs(event.validUntil!) : null,
  });
}

/**
 * Half-open intersection: `[a.validFrom, a.validUntil)` overlaps
 * `[b.validFrom, b.validUntil)` iff `a.fromMs < b.untilMs` and
 * `b.fromMs < a.untilMs`, with a missing bound acting as minus
 * infinity on the from side and plus infinity on the until side.
 */
export function windowsIntersect(a: ClaimWindow, b: ClaimWindow): boolean {
  const aFrom = a.fromMs ?? Number.NEGATIVE_INFINITY;
  const aUntil = a.untilMs ?? Number.POSITIVE_INFINITY;
  const bFrom = b.fromMs ?? Number.NEGATIVE_INFINITY;
  const bUntil = b.untilMs ?? Number.POSITIVE_INFINITY;
  return aFrom < bUntil && bFrom < aUntil;
}

/** Strictly parsed present bounds of a candidate window. */
export interface ParsedValidityWindow {
  readonly fromMs: number | null;
  readonly untilMs: number | null;
}

/**
 * Parse a candidate window's bounds under the storable grammar
 * ({@link isValidityPoint}) for the append and read boundaries.
 * Returns null when any PRESENT bound fails the grammar - the caller
 * names the failure; absent bounds simply parse to null on their side.
 */
export function validityWindowMs(
  validFrom: string | undefined,
  validUntil: string | undefined,
): ParsedValidityWindow | null {
  const hasFrom = validFrom !== undefined && validFrom.trim() !== "";
  const hasUntil = validUntil !== undefined && validUntil.trim() !== "";
  if (hasFrom && !isValidityPoint(validFrom!)) return null;
  if (hasUntil && !isValidityPoint(validUntil!)) return null;
  return Object.freeze({
    fromMs: hasFrom ? validityPointMs(validFrom!) : null,
    untilMs: hasUntil ? validityPointMs(validUntil!) : null,
  });
}

/**
 * A validity window candidate as carried by a caller's input or by a
 * source record's frontmatter (`valid_from` / `valid_until`).
 */
export interface SourceValidityWindow {
  readonly validFrom?: string;
  readonly validUntil?: string;
}

/** The resolved ingest window: only the bounds that survive resolution. */
export interface ResolvedIngestWindow {
  readonly validFrom?: string;
  readonly validUntil?: string;
}

/**
 * A source-side bound participates only when it is present and parses
 * under the storable grammar. A malformed frontmatter window must
 * never refuse an otherwise-valid ingest nor leak garbage into the
 * ledger, so it resolves as absent; explicit input bypasses this gate
 * verbatim, because the append boundary validates it and names the
 * failure.
 */
function sourceBound(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const text = value.trim();
  if (text === "" || !isValidityPoint(text)) return undefined;
  return text;
}

/**
 * Ingest window defaults, frozen at ingest (truth-correctable-time-aware,
 * task 3): each explicit input bound wins outright; a bound the caller
 * left open resolves from the source record's frontmatter window, and
 * the adopted string is stored verbatim (frozen - never a live
 * reference back to the record). A null source window (unreadable or
 * windowless source) resolves nothing, so the event stays windowless
 * and byte-identical to the pre-window ledger. mtime is not an input
 * here by construction: an mtime is an assertion-time proxy, not
 * validity. Resolution is per bound, so an explicit from pairs with a
 * source until.
 *
 * Pure; the caller owns reading the source record.
 */
export function resolveIngestWindow(
  input: SourceValidityWindow,
  sourceWindow: SourceValidityWindow | null,
): ResolvedIngestWindow {
  const fromExplicit = input.validFrom !== undefined;
  const untilExplicit = input.validUntil !== undefined;
  const validFrom = fromExplicit
    ? input.validFrom
    : sourceWindow === null
      ? undefined
      : sourceBound(sourceWindow.validFrom);
  const validUntil = untilExplicit
    ? input.validUntil
    : sourceWindow === null
      ? undefined
      : sourceBound(sourceWindow.validUntil);
  return Object.freeze({
    ...(validFrom !== undefined ? { validFrom } : {}),
    ...(validUntil !== undefined ? { validUntil } : {}),
  });
}
