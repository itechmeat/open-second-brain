/**
 * `selectEvents(index, filters)` - pure projection over a frozen
 * {@link TimelineIndex}.
 *
 * Returns a frozen subset of the index's events filtered by the AND
 * of all supplied predicates. Empty filter object returns the whole
 * event list (still frozen).
 *
 * No disk reads; no state. Order is preserved from the index (which
 * sorts ascending by `at`, ties broken by `source`).
 */

import type { BrainLogEventKind } from "./../types.ts";
import type { TemporalEvent, TimelineIndex } from "./types.ts";

/** Filter set accepted by {@link selectEvents}. */
export interface SelectEventsFilters {
  /** Restrict to events with this preference / retired / signal id. */
  readonly prefId?: string;
  /** Restrict to events with this topic slug. */
  readonly topic?: string;
  /** Restrict to events of this kind. */
  readonly kind?: BrainLogEventKind;
  /** Inclusive lower bound (ISO-8601 UTC). */
  readonly since?: string;
  /** Exclusive upper bound (ISO-8601 UTC). */
  readonly until?: string;
}

export function selectEvents(
  index: TimelineIndex,
  filters: SelectEventsFilters,
): ReadonlyArray<TemporalEvent> {
  // Pick the narrowest pre-grouped bucket the filter set permits to
  // avoid scanning the full event list when the caller has already
  // committed to a kind / prefId / topic.
  const source = pickNarrowSource(index, filters) ?? index.events;
  const out: TemporalEvent[] = [];
  for (const ev of source) {
    if (!matchesFilters(ev, filters)) continue;
    out.push(ev);
  }
  return Object.freeze(out);
}

function pickNarrowSource(
  index: TimelineIndex,
  filters: SelectEventsFilters,
): ReadonlyArray<TemporalEvent> | undefined {
  if (filters.prefId !== undefined) {
    return index.eventsByPrefId.get(filters.prefId) ?? Object.freeze([]);
  }
  if (filters.topic !== undefined) {
    return index.eventsByTopic.get(filters.topic) ?? Object.freeze([]);
  }
  if (filters.kind !== undefined) {
    return index.eventsByKind.get(filters.kind) ?? Object.freeze([]);
  }
  return undefined;
}

function matchesFilters(ev: TemporalEvent, filters: SelectEventsFilters): boolean {
  if (filters.prefId !== undefined && ev.prefId !== filters.prefId) return false;
  if (filters.topic !== undefined && ev.topic !== filters.topic) return false;
  if (filters.kind !== undefined && ev.kind !== filters.kind) return false;
  if (filters.since !== undefined && ev.at < filters.since) return false;
  if (filters.until !== undefined && ev.at >= filters.until) return false;
  return true;
}
