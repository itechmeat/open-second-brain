/**
 * Batch-inflation detector.
 *
 * A bulk or concurrent ingestion session can promote many distinct
 * preferences in a short window without pausing to check whether they
 * should have been consolidated first. The existing
 * `duplicate-preferences` lint only catches pairs that are already
 * near-identical (Jaccard >= 0.7 on principle tokens within the same
 * topic/scope); it says nothing about a *burst* of individually
 * distinct new preferences landing together, which is the actual
 * signal that a batch ingest skipped its own dedup/consolidation pass
 * before confirming. This detector flags confirmed preferences whose
 * `confirmed_at` timestamps cluster within a configured window at or
 * above a configured count - a burst, not a duplicate - so an
 * operator (or the next dream pass) can review whether the batch
 * should have collapsed into fewer preferences.
 *
 * Non-overlapping, deterministic, pure: preferences are sorted by
 * `confirmed_at`, walked with a window anchored at each unconsumed
 * preference, and each burst at or above the threshold is reported
 * once, resuming the scan after the burst's last member so adjacent
 * bursts never double-report the same preference.
 */

import { BRAIN_PREFERENCE_STATUS, type BrainPreferenceStatus } from "../types.ts";
import { parseIsoUtc } from "./iso-time.ts";

const HOUR_MS = 60 * 60 * 1000;

/** Narrow projection the detector needs; {@link BrainPreference} satisfies it. */
export interface PreferenceForBatchInflation {
  readonly id: string;
  readonly status: BrainPreferenceStatus;
  readonly confirmed_at: string | null;
  readonly topic: string;
  readonly scope?: string;
}

export interface BatchInflationFinding {
  readonly ids: ReadonlyArray<string>;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly count: number;
  readonly topics: ReadonlyArray<string>;
}

export interface DetectBatchInflationOptions {
  /** Burst window width in hours. Default 24. */
  readonly windowHours?: number;
  /** Minimum preferences confirmed within the window to count as a burst. Default 5. */
  readonly minBurstSize?: number;
}

interface TimedPref {
  readonly id: string;
  readonly topic: string;
  readonly ms: number;
}

export function detectBatchInflation(
  prefs: ReadonlyArray<PreferenceForBatchInflation>,
  opts: DetectBatchInflationOptions = {},
): BatchInflationFinding[] {
  const windowMs = (opts.windowHours ?? 24) * HOUR_MS;
  const minBurstSize = opts.minBurstSize ?? 5;

  const confirmed: TimedPref[] = prefs
    .filter(
      (p): p is PreferenceForBatchInflation & { confirmed_at: string } =>
        p.status === BRAIN_PREFERENCE_STATUS.confirmed && p.confirmed_at !== null,
    )
    .map((p) => ({ id: p.id, topic: p.topic, ms: parseIsoUtc(p.confirmed_at) }))
    .filter((p) => Number.isFinite(p.ms))
    .toSorted((a, b) => a.ms - b.ms || a.id.localeCompare(b.id));

  const out: BatchInflationFinding[] = [];
  let i = 0;
  while (i < confirmed.length) {
    // Grow the window from anchor i while the next member stays within
    // windowMs of confirmed[i] (fixed-anchor window, not a re-anchoring
    // slide - keeps bursts deterministic and non-overlapping).
    let j = i;
    while (j + 1 < confirmed.length && confirmed[j + 1]!.ms - confirmed[i]!.ms <= windowMs) {
      j++;
    }
    const size = j - i + 1;
    if (size >= minBurstSize) {
      const members = confirmed.slice(i, j + 1);
      out.push({
        ids: members.map((m) => m.id),
        windowStart: new Date(confirmed[i]!.ms).toISOString(),
        windowEnd: new Date(confirmed[j]!.ms).toISOString(),
        count: size,
        topics: [...new Set(members.map((m) => m.topic))].toSorted(),
      });
      i = j + 1; // non-overlapping: resume after this burst
    } else {
      i++;
    }
  }
  return out;
}
