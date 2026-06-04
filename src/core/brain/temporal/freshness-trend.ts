/**
 * Freshness-trend classification (Time-Aware Recall & Activation
 * Suite, t_ee09a6ce).
 *
 * Classifies a preference's evidence history into a directional trend
 * label - `new | strengthening | stable | weakening | stale` - from
 * the TIME DISTRIBUTION of its applied/violated/outdated events, not
 * just a last-touched timestamp. The window comparison (recent 30d vs
 * prior 30d) is the whole model: more recent applies than prior means
 * the rule is gaining evidence, rising violations or fading applies
 * means it is losing trust, and a long evidence silence means it needs
 * re-verification before being relied on.
 *
 * Pure function over `(events, createdAt, nowMs)` - no I/O, injected
 * clock, deterministic. Two call sites consume it: the belief-evolution
 * envelope (computed live) and the dream refresh pass (stamped into
 * preference frontmatter as `freshness_trend`, the Hindsight
 * "refreshed on each consolidation" contract).
 */

import type { BrainApplyResult } from "../types.ts";

export type FreshnessTrend = "new" | "strengthening" | "stable" | "weakening" | "stale";

/** All trend labels, for validation at parse boundaries. */
export const FRESHNESS_TRENDS: ReadonlyArray<FreshnessTrend> = Object.freeze([
  "new",
  "strengthening",
  "stable",
  "weakening",
  "stale",
]);

/** One evidence event the classifier consumes. */
export interface TrendEvidenceEvent {
  /** ISO-8601 UTC timestamp. */
  readonly at: string;
  readonly result: BrainApplyResult;
}

export interface TrendWindows {
  /** Width of the recent and prior comparison windows, in days. */
  readonly recentDays: number;
  /** Evidence silence beyond this many days reads as stale. */
  readonly staleDays: number;
  /** Preferences younger than this with no prior evidence read as new. */
  readonly newDays: number;
}

export const DEFAULT_TREND_WINDOWS: TrendWindows = Object.freeze({
  recentDays: 30,
  staleDays: 60,
  newDays: 14,
});

export interface ClassifyFreshnessTrendInput {
  /** Preference `created_at` (ISO), or null when unknown. */
  readonly createdAt: string | null;
  readonly events: ReadonlyArray<TrendEvidenceEvent>;
  /** Injected clock (unix ms). */
  readonly nowMs: number;
  readonly windows?: TrendWindows;
}

export interface FreshnessTrendReport {
  readonly trend: FreshnessTrend;
  readonly recentApplied: number;
  readonly recentViolated: number;
  readonly priorApplied: number;
  readonly priorViolated: number;
  /** ISO timestamp of the newest evidence event, or null. */
  readonly lastEvidenceAt: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function parseMs(at: string): number | null {
  const ms = Date.parse(at);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Classify one preference's evidence history. Violated and outdated
 * results both count against the rule (the same grouping the evidence
 * collector uses). Events with unparseable timestamps are skipped.
 */
export function classifyFreshnessTrend(input: ClassifyFreshnessTrendInput): FreshnessTrendReport {
  const w = input.windows ?? DEFAULT_TREND_WINDOWS;
  const recentStart = input.nowMs - w.recentDays * DAY_MS;
  const priorStart = input.nowMs - 2 * w.recentDays * DAY_MS;

  let recentApplied = 0;
  let recentViolated = 0;
  let priorApplied = 0;
  let priorViolated = 0;
  let lastEvidenceMs: number | null = null;
  let lastEvidenceAt: string | null = null;

  for (const ev of input.events) {
    const ms = parseMs(ev.at);
    if (ms === null || ms > input.nowMs) continue;
    if (lastEvidenceMs === null || ms > lastEvidenceMs) {
      lastEvidenceMs = ms;
      lastEvidenceAt = ev.at;
    }
    const against = ev.result === "violated" || ev.result === "outdated";
    if (ms >= recentStart) {
      if (against) recentViolated++;
      else recentApplied++;
    } else if (ms >= priorStart) {
      if (against) priorViolated++;
      else priorApplied++;
    }
  }

  const createdMs = input.createdAt !== null ? parseMs(input.createdAt) : null;
  const isYoung = createdMs !== null && input.nowMs - createdMs < w.newDays * DAY_MS;

  let trend: FreshnessTrend;
  if (lastEvidenceMs === null) {
    trend = isYoung ? "new" : "stale";
  } else if (input.nowMs - lastEvidenceMs > w.staleDays * DAY_MS) {
    trend = "stale";
  } else if (isYoung && priorApplied === 0 && priorViolated === 0) {
    trend = "new";
  } else if (recentViolated > priorViolated || recentApplied < priorApplied) {
    trend = "weakening";
  } else if (recentApplied > priorApplied) {
    trend = "strengthening";
  } else {
    trend = "stable";
  }

  return Object.freeze({
    trend,
    recentApplied,
    recentViolated,
    priorApplied,
    priorViolated,
    lastEvidenceAt,
  });
}

/** Parse a frontmatter `freshness_trend` value; junk reads as null. */
export function parseFreshnessTrend(raw: unknown): FreshnessTrend | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim().toLowerCase();
  return (FRESHNESS_TRENDS as ReadonlyArray<string>).includes(value)
    ? (value as FreshnessTrend)
    : null;
}
