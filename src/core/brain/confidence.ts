/**
 * Deterministic preference-confidence computation for the dream pass.
 *
 * Extracted from dream.ts: the Wilson-bound derivation and band
 * mapping are pure functions of the evidence counters and config, so
 * they live apart from the orchestration that consumes them.
 */

import { BRAIN_CONFIDENCE, type BrainConfidence, type BrainConfig } from "./types.ts";

/**
 * Confidence computation. Returns both the numeric value and the
 * categorical band derived from it.
 *
 * `value = wilson_low(applied, n) * freshness`:
 *
 *   - `wilson_low(applied, n)` where `n = applied + violated` -
 *     a conservative 95% lower bound on the application rate.
 *     `n == 0` yields `0`.
 *   - `freshness` linearly decays from `1.0` at age 0 to `0.0` at
 *     `retire.stale_evidence_days`. `null` last_evidence_at → `0`.
 *
 * Band thresholds (`confidence.medium_min`, `confidence.high_min`)
 * are applied to `value` directly. The numeric value is what the
 * digest's drop tracker compares across runs.
 */
export interface ConfidenceComputeResult {
  readonly value: number;
  readonly band: BrainConfidence;
}

export const BAND_RANK: Readonly<Record<BrainConfidence, number>> = Object.freeze({
  low: 0,
  medium: 1,
  high: 2,
});

export function computeConfidence(
  applied: number,
  violated: number,
  lastEvidenceAt: string | null,
  cfg: BrainConfig,
  now: Date,
): ConfidenceComputeResult {
  const n = applied + violated;
  let wilsonLow = 0;
  if (n > 0) {
    const z = 1.96;
    const z2 = z * z;
    const pHat = applied / n;
    const denom = 1 + z2 / n;
    const centre = (pHat + z2 / (2 * n)) / denom;
    const margin = (z * Math.sqrt((pHat * (1 - pHat)) / n + z2 / (4 * n * n))) / denom;
    wilsonLow = Math.max(0, centre - margin);
  }
  let freshness = 0;
  if (lastEvidenceAt) {
    const ageMs = now.getTime() - Date.parse(lastEvidenceAt);
    if (Number.isFinite(ageMs)) {
      const limitMs = cfg.retire.stale_evidence_days * 24 * 3600 * 1000;
      if (limitMs > 0) {
        freshness = Math.max(0, Math.min(1, 1 - ageMs / limitMs));
      }
    }
  }
  const rawValue = wilsonLow * freshness;
  const value = Math.round(rawValue * 10000) / 10000;

  let band: BrainConfidence;
  if (value >= cfg.confidence.high_min) {
    band = BRAIN_CONFIDENCE.high;
  } else if (value >= cfg.confidence.medium_min) {
    band = BRAIN_CONFIDENCE.medium;
  } else {
    band = BRAIN_CONFIDENCE.low;
  }
  return Object.freeze({ value, band });
}

/** Re-derive the confidence band for an externally adjusted value. */
export function rebandConfidence(value: number, cfg: BrainConfig): ConfidenceComputeResult {
  let band: BrainConfidence;
  if (value >= cfg.confidence.high_min) {
    band = BRAIN_CONFIDENCE.high;
  } else if (value >= cfg.confidence.medium_min) {
    band = BRAIN_CONFIDENCE.medium;
  } else {
    band = BRAIN_CONFIDENCE.low;
  }
  return Object.freeze({ value, band });
}
