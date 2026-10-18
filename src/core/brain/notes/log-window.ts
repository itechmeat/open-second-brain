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
 *     (`YYYY-MM-DDTHH:MM:SSZ`, optional sub-second precision). The strict
 *     canonical shape keeps a bound in the same vocabulary the log and
 *     the revert-plan digests carry - an offset spelling or a missing
 *     seconds field is refused rather than normalized - but the window
 *     comparison itself orders by instant ({@link timestampInWindow}):
 *     the log writer stamps whole seconds while the JSONL reader admits
 *     sub-second foreign lines, and a plain string compare would order
 *     `…56.789Z` before `…56Z`, admitting an entry `--until` should
 *     exclude and dropping one `--since` should include.
 */

import { neutralizeSingleLine } from "../untrusted-source.ts";

/** A bare `YYYY-MM-DD`, which both bounds accept as shorthand for a day. */ export const ISO_DATE_ONLY_RE =
  /^\d{4}-\d{2}-\d{2}$/;

/** How a bare date is completed at the window's lower end. */
export const DAY_START_SUFFIX = "T00:00:00Z";

/**
 * How a bare date is completed at the window's upper end: through the
 * day. The suffix reaches past the whole last second because the JSONL
 * reader admits sub-second foreign lines - ending at `…59Z` would drop
 * an entry inside the bound day's final fraction, and "through the end
 * of the fourth" has to mean all of it.
 */
export const DAY_END_SUFFIX = "T23:59:59.999Z";

/** Characters of an ISO-8601 timestamp that spell its date. */
export const DATE_LENGTH = 10;

/** Which end of the window a bound names, so an error can blame the flag. */
export type WindowBoundEdge = "since" | "until";

/**
 * A window bound in neither accepted spelling. The message names the flag
 * (`--since` / `--until`) and the rejected value, because "empty" is what
 * a misread bound looks like and the caller deserves the difference. The
 * raw value stays on {@link value} for programmatic callers; the message
 * carries only the fenced form.
 */
export class LogWindowBoundError extends Error {
  readonly edge: WindowBoundEdge;
  readonly value: string;

  constructor(edge: WindowBoundEdge, value: string) {
    super(
      `--${edge} must be YYYY-MM-DD or an ISO-8601 UTC timestamp, got '${fenceBoundValue(value)}'`,
    );
    this.name = "LogWindowBoundError";
    this.edge = edge;
    this.value = value;
  }
}

/**
 * The longest stretch of a rejected bound the error message carries.
 * The message reaches the model through INVALID_PARAMS - the same
 * model-facing channel the log parse warnings fence at their source - so
 * the value is neutralized to one line, then capped, the same rule
 * `log-jsonl.ts` applies to its own warnings.
 */
const MAX_BOUND_VALUE_CHARS = 120;

/** Fence one rejected bound for interpolation into the error message. */
function fenceBoundValue(value: string): string {
  const neutralized = neutralizeSingleLine(value);
  return neutralized.length > MAX_BOUND_VALUE_CHARS
    ? `${neutralized.slice(0, MAX_BOUND_VALUE_CHARS)}…`
    : neutralized;
}

/** Canonical ISO-8601 UTC timestamp shape, the log writer's own. */
const ISO_UTC_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

/**
 * Complete and validate one window bound, ready for the readers' window
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

/**
 * Whether one log entry timestamp falls inside the parsed window.
 *
 * Both sides are compared as instants (epoch milliseconds), not strings:
 * a bound at whole seconds and an entry carrying sub-second precision
 * order opposite ways under a plain string compare (`…56.789Z` sorts
 * before `…56Z`), and an until that admits an entry it should exclude -
 * or a since that drops one it should include - is exactly the kind of
 * wrong this module exists to make loud. A null bound leaves that end
 * unbounded.
 *
 * A timestamp that parses to nothing is outside every bounded window:
 * the JSONL reader admits a value by shape, so a right-shaped but
 * impossible instant (month 13, hour 99) reaches here as NaN, every NaN
 * comparison is false, and an unguarded predicate would fail open -
 * answering "inside" for any window and riding the bad entry into every
 * bounded read, revert plans included. Only a fully unbounded window,
 * which filters nothing, still shows it.
 */
export function timestampInWindow(
  timestamp: string,
  since: string | null,
  until: string | null,
): boolean {
  const at = Date.parse(timestamp);
  if (!Number.isFinite(at)) return since === null && until === null;
  if (since !== null && at < Date.parse(since)) return false;
  if (until !== null && at > Date.parse(until)) return false;
  return true;
}
