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
 * The `unknown` cases carry the load. A snapshot with no derived-store
 * record recorded nothing, so nothing may be claimed, and rendering it as
 * `excluded` would state a decision that was never made - just as
 * rendering an unreadable snapshots directory as an empty one would state
 * a listing that never happened.
 */

import type { BrainManifestDerivedStore } from "../../core/brain/manifest.ts";
import {
  describeSnapshotEntrySkip,
  type BrainSnapshotListingError,
  type RestoreDerivedStoreResult,
  type SnapshotEntrySkip,
} from "../../core/brain/snapshot.ts";

/**
 * What both surfaces print where a value was never recorded. Shared so
 * the two cannot drift into `unknown` and `unrecorded`.
 */
export const SNAPSHOT_UNKNOWN_LABEL = "unknown";

/** Printed when an exclusion reason is missing from a record that has one. */
const UNSPECIFIED_EXCLUSION_LABEL = "unspecified";

/** Said in every not-replaced case, so no operator has to infer it. */
const LIVE_STORE_UNTOUCHED = "live store left untouched";

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

/**
 * One-line outcome for a completed restore, and the one place the
 * no-record case is put into words.
 *
 * That case used to be a single sentence - "snapshot predates
 * derived-store coverage" - for two different facts. The sidecar write is
 * non-fatal at snapshot time, so a snapshot can carry a store archive and
 * no record of it, and the restore then reported a manufactured reason:
 * it named the feature as absent while the feature's own archive sat next
 * to the tar. The archive probe splits them, and neither sentence claims
 * more than the disk supports - a snapshot with no record and no archive
 * is not evidence of WHEN it was taken either, only that nothing was
 * archived and nothing was recorded.
 */
export function renderDerivedStoreRestore(outcome: RestoreDerivedStoreResult): string {
  if (outcome.replaced) return `replaced ${outcome.path ?? ""}`.trimEnd();
  if (!outcome.coverage_known) {
    return outcome.store_archive_present
      ? `record missing (a store archive is on disk beside the snapshot, so coverage ran and ` +
          `its record did not survive); ${LIVE_STORE_UNTOUCHED}`
      : `${SNAPSHOT_UNKNOWN_LABEL} (no derived-store record and no store archive for this ` +
          `snapshot); ${LIVE_STORE_UNTOUCHED}`;
  }
  return `not restored (${outcome.exclusion_reason ?? UNSPECIFIED_EXCLUSION_LABEL}); ${LIVE_STORE_UNTOUCHED}`;
}

/**
 * Wording for a snapshots directory that exists and could not be read.
 *
 * Both listing surfaces need it and neither may fall back to their
 * empty-history line, so the sentence lives here with the rest of the
 * shared vocabulary rather than being spelled twice.
 */
export function renderSnapshotListingFailure(err: BrainSnapshotListingError): string {
  return `${err.message}; an unreadable snapshots directory is not an empty history`;
}

/**
 * Wording for archives that ARE in the directory and are missing from the
 * listing below.
 *
 * Both listing surfaces need it for the same reason they need the sentence
 * above: a listing that quietly drops the archives it could not describe
 * reads exactly like a vault that never had them, and an operator hunting
 * the recovery point they took last week would act on the wrong one. It
 * does not fail the verb - the rows that survived are still the answer to
 * the question asked - so it goes to stderr while the listing goes to
 * stdout, and both `--json` payloads carry the same entries as data.
 */
export function renderSnapshotListingSkips(skipped: ReadonlyArray<SnapshotEntrySkip>): string {
  return (
    `warning: ${skipped.length} archive(s) in the snapshots directory could not be listed, so ` +
    `this listing is INCOMPLETE: ${skipped.map(describeSnapshotEntrySkip).join(", ")}`
  );
}
