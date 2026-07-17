/**
 * `buildActivityTimeline(index, opts)` - merged chronological activity
 * timeline renderer (today-operator-surface, Task 3).
 *
 * Projects every event kind out of a {@link TimelineIndex} into one
 * merged, newest-first, typed bullet list. `buildTimelineIndex` already
 * sorts its `events` array oldest-first (ascending `at`, ties broken by
 * `source.path` then `source.line` - see `compareEvents` in
 * `build-index.ts`); this module reuses that ordering verbatim by
 * reversing a copy rather than re-deriving a merge order, so chronology
 * and tie-break rules stay pinned to one implementation.
 *
 * Window filtering delegates to `selectEvents`: `since` is inclusive and
 * `until` is exclusive, matching the semantics `TimelineIndex` itself
 * documents. `limit` truncates the newest-first list after windowing;
 * `total` reports the windowed count before that truncation so a caller
 * can render "showing N of M". A negative or non-integer `limit` is a
 * fail-closed rejection rather than a silent clamp.
 *
 * Bullet shape matches `timelineBullet` in `morning-brief.ts`:
 * `- [<kind>] <text> · <age>`, where `<kind>` is the `BrainLogEventKind`
 * string itself (no display-name translation table - inherently
 * language-agnostic) and `<age>` comes from `relativeAge(event.at, now)`.
 * The ` · <age>` suffix is omitted entirely when `relativeAge` returns
 * the empty string (unparseable or missing timestamp), matching
 * `timelineBullet`'s behavior exactly.
 *
 * Per-kind text derivation is structural, not kind-switched prose: a
 * fixed priority order of `TemporalEvent` fields is walked once per
 * event. When `text` is present (currently only `note` events) it is
 * used verbatim, since it already carries the full narrative content.
 * Otherwise every other populated field in the priority order below is
 * rendered as `field=value` and joined with a space - never translated,
 * never invented:
 *
 *   text > prefId > result > topic > artifact > transition
 *   (transitionFrom -> transitionTo, only when both present) > reason >
 *   validFrom > validUntil > recordedAt > dreamSummary (counts)
 *
 * `TemporalEvent.source` is a required field on every event, so an
 * event with none of the fields above populated (e.g. a `scan-inline`
 * row whose payload is pure counters `buildTimelineIndex` does not
 * normalise into any of those slots) falls back to `<kind>
 * (<source.path>[:<source.line>])` - the kind plus its audit pointer.
 * That fallback is the terminal branch for every event this type can
 * currently represent; a "skip-with-count" alternative was considered
 * per the design brief but is unreachable given `source` is mandatory,
 * so it was not implemented.
 *
 * Deterministic given the injected `now`; no wall-clock calls. The
 * returned envelope, its `entries` array, each entry, and the `bullets`
 * array are all frozen.
 */

import { selectEvents } from "./select-events.ts";
import type { DreamSummarySlots, TemporalEvent, TimelineIndex } from "./types.ts";
import { relativeAge } from "../time.ts";
import type { BrainLogEventKind } from "../types.ts";

/** Input options for {@link buildActivityTimeline}. */
export interface ActivityTimelineOptions {
  /** Wall clock; every relative-age label derives from this. */
  readonly now: Date;
  /** Inclusive lower bound (ISO-8601 UTC), forwarded to `selectEvents`. */
  readonly since?: string;
  /** Exclusive upper bound (ISO-8601 UTC), forwarded to `selectEvents`. */
  readonly until?: string;
  /** Max entries to keep after windowing, newest first. Must be a non-negative integer. */
  readonly limit?: number;
}

/** One rendered timeline entry. */
export interface ActivityTimelineEntry {
  readonly kind: BrainLogEventKind;
  readonly text: string;
  readonly at: string;
  /** Short relative-age label ("2d ago"); empty string when unparseable. */
  readonly ageLabel: string;
}

/** Frozen envelope returned by {@link buildActivityTimeline}. */
export interface ActivityTimeline {
  /** Newest-first entries, after window filtering and limiting. */
  readonly entries: ReadonlyArray<ActivityTimelineEntry>;
  /** Rendered `- [<kind>] <text> · <age>` bullets, one per entry, newest first. */
  readonly bullets: ReadonlyArray<string>;
  /** `bullets` joined with newlines. Empty string when there are no entries. */
  readonly text: string;
  /** Count of windowed events before `limit` was applied. */
  readonly total: number;
}

