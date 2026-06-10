/**
 * Hygiene scan - read-only composition over the detector registry
 * (continuity-hygiene-freshness suite; kanban t_698db8f7).
 *
 * Runs the requested detectors (default: all), folds their findings
 * into one frozen digest with per-detector counts, and converts a
 * thrown detector into an `errors` entry instead of failing the scan.
 * The scan never mutates the vault; remediation lives in `apply.ts`.
 */

import { detectConflicts } from "./detectors/conflicts.ts";
import { detectDedup } from "./detectors/dedup.ts";
import { detectFreshness } from "./detectors/freshness.ts";
import { detectUsefulness } from "./detectors/usefulness.ts";
import {
  HYGIENE_DETECTOR_IDS,
  type HygieneDetector,
  type HygieneDetectorId,
  type HygieneFinding,
  type HygieneScanError,
  type HygieneScanReport,
} from "./types.ts";

const DETECTORS: Readonly<Record<HygieneDetectorId, HygieneDetector>> = Object.freeze({
  conflicts: (vault) => detectConflicts(vault),
  dedup: (vault, ctx) => detectDedup(vault, ctx),
  freshness: (vault) => detectFreshness(vault),
  usefulness: (vault, ctx) => detectUsefulness(vault, ctx),
});

export interface RunHygieneScanOptions {
  /** Detector subset to run; defaults to every registered detector. */
  readonly detectors?: ReadonlyArray<HygieneDetectorId>;
  /** Injected clock. */
  readonly now: Date;
}

export function runHygieneScan(vault: string, opts: RunHygieneScanOptions): HygieneScanReport {
  const requested =
    opts.detectors !== undefined && opts.detectors.length > 0
      ? HYGIENE_DETECTOR_IDS.filter((id) => opts.detectors!.includes(id))
      : HYGIENE_DETECTOR_IDS;

  const findings: HygieneFinding[] = [];
  const errors: HygieneScanError[] = [];
  const counts: Partial<Record<HygieneDetectorId, number>> = {};

  for (const id of requested) {
    try {
      const detected = DETECTORS[id](vault, { now: opts.now });
      counts[id] = detected.length;
      findings.push(...detected);
    } catch (error) {
      counts[id] = 0;
      errors.push(
        Object.freeze({
          detector: id,
          message: error instanceof Error ? error.message : "detector failed",
        }),
      );
    }
  }

  return Object.freeze({
    generated_at: opts.now.toISOString(),
    detectors_run: Object.freeze([...requested]),
    findings: Object.freeze(findings),
    counts: Object.freeze(counts),
    errors: Object.freeze(errors),
  });
}
