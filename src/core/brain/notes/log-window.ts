/**
 * The one parser for the `since` / `until` window bounds the write-ledger
 * readers accept (`listNoteWrites`, `listWriteDestinations`).
 *
 * Two readers grew the same three constants and the same completion rule,
 * and neither copy validated: a bound that was neither spelling -
 * `yesterday`, `03/01/2026` - fell through the regex untouched, compared
 * lexicographically against canonical timestamps, matched no log day, and
 * the query answered a clean, wrong empty. One parser that THROWS a named
 * error turns that silent empty into a usage error the surface can blame
 * on the flag the caller mistyped.
 *
 * Accepted spellings, which the schema text on both surfaces promises:
 *
 *   - a bare `YYYY-MM-DD`, completed to the day's start or end by the
 *     caller's suffix - an `--until 2026-03-04` means "through the end of
 *     the fourth", not "up to midnight starting it";
 *   - an ISO-8601 UTC timestamp in the shape the log writer emits
 *     (`YYYY-MM-DDTHH:MM:SSZ`, optional sub-second precision), passed
 *     through verbatim - the readers compare bounds with the same string
 *     comparison as the log's own timestamps, so an offset spelling or a
 *     missing seconds field would order wrong even where it parses.
 */

/** A bare `YYYY-MM-DD`, which both bounds accept as shorthand for a day. */ export const ISO_DATE_ONLY_RE =
  /^\d{4}-\d{2}-\d{2}$/;

/** How a bare date is completed at the window's lower end. */
export const DAY_START_SUFFIX = "T00:00:00Z";

/** How a bare date is completed at the window's upper end: through the day. */
export const DAY_END_SUFFIX = "T23:59:59Z";

/** Characters of an ISO-8601 timestamp that spell its date. */
export const DATE_LENGTH = 10;

/** Which end of the window a bound names, so an error can blame the flag. */
export type WindowBoundEdge = "since" | "until";

/**
 * A window bound in neither accepted spelling. The message names the flag
 * (`--since` / `--until`) and the rejected value, because "empty" is what
 * a misread bound looks like and the caller deserves the difference.
 */
export class LogWindowBoundError extends Error {
  readonly edge: WindowBoundEdge;
  readonly value: string;

  constructor(edge: WindowBoundEdge, value: string) {
    super(`--${edge} must be YYYY-MM-DD or an ISO-8601 UTC timestamp, got '${value}'`);
    this.name = "LogWindowBoundError";
    this.edge = edge;
    this.value = value;
  }
}

/** Canonical ISO-8601 UTC timestamp shape, the log writer's own. */
const ISO_UTC_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

/**
 * Complete and validate one window bound, ready for the readers' string
 * comparisons against canonical log timestamps.
 *
 * A bare date is completed with `suffix` and calendar-checked by parsing
 * (`2026-13-01` has the right shape and no such day); a full timestamp is
 * passed through only when it is already canonical. Everything else throws
 * {@link LogWindowBoundError} naming the `edge` - since or until - that
 * carried it.
 */
export function parseWindowBound(
  value: string,
  edge: WindowBoundEdge,
  suffix: typeof DAY_START_SUFFIX | typeof DAY_END_SUFFIX,
): string {
  if (ISO_DATE_ONLY_RE.test(value)) {
    const completed = `${value}${suffix}`;
    if (Number.isFinite(Date.parse(completed))) return completed;
  } else if (ISO_UTC_TS_RE.test(value) && Number.isFinite(Date.parse(value))) {
    return value;
  }
  throw new LogWindowBoundError(edge, value);
}
