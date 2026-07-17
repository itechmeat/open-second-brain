/**
 * Aggregate trust verdict (v0.10.16).
 *
 * Compresses three independent signals - doctor errors / warnings,
 * dream warnings, verification-delta counts - into one of three
 * states an operator can act on at a glance.
 *
 * Threshold model:
 *   - `investigate` - any doctor error; any regression; any
 *                     missing_evidence; or drift count above the
 *                     `driftWatchThreshold` (default 3).
 *   - `watch`       - any doctor warning; any dream warning; or
 *                     drift count between 1 and the threshold.
 *   - `clean`       - none of the above. Confirmed verification
 *                     entries never downgrade the verdict (they
 *                     are the positive case).
 */

import type { DreamWarning } from "../dream.ts";
import type { DoctorIssue, TrustVerdict } from "../types.ts";
import type { VerificationDeltaSummaryCounts } from "./compute-verification-delta.ts";

const DEFAULT_DRIFT_WATCH_THRESHOLD = 3;

export interface TrustVerdictInput {
  readonly doctorWarnings: ReadonlyArray<DoctorIssue>;
  readonly doctorErrors: ReadonlyArray<DoctorIssue>;
  readonly dreamWarnings: ReadonlyArray<DreamWarning>;
  readonly verification: VerificationDeltaSummaryCounts;
  /**
   * Inclusive upper bound on drift count for the `watch` band.
   * Above this, drift contributes to `investigate`. Defaults to 3.
   */
  readonly driftWatchThreshold?: number;
}

export function computeTrustVerdict(input: TrustVerdictInput): TrustVerdict {
  const threshold = input.driftWatchThreshold ?? DEFAULT_DRIFT_WATCH_THRESHOLD;

  if (
    input.doctorErrors.length > 0 ||
    input.verification.regression > 0 ||
    input.verification.missing_evidence > 0 ||
    input.verification.drift > threshold
  ) {
    return "investigate";
  }

  if (
    input.doctorWarnings.length > 0 ||
    input.dreamWarnings.length > 0 ||
    input.verification.drift > 0
  ) {
    return "watch";
  }

  return "clean";
}
