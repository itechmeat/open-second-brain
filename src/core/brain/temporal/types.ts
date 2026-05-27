/**
 * Temporal subsystem atoms (v0.10.18).
 *
 * Defines the data shapes the temporal/synthesis subsystem materializes
 * once per invocation. Every projection helper (`selectEvents`,
 * `buildBeliefEvolution`, `findStaleEntries`, `buildDailyBrief`,
 * `buildWeeklySynthesis`) consumes `TimelineIndex`; the index itself
 * is built once from disk by `buildTimelineIndex`.
 *
 * Design anchor: `docs/brainstorm/temporal-synthesis/design.md`.
 */

import type { BrainApplyResult, BrainLogEventKind, BrainPreferenceStatus } from "../types.ts";

/**
 * Vault-relative location an event was sourced from. The reader keeps
 * the path + line number when known so the timeline carries an audit
 * pointer back to the originating row. Markdown-fallback rows from
 * `parseLogDay` set `line` to `null` because the markdown parser does
 * not track per-event line offsets.
 */
export interface TemporalEventSource {
  readonly path: string;
  readonly line: number | null;
}

/**
 * Denormalised slice of the `dream` summary event body that downstream
 * consumers (belief-evolution) need to attribute per-preference status
 * transitions without re-touching disk. Populated only on events of
 * kind `dream`. Each array carries the original wikilink strings (e.g.
 * `[[pref-foo|Principle]]` or `[[ret-foo|Principle]] (reason)`) so
 * consumers can resolve the prefId and any inline reason themselves.
 */
export interface DreamSummarySlots {
  readonly newUnconfirmed?: ReadonlyArray<string>;
  readonly confirmed?: ReadonlyArray<string>;
  readonly retired?: ReadonlyArray<string>;
}

/**
 * One normalized chronological event. Flat shape - optional slots are
 * populated when the source row carries the corresponding field. The
 * `kind` slot reuses the existing `BrainLogEventKind` enum verbatim so
 * downstream consumers can switch on a single discriminator without a
 * new vocabulary table.
 */
export interface TemporalEvent {
  /**
   * Canonical UTC ISO-8601 timestamp. Sub-second precision preserved
   * when the source row carried it. Always Z-suffixed.
   */
  readonly at: string;
  /** Event kind enum from `BRAIN_LOG_EVENT_KIND`. */
  readonly kind: BrainLogEventKind;
  /** Source row pointer for audit. */
  readonly source: TemporalEventSource;
  /** Preference id when the event scopes to one. */
  readonly prefId?: string;
  /** Topic slug when the event scopes to one. */
  readonly topic?: string;
  /** `apply-evidence` payload `result`. */
  readonly result?: BrainApplyResult;
  /** Artifact wikilink the evidence event references. */
  readonly artifact?: string;
  /** Status transition source (for `promote` / `retire` / `force-confirmed` / `reject`). */
  readonly transitionFrom?: BrainPreferenceStatus;
  /** Status transition target. */
  readonly transitionTo?: BrainPreferenceStatus;
  /** Free-form reason (retire reason, suppression reason, etc.). */
  readonly reason?: string;
  /** Narrative text for `note` events. */
  readonly text?: string;
  /** Bi-temporal: event-time start (from frontmatter `valid_from`). */
  readonly validFrom?: string;
  /** Bi-temporal: event-time end (from frontmatter `valid_until`). */
  readonly validUntil?: string;
  /** Bi-temporal: transaction-time (frontmatter `recorded_at`). */
  readonly recordedAt?: string;
  /**
   * Populated only when `kind === "dream"`. Carries the array payload
   * slices (`new_unconfirmed`, `confirmed`, `retired`) required by
   * belief-evolution to derive per-preference status transitions.
   */
  readonly dreamSummary?: DreamSummarySlots;
}

/** Window that produced a {@link TimelineIndex}. */
export interface TimelineWindow {
  /** Inclusive lower bound, canonical UTC ISO. */
  readonly since: string;
  /** Exclusive upper bound, canonical UTC ISO. */
  readonly until: string;
}

/**
 * Frozen materialized view of all events in a requested window. Every
 * projection helper takes a `TimelineIndex` and never re-touches disk
 * so the five helpers (timeline-reader, belief-evolution, stale-watch,
 * daily-brief, weekly-brief) observe one canonical window semantics.
 *
 * Groups use `ReadonlyMap` so key lookups stay strongly typed
 * (`BrainLogEventKind` for `eventsByKind`, free-form ids for
 * `eventsByPrefId` / `eventsByTopic`) without runtime key shape
 * gymnastics or escape hatches.
 */
export interface TimelineIndex {
  /**
   * Chronological list of events. Sorted by `at` ascending; ties
   * broken by `source.path` then `source.line` for determinism.
   */
  readonly events: ReadonlyArray<TemporalEvent>;
  /** Events grouped by `kind`. */
  readonly eventsByKind: ReadonlyMap<BrainLogEventKind, ReadonlyArray<TemporalEvent>>;
  /** Events grouped by `prefId` (only events that carry one). */
  readonly eventsByPrefId: ReadonlyMap<string, ReadonlyArray<TemporalEvent>>;
  /** Events grouped by `topic` (only events that carry one). */
  readonly eventsByTopic: ReadonlyMap<string, ReadonlyArray<TemporalEvent>>;
  /** Window the index was materialized for. */
  readonly window: TimelineWindow;
}
