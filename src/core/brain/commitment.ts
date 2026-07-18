/**
 * Commitment-tier vocabulary (Belief lifecycle suite, B3, t_e112c63c).
 *
 * A commitment tier is an OPTIONAL, operator-facing epistemic stance on a
 * belief: how firmly the memory is held, independent of the numeric
 * confidence the dream pass computes from evidence. The four-value
 * ladder runs from tentative to fixed:
 *
 *   exploring -> leaning -> decided -> locked
 *
 * It is additive on preferences, theses, and decision records. When set,
 * the injection formatter renders the tier label in place of the raw
 * confidence float; when unset, output is byte-identical to today. This
 * module is the single source of truth for the vocabulary, the typed
 * error, the write-time validator, and the tolerant reader, so the three
 * note families cannot drift.
 */

import { BRAIN_COMMITMENT_TIER, isCommitmentTier, type BrainCommitmentTier } from "./types.ts";

export { BRAIN_COMMITMENT_TIER, isCommitmentTier, type BrainCommitmentTier } from "./types.ts";

const COMMITMENT_TIER_VALUES: ReadonlyArray<BrainCommitmentTier> =
  Object.values(BRAIN_COMMITMENT_TIER);

/** Frontmatter key under which the tier is stored (unprefixed, user-editable). */
export const COMMITMENT_TIER_KEY = "commitment";

/** Typed error for an invalid commitment tier on the write path. */
export class CommitmentError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CommitmentError";
  }
}

/**
 * Validate a caller-supplied commitment tier on the WRITE path. Returns
 * the narrowed tier, or `null` for an absent/blank value (unset is
 * always legal - the field is optional). An invalid non-empty value
 * rejects with a {@link CommitmentError}.
 */
export function validateCommitmentTier(raw: unknown): BrainCommitmentTier | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === "string" && raw.trim() === "") return null;
  if (isCommitmentTier(raw)) return raw;
  throw new CommitmentError(
    `commitment must be one of ${COMMITMENT_TIER_VALUES.join(", ")} (got ${JSON.stringify(raw)})`,
  );
}

/**
 * Tolerant READ of the commitment tier from a parsed frontmatter map.
 * Returns the tier when the stored value is valid, otherwise `null` - a
 * hand-edited junk value never crashes parsing of the whole note.
 */
export function readCommitmentTier(
  meta: Readonly<Record<string, unknown>>,
): BrainCommitmentTier | null {
  const value = meta[COMMITMENT_TIER_KEY];
  return isCommitmentTier(value) ? value : null;
}
