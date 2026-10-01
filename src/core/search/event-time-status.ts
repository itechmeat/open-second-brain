/**
 * The event-time summary `o2b search status` reports: how many indexed
 * documents carry a persisted event-time window (schema v13), the span
 * those windows cover, and how many fall in a recent window. A read over
 * the store's one-aggregate census, so the bounds the indexer persists
 * have a reader an operator can see.
 */

import { Store } from "./store.ts";
import type { ResolvedSearchConfig } from "./types.ts";

/** Width of the recent window the summary counts, in days. */
export const EVENT_TIME_RECENT_WINDOW_DAYS = 30;

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

export interface EventTimeStatus {
  /** Every indexed document. */
  readonly documents: number;
  /** Documents with a persisted event-time window. */
  readonly withEventTime: number;
  /** Earliest instant any window names, unix ms; null when none is persisted. */
  readonly earliestMs: number | null;
  /** Latest instant any window names, unix ms; null when none is persisted. */
  readonly latestMs: number | null;
  /** The recent window's width, {@link EVENT_TIME_RECENT_WINDOW_DAYS}. */
  readonly recentWindowDays: number;
  /** Documents whose window intersects the last {@link recentWindowDays} days. */
  readonly inRecentWindow: number;
}

/**
 * Take the summary over the index at `config.dbPath`. The open's own
 * errors (an absent or unreadable index) propagate by name.
 */
export async function eventTimeStatus(
  config: ResolvedSearchConfig,
  nowMs: number = Date.now(),
): Promise<EventTimeStatus> {
  const store = await Store.open(config, { mode: "read", loadVec: false });
  try {
    const since = nowMs - EVENT_TIME_RECENT_WINDOW_DAYS * MILLISECONDS_PER_DAY;
    const census = store.eventTimeWindowCensus(since, nowMs);
    return Object.freeze({
      documents: census.documents,
      withEventTime: census.declared,
      earliestMs: census.earliestMs,
      latestMs: census.latestMs,
      recentWindowDays: EVENT_TIME_RECENT_WINDOW_DAYS,
      inRecentWindow: census.intersecting,
    });
  } finally {
    await store.close();
  }
}

function isoOrNull(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

/** The snake_case `event_time` block of `o2b search status --json`. */
export function serializeEventTimeStatus(s: EventTimeStatus): Record<string, unknown> {
  return {
    documents: s.documents,
    with_event_time: s.withEventTime,
    earliest: isoOrNull(s.earliestMs),
    latest: isoOrNull(s.latestMs),
    recent_window_days: s.recentWindowDays,
    in_recent_window: s.inRecentWindow,
  };
}

/** The one-line human rendering, beside the other `search status` lines. */
export function renderEventTimeStatus(s: EventTimeStatus): string {
  const span =
    s.withEventTime === 0
      ? "no persisted windows"
      : `earliest ${isoOrNull(s.earliestMs)}, latest ${isoOrNull(s.latestMs)}, ` +
        `${s.inRecentWindow} in the last ${s.recentWindowDays} days`;
  return `${s.withEventTime}/${s.documents} documents (${span})`;
}
