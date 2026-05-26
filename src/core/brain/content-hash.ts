/**
 * Content-hash helper for confirmed preferences.
 *
 * On promotion to `_status: confirmed`, the dream pass writes
 * `_content_hash: sha256(principle + scope)` into the frontmatter via
 * {@link computeContentHash}. Every subsequent read of a confirmed
 * preference recomputes the hash; {@link verifyContentHash} compares
 * stored vs. recomputed and tells the caller whether the on-disk
 * content has drifted away from what dream last sealed.
 *
 * Hand-editing a confirmed preference stays legal - drift detection
 * is observability, not enforcement. A mismatch surfaces as a
 * `drift_detected` event in `Brain/log/<today>.md` and as a counter
 * in `brain_doctor`. The read returns the live content unchanged.
 *
 * Normalisation rules baked into the digest input:
 *   - principle and scope are trimmed of leading/trailing whitespace
 *   - absent / empty / undefined scope normalises to the empty string
 *
 * Both rules keep the hash stable across the frontmatter round-trip
 * and across the writer's "skip emit for blank scope" semantic.
 */

import { createHash } from "node:crypto";

const SEPARATOR = "\n";

/**
 * Compute the canonical content hash for a preference's
 * (principle, scope) pair. Returns a 64-char lowercase hex sha256.
 */
export function computeContentHash(principle: string, scope?: string): string {
  const normalisedPrinciple = (principle ?? "").trim();
  const normalisedScope = (scope ?? "").trim();
  const payload = `${normalisedPrinciple}${SEPARATOR}${normalisedScope}`;
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

/**
 * Input shape for {@link verifyContentHash}. A pared-down view of
 * {@link BrainPreference} that takes only the three fields the hash
 * compares - so the helper can be called either with a parsed
 * `BrainPreference` (with the matching field names) or with a fresh
 * `{principle, scope, content_hash}` synthesised from elsewhere.
 */
export interface ContentHashInput {
  readonly principle: string;
  readonly scope?: string;
  readonly content_hash?: string;
}

export interface ContentHashVerification {
  /**
   * `true` when stored hash matches recomputed, OR when the stored
   * hash is absent (legacy preference written before this field
   * existed - we cannot detect drift, so we do not lie about it).
   */
  readonly ok: boolean;
  /** Recomputed hash; undefined when the input had no stored hash to compare against. */
  readonly expected?: string;
  /** Stored hash from frontmatter; undefined when the input had none. */
  readonly observed?: string;
}

/**
 * Compare the stored `_content_hash` against the recomputed hash of
 * the live (principle, scope) pair. When the stored value is absent
 * the result is neutral (`ok: true`, no expected/observed) - the
 * caller MUST NOT log a drift event in that case.
 */
export function verifyContentHash(
  input: ContentHashInput,
): ContentHashVerification {
  if (!input.content_hash) {
    return { ok: true };
  }
  const expected = computeContentHash(input.principle, input.scope);
  return {
    ok: expected === input.content_hash,
    expected,
    observed: input.content_hash,
  };
}