/**
 * Build the merged chronological activity timeline for a
 * `TimelineIndex`. Pure; does not mutate `index` or any of its arrays.
 */
export function buildActivityTimeline(
  index: TimelineIndex,
  opts: ActivityTimelineOptions,
): ActivityTimeline {
  if (opts.limit !== undefined && (!Number.isInteger(opts.limit) || opts.limit < 0)) {
    throw new Error(
      `buildActivityTimeline: limit must be a non-negative integer; got ${JSON.stringify(opts.limit)}`,
    );
  }

  const windowed = selectEvents(index, {
    ...(opts.since !== undefined ? { since: opts.since } : {}),
    ...(opts.until !== undefined ? { until: opts.until } : {}),
  });
  const total = windowed.length;

  // `windowed` is ascending oldest-first (selectEvents preserves the
  // index's order); `toReversed` produces a new array without mutating
  // the frozen source, giving the newest-first contract this module
  // promises.
  const newestFirst = windowed.toReversed();
  const limited = opts.limit !== undefined ? newestFirst.slice(0, opts.limit) : newestFirst;

  const entries: ActivityTimelineEntry[] = [];
  const bullets: string[] = [];
  for (const ev of limited) {
    const ageLabel = relativeAge(ev.at, opts.now);
    const text = deriveText(ev);
    entries.push(Object.freeze({ kind: ev.kind, text, at: ev.at, ageLabel }));
    bullets.push(renderBullet(ev.kind, text, ageLabel));
  }

  return Object.freeze({
    entries: Object.freeze(entries),
    bullets: Object.freeze(bullets),
    text: bullets.join("\n"),
    total,
  });
}

function renderBullet(kind: BrainLogEventKind, text: string, ageLabel: string): string {
  return `- [${kind}] ${text}${ageLabel ? ` · ${ageLabel}` : ""}`;
}

/**
 * Derive the structural bullet text for one event. See the module
 * docstring for the fixed field-priority order this implements.
 */
function deriveText(ev: TemporalEvent): string {
  if (ev.text !== undefined && ev.text.length > 0) return ev.text;

  const parts: string[] = [];
  if (ev.prefId !== undefined) parts.push(`pref=${ev.prefId}`);
  if (ev.result !== undefined) parts.push(`result=${ev.result}`);
  if (ev.topic !== undefined) parts.push(`topic=${ev.topic}`);
  if (ev.artifact !== undefined) parts.push(`artifact=${ev.artifact}`);
  if (ev.transitionFrom !== undefined && ev.transitionTo !== undefined) {
    parts.push(`transition=${ev.transitionFrom}->${ev.transitionTo}`);
  }
  if (ev.reason !== undefined) parts.push(`reason=${ev.reason}`);
  if (ev.validFrom !== undefined) parts.push(`validFrom=${ev.validFrom}`);
  if (ev.validUntil !== undefined) parts.push(`validUntil=${ev.validUntil}`);
  if (ev.recordedAt !== undefined) parts.push(`recordedAt=${ev.recordedAt}`);
  const dreamCounts = renderDreamSummary(ev.dreamSummary);
  if (dreamCounts !== undefined) parts.push(dreamCounts);

  if (parts.length > 0) return parts.join(" ");

  const pointer = ev.source.line !== null ? `${ev.source.path}:${ev.source.line}` : ev.source.path;
  return `${ev.kind} (${pointer})`;
}

function renderDreamSummary(summary: DreamSummarySlots | undefined): string | undefined {
  if (summary === undefined) return undefined;
  const counts: string[] = [];
  if (summary.newUnconfirmed !== undefined) counts.push(`new=${summary.newUnconfirmed.length}`);
  if (summary.confirmed !== undefined) counts.push(`confirmed=${summary.confirmed.length}`);
  if (summary.retired !== undefined) counts.push(`retired=${summary.retired.length}`);
  return counts.length > 0 ? counts.join(" ") : undefined;
}
