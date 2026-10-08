/**
 * Correction end-state policy (truth-correctable-time-aware, contract
 * item 2): the one pure decision of HOW a corrected predecessor
 * retires. A flatly-wrong claim was never true, so it tombstones -
 * hidden everywhere, which makes the serve-with-correction invariant
 * vacuous for it by design (nothing surfaces, correction included).
 * Every other correction merely supersedes: validity closes at the
 * explicit window end when the correction is time-scoped, else at the
 * correction instant, leaving the predecessor serveable inside its
 * historical window - the only regime where serve-with-correction is
 * non-trivial.
 *
 * The choice is recorded per target by the correct verb using the
 * existing receipt reason codes (`supersede` for validity_close,
 * `tombstone` for tombstone). Succession and path-provenance consume
 * the outcome through the ledger/frontmatter data, never through this
 * module: a validity-closed predecessor against its successor carries
 * non-overlapping present windows and classifies as succession under
 * contract item 1.
 *
 * `validUntil` passes through verbatim - this decision stays pure. The
 * correct sweep validates `windowEnd` at its own boundary with the same
 * check the ledger append boundary applies (a bare ISO date or a
 * canonical UTC timestamp), and refuses a malformed bound with a
 * CorrectionError before anything is written; the ledger append keeps
 * naming a malformed bound it is handed directly. Pure, deterministic,
 * no I/O, no clock.
 */

/** How a corrected predecessor retires. */
export type CorrectionEndState = "validity_close" | "tombstone";

export interface CorrectionEndStateInput {
  /** The caller declares the prior claim was never true, not merely superseded. */
  readonly flatlyWrong: boolean;
  /** Explicit window end for a time-scoped correction (canonical ISO-8601 UTC). */
  readonly windowEnd?: string;
}

export interface CorrectionEndStateOutcome {
  readonly endState: CorrectionEndState;
  readonly validUntil: string | null;
}

/**
 * Decide the end state of one corrected target. `flatlyWrong` yields
 * `{ endState: "tombstone", validUntil: null }` outright; any other
 * input yields `{ endState: "validity_close", validUntil: windowEnd ??
 * correctionTs }`.
 */
export function correctionEndState(
  input: CorrectionEndStateInput,
  correctionTs: string,
): CorrectionEndStateOutcome {
  if (input.flatlyWrong) return Object.freeze({ endState: "tombstone", validUntil: null });
  return Object.freeze({
    endState: "validity_close",
    validUntil: input.windowEnd ?? correctionTs,
  });
}
