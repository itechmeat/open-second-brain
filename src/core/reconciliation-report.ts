/**
 * The wave's shared reconciliation vocabulary (nothing-writes-silently).
 *
 * Three unrelated lanes each need to answer the same question - "of what
 * we attempted, what did we actually get, and what fell out?" - without
 * inventing three spellings of it: the import read-back census (what a
 * sessions import claimed to write against what a post-import scan can
 * still find), the multi-artifact envelope write accounting (rollup /
 * diarization / design-note lanes that commit several artifacts from one
 * validated payload), and the embedder record-vs-data audit's third state
 * (what a recorded `index_state` row claims against what the vector store
 * actually holds). This module is that one shape, pure and dependency-free
 * so all three can import it without pulling in any lane's I/O.
 *
 * The rule the whole module exists to enforce: `missing` NAMES its keys.
 * There is no constructor here that accepts a bare count in place of the
 * array - `attempted: 40, found: 38` with no further detail is the
 * misleading no-op this wave removes, because it reads as accounted for
 * when two items simply vanished without anyone able to say which. Every
 * numeric input this module DOES accept (`attempted`, `found`) is
 * validated for exactly that reason: an unvalidated count is how a NaN or
 * a negative slips through the accounting and reports a lie as a number.
 */

/** One reconciliation report: what was attempted, found, and left out. */
export interface ReconciliationReport {
  /** Total items the operation attempted to write, read, or verify. */
  readonly attempted: number;
  /** Items confirmed present, written, or matching. */
  readonly found: number;
  /** Keys naming every item accounted for by neither of the above. */
  readonly missing: ReadonlyArray<string>;
}

/** Input to {@link buildReconciliationReport}, before validation. */
export interface ReconciliationReportInput {
  readonly attempted: number;
  readonly found: number;
  readonly missing: ReadonlyArray<string>;
}

/** Machine-readable reason {@link buildReconciliationReport} refused. */
export type ReconciliationReportErrorCode =
  | "invalid_count"
  | "found_exceeds_attempted"
  | "count_mismatch"
  | "duplicate_missing_key";

/**
 * A reconciliation report could not be built from the given numbers. Every
 * refusal names a `code` a caller can branch on and `details` a caller can
 * log without re-deriving them from the message string.
 */
export class ReconciliationReportError extends Error {
  readonly code: ReconciliationReportErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: ReconciliationReportErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "ReconciliationReportError";
    this.code = code;
    this.details = details;
  }
}

/** Refuses anything that is not a non-negative integer, naming the field. */
function requireCount(field: "attempted" | "found", value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new ReconciliationReportError(
      "invalid_count",
      `reconciliation report: ${field} must be a non-negative integer, got ${value}`,
      { field, value },
    );
  }
}

/**
 * Validate and freeze one reconciliation report. Refuses, by name:
 *
 * - `attempted` or `found` that is NaN, negative, or non-integer
 *   (`invalid_count`).
 * - `found` greater than `attempted` (`found_exceeds_attempted`) - a
 *   nonsensical claim independent of `missing`, checked before the
 *   accounting below so it is never masked by a `count_mismatch` instead.
 * - `attempted !== found + missing.length` (`count_mismatch`) - the named
 *   keys do not account for the gap between attempted and found.
 * - a key repeated inside `missing` (`duplicate_missing_key`) - a
 *   duplicate cannot both name a distinct absence and keep the count
 *   honest.
 *
 * `missing` is copied before freezing so the returned report cannot change
 * under a reference the caller kept.
 */
export function buildReconciliationReport(input: ReconciliationReportInput): ReconciliationReport {
  const { attempted, found, missing } = input;
  requireCount("attempted", attempted);
  requireCount("found", found);

  if (found > attempted) {
    throw new ReconciliationReportError(
      "found_exceeds_attempted",
      `reconciliation report: found (${found}) exceeds attempted (${attempted})`,
      { attempted, found },
    );
  }

  const seen = new Set<string>();
  for (const key of missing) {
    if (seen.has(key)) {
      throw new ReconciliationReportError(
        "duplicate_missing_key",
        `reconciliation report: missing names "${key}" more than once`,
        { key, missing },
      );
    }
    seen.add(key);
  }

  if (attempted !== found + missing.length) {
    throw new ReconciliationReportError(
      "count_mismatch",
      `reconciliation report: attempted (${attempted}) does not equal found (${found}) + missing.length (${missing.length})`,
      { attempted, found, missingCount: missing.length },
    );
  }

  return Object.freeze({ attempted, found, missing: Object.freeze([...missing]) });
}

/**
 * Closed outcome vocabulary derived from a reconciliation report.
 *
 * - `complete`: everything attempted was found; `missing` is empty.
 * - `partial`: `missing` names at least one key and no recorded claim
 *   contradicts the report's own numbers.
 * - `contradicted`: a recorded claim - a value some OTHER record asserts,
 *   such as an `index_state` row's declared dimension - disagrees with
 *   what this report itself measured. This is the embedder audit's third
 *   state: not "some items are missing" but "the record about them is
 *   itself wrong", which is worse than a plain shortfall because it is
 *   evidence of nothing rather than evidence of a gap.
 */
export const RECONCILIATION_OUTCOME = Object.freeze({
  complete: "complete",
  partial: "partial",
  contradicted: "contradicted",
});
export type ReconciliationOutcome =
  (typeof RECONCILIATION_OUTCOME)[keyof typeof RECONCILIATION_OUTCOME];

/**
 * The membership list, exported so a refusal or a schema can name the
 * vocabulary instead of restating it by hand.
 */
export const RECONCILIATION_OUTCOMES: ReadonlyArray<ReconciliationOutcome> = Object.freeze(
  Object.values(RECONCILIATION_OUTCOME),
);

/** Type-guard for the outcome union - used by writers and parsers alike. */
export function isReconciliationOutcome(value: unknown): value is ReconciliationOutcome {
  return (
    typeof value === "string" && (RECONCILIATION_OUTCOMES as ReadonlyArray<string>).includes(value)
  );
}

/**
 * What some other record claims about the same numbers a report measured
 * - e.g. an `index_state` row's declared `attempted`/`found` before this
 * report re-measured them from the vector store directly. Either field
 * may be omitted when that half of the claim was never recorded; an
 * omitted field cannot contradict anything.
 */
export interface ReconciliationRecordedClaim {
  readonly attempted?: number;
  readonly found?: number;
}

/**
 * Derive the closed outcome for a report, deterministically. `missing`
 * alone decides `complete` versus `partial`; a `recordedClaim` that
 * disagrees with the report's own `attempted` or `found` always wins as
 * `contradicted`, even over an otherwise-clean report, because a record
 * asserting numbers the data itself disproves is not "complete with a
 * stale label" - it is the third state this vocabulary exists to name.
 */
export function deriveReconciliationOutcome(
  report: ReconciliationReport,
  recordedClaim?: ReconciliationRecordedClaim,
): ReconciliationOutcome {
  if (recordedClaim !== undefined) {
    const { attempted: claimedAttempted, found: claimedFound } = recordedClaim;
    if (claimedAttempted !== undefined && claimedAttempted !== report.attempted) {
      return RECONCILIATION_OUTCOME.contradicted;
    }
    if (claimedFound !== undefined && claimedFound !== report.found) {
      return RECONCILIATION_OUTCOME.contradicted;
    }
  }
  return report.missing.length === 0
    ? RECONCILIATION_OUTCOME.complete
    : RECONCILIATION_OUTCOME.partial;
}
