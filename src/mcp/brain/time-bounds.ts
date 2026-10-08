/**
 * Shared time-bounds wrapper (truth-correctable-time-aware, Task 7):
 * one `since`/`until` resolution for every MCP recall surface.
 *
 * Bounds parse through the shared time-range grammar (`resolveTimeRange`:
 * ISO date/datetime, today/yesterday, last week/month, `<n>h`/`<n>d`/
 * `<n>w`; the upper edge is inclusive). A grammar refusal - an
 * unparseable point or an inverted range - surfaces as an
 * `MCPError(INVALID_PARAMS)` carrying the search error's typed data,
 * never as a silently ignored filter. The lifted form of the bounds
 * resolver `brain_session_grep` used to carry privately.
 */

import { resolveTimeRange } from "../../core/search/time-range.ts";
import { SearchError } from "../../core/search/types.ts";
import { INVALID_PARAMS, MCPError } from "../protocol.ts";
import { searchErrorData } from "../search-tools.ts";

/** Resolved conversation/assertion-chronology bounds; null is open. */
export interface TimeBounds {
  readonly sinceMs: number | null;
  readonly untilMs: number | null;
}

/**
 * Resolve `since` / `until` through the shared time-range grammar,
 * mapping `SearchError` to `MCPError(INVALID_PARAMS)`. Absent bounds
 * stay open.
 */
export function resolveTimeBounds(
  since: string | undefined,
  until: string | undefined,
): TimeBounds {
  if (since === undefined && until === undefined) {
    return { sinceMs: null, untilMs: null };
  }
  try {
    return resolveTimeRange(
      {
        ...(since !== undefined ? { since } : {}),
        ...(until !== undefined ? { until } : {}),
      },
      Date.now(),
    );
  } catch (exc) {
    if (exc instanceof SearchError) {
      throw new MCPError(INVALID_PARAMS, exc.message, searchErrorData(exc));
    }
    throw exc;
  }
}
