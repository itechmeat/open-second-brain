/**
 * Hygiene scan - read-only composition over the detector registry
 * (continuity-hygiene-freshness suite; kanban t_698db8f7).
 *
 * Runs the requested detectors (default: the `DEFAULT_SCAN_IDS` sweep -
 * NOT necessarily every registered detector; an explicit subset filters
 * over all registered ids), folds their findings into one frozen digest
 * with per-detector counts, and converts a thrown detector into an
 * `errors` entry instead of failing the scan. The scan never mutates
 * the vault; remediation lives in `apply.ts`.
 */

import { detectConflicts } from "./detectors/conflicts.ts";
import { detectDedup } from "./detectors/dedup.ts";
import { detectFreshness } from "./detectors/freshness.ts";
import { detectSlugCollisions } from "./detectors/slug-collisions.ts";
import { detectTags } from "./detectors/tags.ts";
import { detectUsefulness } from "./detectors/usefulness.ts";
import {
  DEFAULT_SCAN_IDS,
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
  "slug-collisions": (vault) => detectSlugCollisions(vault),
  tags: (vault) => detectTags(vault),
});

export interface RunHygieneScanOptions {
  /**
   * Detector subset to run; defaults to the `DEFAULT_SCAN_IDS` sweep. An
   * explicit subset filters over ALL registered ids, so a registered
   * detector excluded from the default sweep still runs when named here.
   */
  readonly detectors?: ReadonlyArray<HygieneDetectorId>;
  /** Injected clock. */
  readonly now: Date;
}

export function runHygieneScan(vault: string, opts: RunHygieneScanOptions): HygieneScanReport {
  const requested =
    opts.detectors !== undefined && opts.detectors.length > 0
      ? HYGIENE_DETECTOR_IDS.filter((id) => opts.detectors!.includes(id))
      : DEFAULT_SCAN_IDS;

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
