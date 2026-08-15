/**
 * The untrusted-provenance marker: one spelling, one reader, one writer.
 *
 * The retrieval trust gate has always branched on an `untrusted_source`
 * frontmatter key, and until this unit nothing in the repository wrote it -
 * the only other occurrences were two tests hand-constructing the field. A
 * gate branch reachable only from a key no writer produces is not a gate.
 * This module is the seam that closes it: the intake boundary stamps the
 * marker through {@link untrustedSourceFrontmatter}, and the gate reads it
 * through {@link hasUntrustedSourceMarker}, so the two halves cannot drift
 * apart over the spelling of a token.
 *
 * A deliberate leaf: it imports the delimiter module for the token name and
 * nothing else, so both the trust layer (which reads) and the entity
 * registry (which writes) can depend on it without an initialisation-order
 * loop.
 */

import type { FrontmatterMap } from "../../types.ts";
import { UNTRUSTED_SOURCE_TAG } from "../untrusted-source.ts";

/**
 * Whether content entering the vault carries the vault's own authority.
 *
 * Structural, and orthogonal to `ProvenanceLevel`: that vocabulary bands how
 * a conclusion was DERIVED (stated / deduced / inferred), which says nothing
 * about where the material came from. A scraped page states its claims just
 * as firmly as the operator states theirs; what differs is who is entitled
 * to have put them in the vault.
 */
export const INTAKE_TRUST = {
  /** Named a location inside the operator's own vault. */
  trusted: "trusted",
  /** Named an address outside it, or no location this vault owns. */
  untrusted: "untrusted",
} as const;

export type IntakeTrust = (typeof INTAKE_TRUST)[keyof typeof INTAKE_TRUST];

/**
 * The frontmatter key marking a page whose content entered under untrusted
 * provenance.
 *
 * Deliberately the same token as the delimiter tag: a page carrying the
 * marker and a span wrapped in `<untrusted_source>` are the same claim about
 * the same material, made at write time and at model-payload time, and the
 * gate already reads this name. Bound to the delimiter constant rather than
 * respelled so the two can never diverge.
 */
export const UNTRUSTED_SOURCE_FRONTMATTER_KEY = UNTRUSTED_SOURCE_TAG;

/**
 * The frontmatter key recording the SHA-256 of the source bytes a trusted
 * intake was classified against.
 *
 * An AUDIT RECORD, not a gate. Nothing in this release reads it back, and that
 * is deliberate rather than unfinished: the same shape as the preference
 * content hash in `content-hash.ts`, which is written on promotion and only
 * ever compared to report drift, never to refuse a read. Recording the digest
 * costs one frontmatter line and answers, later, which bytes the caller
 * claimed this extraction came from - a question that had no answer at all
 * while trust was decided from a path string. Turning it into a gate would be
 * a second decision (what does a changed source mean for entities already
 * written?) and is not made here.
 *
 * Declared beside {@link UNTRUSTED_SOURCE_FRONTMATTER_KEY} because the two
 * travel together: the same writer merges both into the same extras map, so
 * one place owns both spellings.
 */
export const SOURCE_CONTENT_HASH_FRONTMATTER_KEY = "source_content_hash";

/**
 * Does this frontmatter declare untrusted provenance? Tolerant of the
 * boolean the writer emits and of the string form a hand edit or a YAML
 * round-trip can leave behind.
 */
export function hasUntrustedSourceMarker(meta: Readonly<Record<string, unknown>>): boolean {
  const value = meta[UNTRUSTED_SOURCE_FRONTMATTER_KEY];
  return value === true || value === "true";
}

/**
 * The frontmatter fragment a writer merges in for the given trust. Trusted
 * content adds NOTHING - an absent marker is the untouched, pre-existing
 * shape, so a trusted write stays byte-identical to one that never knew
 * about trust at all.
 */
export function untrustedSourceFrontmatter(trust: IntakeTrust): FrontmatterMap {
  return trust === INTAKE_TRUST.untrusted ? { [UNTRUSTED_SOURCE_FRONTMATTER_KEY]: true } : {};
}

/**
 * The frontmatter fragment recording the source content hash, when there is
 * one. An absent hash adds NOTHING rather than an empty key: a page whose
 * source had no bytes to hash should not carry a field claiming it was
 * hashed, and the page then stays byte-identical to one written before this
 * record existed.
 */
export function sourceContentHashFrontmatter(contentHash: string | undefined): FrontmatterMap {
  return contentHash === undefined ? {} : { [SOURCE_CONTENT_HASH_FRONTMATTER_KEY]: contentHash };
}
