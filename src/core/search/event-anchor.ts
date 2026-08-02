/**
 * The event anchor: ONE event-time interval per document, resolved from
 * what the document itself says, and materialised onto the `documents`
 * row at index time (provenance at the boundary, t_ac1c4176).
 *
 * ## Why this exists
 *
 * Ranking already judged a note by a content-derived event time, but only
 * when the note declared `valid_from` / `valid_until` in frontmatter. A
 * note whose only statement of when it is ABOUT sits in its BODY was
 * ranked by when its file was last written. This module closes that gap,
 * and the index stores the result so a candidate's body is not re-scanned
 * on every query.
 *
 * ## The ladder
 *
 * First rung that DECLARES anything wins, and the winning rung is
 * recorded as a registered {@link EventAnchorSource} token - never as
 * free text, so a consumer can branch on provenance:
 *
 *   1. `valid_from` / `valid_until` frontmatter (the existing bi-temporal
 *      validity window);
 *   2. `created_at` frontmatter;
 *   3. `date` frontmatter;
 *   4. an ISO token in the note body.
 *
 * A rung that is DECLARED but cannot be read stops the ladder and yields
 * no anchor. Absence and inability-to-examine are different answers: a
 * malformed `created_at` is not an absent one, and quietly substituting a
 * lower rung's answer for it would report a date the document never
 * stated.
 *
 * ## Recorded provenance is not the same as event time
 *
 * All four rungs are RECORDED - that is what "provenance at the
 * boundary" means, and it is why the rung is stored as a registered
 * token instead of being thrown away. Which of them the query side is
 * allowed to JUDGE a document by is a separate, narrower question, and
 * {@link anchorIsEventTime} answers it: `created_at` and `date` are
 * stamped by every Brain writer, describe when a file was authored, and
 * were never event time before this release. The query-side event-time
 * resolver feeds a filter that DROPS candidates, so promoting them into
 * it would silently change what a time-ranged query means - "what did I
 * touch since January" would start answering about authorship. The body
 * rung is the one this release adds, and it is the one that judges.
 *
 * ## Two deliberate refusals and one deliberate acceptance
 *
 * - **Slash-formatted dates are not recognised.** Resolving `04/03/2026`
 *   as day-month or month-day requires a locale, and a locale is a
 *   natural-language signal. The extractor below recognises formal ISO
 *   tokens only, in every script alike.
 * - **A clock-relative derivation is not stored.** The shared extractor
 *   anchors a bare ISO-8601 duration to `now`. A value derived from a
 *   clock ages silently, while both index fastpaths gate on content
 *   identity and so correctly decline to recompute it. Rather than
 *   assuming which branch is clock-free, {@link resolveEventAnchor} runs
 *   the extractor under two distant probe clocks and refuses any result
 *   that differs between them - a structural proof that survives future
 *   changes to the extractor.
 * - **A future date is kept.** A note that says an embargo lifts in 2099
 *   has declared an event time. Dropping it would be inference dressed as
 *   validation.
 *
 * ## Day-width windows
 *
 * A bare date is a DAY, not an instant, so it snaps to day start and day
 * end - the same snapping `parseValidityPoint` already applies to a bare
 * frontmatter date. That makes the anchor an interval, which is what the
 * hard `since`/`until` filter, the targeted-retry coverage gate and the
 * temporal bridge all consume, so the anchor composes with all of them
 * instead of being wired only into the ranking boost.
 *
 * Pure and deterministic: same frontmatter and body, same anchor, on any
 * machine at any time.
 */

import { extractTemporalConstraints } from "../brain/temporal-extract.ts";
import { parseValidityWindow } from "./validity.ts";

/**
 * Registered vocabulary for the ladder rung an anchor came from. Stored
 * verbatim in `documents.event_anchor_source`.
 */
export const EVENT_ANCHOR_SOURCE = {
  /** The note's declared `valid_from` / `valid_until` frontmatter window. */
  validity: "validity",
  /** The note's `created_at` frontmatter field. */
  createdAt: "created_at",
  /** The note's `date` frontmatter field (the brain-log convention). */
  date: "date",
  /** An ISO token found in the note body. */
  body: "body",
} as const;

export type EventAnchorSource = (typeof EVENT_ANCHOR_SOURCE)[keyof typeof EVENT_ANCHOR_SOURCE];

const EVENT_ANCHOR_SOURCE_VALUES: ReadonlyArray<string> = Object.freeze(
  Object.values(EVENT_ANCHOR_SOURCE),
);

export function isEventAnchorSource(value: unknown): value is EventAnchorSource {
  return typeof value === "string" && EVENT_ANCHOR_SOURCE_VALUES.includes(value);
}

/**
 * The rungs that are EVENT TIME, and may therefore decide whether a
 * candidate survives the hard `since` / `until` filter. See the
 * "recorded provenance is not the same as event time" section above for
 * why the two frontmatter point fields are not among them.
 */
