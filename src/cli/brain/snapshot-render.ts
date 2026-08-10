/**
 * The words two surfaces use for one snapshot record.
 *
 * `o2b brain snapshot log` and `o2b brain rollback --list` both answer
 * "why was this taken" and "does it cover the derived store", and both
 * shipped their own copy of the answer. The copies had already begun to
 * disagree: one drew the no-record case from a named constant and the
 * other from a bare literal, and only one of them showed the archive
 * size. Two renderings of one vocabulary is how a surface starts telling
 * an operator two different things about the same file, which is the
 * defect class this release is about - so they live here, once.
 *
 * The `unknown` case carries the load. A snapshot with no derived-store
 * record predates the feature: nothing checked, so nothing may be
 * claimed, and rendering it as `excluded` would state a decision that was
 * never made.
 */

import type { BrainManifestDerivedStore } from "../../core/brain/manifest.ts";

/**
 * What both surfaces print where a value was never recorded. Shared so
 * the two cannot drift into `unknown` and `unrecorded`.
 */
export const SNAPSHOT_UNKNOWN_LABEL = "unknown";

/** Printed when an exclusion reason is missing from a record that has one. */
const UNSPECIFIED_EXCLUSION_LABEL = "unspecified";

/** Why a snapshot was taken, or the shared label when it went unrecorded. */
export function renderSnapshotReason(reason: string | null): string {
  return reason ?? SNAPSHOT_UNKNOWN_LABEL;
}

export interface DerivedStoreCoverageOptions {
  /**
   * Append the archived byte count to the included case. The listing
   * surface shows it because size is the cost an operator is deciding
   * about; the log surface has its own size column and would repeat it.
   */
  readonly withArchiveSize?: boolean;
}

/** One-column derived-store answer: included, excluded with a reason, or unknown. */
export function renderDerivedStoreCoverage(
  record: BrainManifestDerivedStore | null,
  opts: DerivedStoreCoverageOptions = {},
): string {
  if (record === null) return SNAPSHOT_UNKNOWN_LABEL;
  if (record.included) {
    return opts.withArchiveSize === true
      ? `included (${record.archive_size ?? 0} bytes)`
      : "included";
  }
  return `excluded (${record.exclusion_reason ?? UNSPECIFIED_EXCLUSION_LABEL})`;
}
