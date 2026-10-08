/**
 * Pure windowed selection over claim events (truth-correctable-time-aware,
 * Task 6): the selection half of the brain_truth `events` operation.
 *
 * The module is pure and vault-free: it takes the already-`ts`-ascending
 * event array `readClaimEvents` returns and slices it against an optional
 * normalized-entity filter and an optional assertion-time window. The
 * window is ASSERTION time only - `since`/`until` filter the events' `ts`
 * and say nothing about the claims' validity windows (contract item 1
 * keeps those two temporal vocabularies separate; the per-claim
 * `[validFrom, validUntil)` convention rides on the rows verbatim).
 *
 * Bounds arrive as unix-ms (resolved by the caller through the shared
 * time-range grammar) and are compared at SECOND precision, because
 * ledger stamps are whole-second ISO-8601 UTC (`isoSecond`). `since`
 * floors into its second, so a bound mid-second still admits the events
 * of that second - the safe direction for tail-following pagination,
 * where an advancing `since` may re-see a boundary event but must never
 * skip one. `until` also resolves to the stamp of the second containing
 * it and compares inclusively, which is what the grammar's inclusive
 * upper edge means at second precision: the grammar's day-end edge
 * (`23:59:59.999`) keeps the whole final second of the day and excludes
 * the next day's midnight second. Sub-second detail on an event stamp is
 * truncated before the compare, so a hand-written fractional row behaves
 * as the whole second it was asserted in.
 */

import { normalizeEntityName } from "../entities/canonical.ts";
import { isoSecond } from "../time.ts";
import type { ClaimEvent } from "./types.ts";

/** Default page size for the events operation. */
export const DEFAULT_EVENT_LIST_LIMIT = 200;

/** Hard cap on the events operation's page size; larger asks are capped. */
export const CLAIM_EVENT_MAX_LIST_LIMIT = 1000;

/** Selection knobs for one events query. Absent bounds stay open. */
export interface ClaimEventSelection {
  /** Canonical entity name or its display-form spelling; empty filters nothing. */
  readonly entity?: string;
  /** Inclusive lower assertion-time bound (unix-ms), floored to the second. */
  readonly sinceMs?: number | null;
  /** Inclusive upper assertion-time bound (unix-ms), resolved to its whole second. */
  readonly untilMs?: number | null;
  /** Page size; defaults to {@link DEFAULT_EVENT_LIST_LIMIT}, capped at the hard cap. */
  readonly limit?: number;
}

/** One events query's outcome: the page, the full match count, the cut flag. */
export interface ClaimEventSelectionResult {
  /** Matched events, ascending assertion `ts`, within the page limit. */
  readonly rows: ReadonlyArray<ClaimEvent>;
  /** Every event the filters matched, the page included. */
  readonly total: number;
  /** True when more events matched than the page returned. */
  readonly truncated: boolean;
}

/**
 * Validate and cap one events page size coming from an untyped surface
 * (MCP arguments, CLI flags). Absent asks for the default; anything that
 * is not a positive integer is refused with a named error rather than
 * silently coerced; anything above the hard cap is capped, which is the
 * operation's specified bound.
 */
export function claimEventLimit(raw: unknown): number {
  if (raw === undefined || raw === null) return DEFAULT_EVENT_LIST_LIMIT;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) {
    throw new RangeError(
      `claim events limit must be a positive integer, got ${JSON.stringify(raw)}`,
    );
  }
  return Math.min(raw, CLAIM_EVENT_MAX_LIST_LIMIT);
}

/**
 * Resolve unix-ms window bounds into whole-second ISO-8601 UTC stamps,
 * the form the second-precision string compare below consumes. Null
 * stays null: that side of the window is open. A non-finite bound is
 * refused by name - it would otherwise reach `new Date(NaN)` below and
 * die inside `toISOString()` as an unnamed "Invalid time value" error -
 * in the same style the limit validation uses, naming the offending
 * argument (spelled with String rather than JSON.stringify, which
 * renders a NaN as "null").
 */
export function eventsWindowBounds(
  sinceMs: number | null,
  untilMs: number | null,
): { since: string | null; until: string | null } {
  if (sinceMs !== null && !Number.isFinite(sinceMs)) {
    throw new RangeError(
      `claim events since bound must be a finite number, got ${String(sinceMs)}`,
    );
  }
  if (untilMs !== null && !Number.isFinite(untilMs)) {
    throw new RangeError(
      `claim events until bound must be a finite number, got ${String(untilMs)}`,
    );
  }
  return {
    since: sinceMs === null ? null : isoSecond(new Date(floorToSecond(sinceMs))),
    until: untilMs === null ? null : isoSecond(new Date(floorToSecond(untilMs))),
  };
}

function floorToSecond(ms: number): number {
  return Math.floor(ms / 1000) * 1000;
}

/**
 * The event stamp at second precision. Ledger stamps are written by
 * `isoSecond`, for which this is the identity; a hand-written fractional
 * stamp is judged as the whole second it was asserted in.
 */
function eventSecond(ts: string): string {
  return `${ts.slice(0, 19)}Z`;
}

/**
 * Every event the selection's filters match, in the input's ascending
 * `(ts, shard, line)` order - the page WITHOUT the page size, so a
 * caller that gates rows per row (visibility, reach) can count what the
 * gate withheld and page the survivors itself.
 */
export function matchClaimEvents(
  events: ReadonlyArray<ClaimEvent>,
  selection: ClaimEventSelection,
): ReadonlyArray<ClaimEvent> {
  const bounds = eventsWindowBounds(selection.sinceMs ?? null, selection.untilMs ?? null);
  const entity = selection.entity === undefined ? "" : normalizeEntityName(selection.entity);
  return events.filter(
    (event) =>
      (entity === "" || event.entity === entity) &&
      (bounds.since === null || eventSecond(event.ts) >= bounds.since) &&
      (bounds.until === null || eventSecond(event.ts) <= bounds.until),
  );
}

/**
 * Slice a `ts`-ascending event array against the selection. Order is
 * preserved from the input (the store returns ascending `(ts, shard,
 * line)`), so the rows are stable across calls over an unchanged ledger.
 * A `limit` below 1 or fractional is refused rather than silently
 * coerced; a `limit` above the hard cap is capped, which is the
 * operation's specified bound.
 */
export function selectClaimEvents(
  events: ReadonlyArray<ClaimEvent>,
  selection: ClaimEventSelection,
): ClaimEventSelectionResult {
  const limit = claimEventLimit(selection.limit ?? DEFAULT_EVENT_LIST_LIMIT);

  const matched = matchClaimEvents(events, selection);
  return {
    rows: matched.slice(0, limit),
    total: matched.length,
    truncated: matched.length > limit,
  };
}