const EVENT_TIME_ANCHOR_SOURCES: ReadonlyArray<EventAnchorSource> = Object.freeze([
  EVENT_ANCHOR_SOURCE.validity,
  EVENT_ANCHOR_SOURCE.body,
]);

/** True when `anchor` came from a rung the query side judges a document by. */
export function anchorIsEventTime(anchor: EventAnchor): boolean {
  return EVENT_TIME_ANCHOR_SOURCES.includes(anchor.source);
}

/**
 * A document's resolved event interval. At least one side is non-null;
 * an open side means the document declared no bound there.
 *
 * Milliseconds, not seconds: a day-end bound is `dayStart + 86_400_000 -
 * 1`, and truncating that to whole seconds would move the boundary by
 * almost a second on every interval comparison. `mtime` and `authored_at`
 * are unix SECONDS on the same table, so the unit is spelled into these
 * field and column names rather than left to be inferred.
 */
export interface EventAnchor {
  readonly startMs: number | null;
  readonly endMs: number | null;
  readonly source: EventAnchorSource;
}

/** Frontmatter point fields, in ladder order below the validity window. */
const POINT_FIELDS: ReadonlyArray<readonly [string, EventAnchorSource]> = Object.freeze([
  ["created_at", EVENT_ANCHOR_SOURCE.createdAt],
  ["date", EVENT_ANCHOR_SOURCE.date],
]);

/**
 * Two distant, fixed instants used to prove a body derivation is
 * independent of the clock. Any extractor branch that consults `now`
 * produces different output under these two, and is refused.
 */
const CLOCK_PROBE_EARLY = new Date("2001-01-01T00:00:00Z");
const CLOCK_PROBE_LATE = new Date("2031-01-01T00:00:00Z");

/** Leading `YYYY-MM-DD` of an ISO instant. */
const ISO_DATE_PREFIX_RE = /^(\d{4}-\d{2}-\d{2})/;

/**
 * Resolve a document's event anchor, or null when it declares nothing
 * readable. `body` is the note text with frontmatter already stripped, so
 * a frontmatter value can never be mistaken for a body statement.
 */
export function resolveEventAnchor(
  frontmatter: Record<string, unknown>,
  body: string,
): EventAnchor | null {
  const declared = parseValidityWindow(frontmatter);
  if (declared !== null) {
    if (declared.invalid) return null;
    return freezeAnchor(declared.validFromMs, declared.validUntilMs, EVENT_ANCHOR_SOURCE.validity);
  }

  for (const [field, source] of POINT_FIELDS) {
    const raw = frontmatter[field];
    if (raw === undefined || raw === null) continue;
    return windowAnchor(raw, raw, source);
  }

  const constraints = clockIndependentConstraints(body);
  if (constraints === null) return null;
  const from = isoDatePart(constraints.from);
  const until = isoDatePart(constraints.until);
  if (from === null || until === null) return null;
  return windowAnchor(from, until, EVENT_ANCHOR_SOURCE.body);
}

/**
 * Build an anchor by handing the two bounds to the SAME parser the
 * frontmatter validity window uses, so bare dates snap to day start /
 * day end exactly as a declared `valid_from` / `valid_until` pair would.
 * A bound that cannot be parsed yields no anchor.
 */
function windowAnchor(
  from: unknown,
  until: unknown,
  source: EventAnchorSource,
): EventAnchor | null {
  const window = parseValidityWindow({ valid_from: from, valid_until: until });
  if (window === null || window.invalid) return null;
  return freezeAnchor(window.validFromMs, window.validUntilMs, source);
}

function freezeAnchor(
  startMs: number | null,
  endMs: number | null,
  source: EventAnchorSource,
): EventAnchor | null {
  if (startMs === null && endMs === null) return null;
  return Object.freeze({ startMs, endMs, source });
}

/** The two bounds a body statement resolves to, before day snapping. */
interface BodyConstraints {
  readonly from: string;
  /** The lone-date case declares one day, so the end bound is that day. */
  readonly until: string;
}

/**
 * Run the shared extractor under two distant clocks and return its result
 * only when the two agree. A disagreement means the derivation consulted
 * `now`, which must never reach stored data.
 */
function clockIndependentConstraints(body: string): BodyConstraints | null {
  const early = extractTemporalConstraints(body, { now: CLOCK_PROBE_EARLY });
  const late = extractTemporalConstraints(body, { now: CLOCK_PROBE_LATE });
  if (early.valid_from !== late.valid_from || early.valid_until !== late.valid_until) return null;
  if (early.valid_from === undefined) return null;
  return { from: early.valid_from, until: early.valid_until ?? early.valid_from };
}

function isoDatePart(iso: string): string | null {
  const m = ISO_DATE_PREFIX_RE.exec(iso);
  return m === null ? null : m[1]!;
}
