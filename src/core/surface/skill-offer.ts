/**
 * Skill offer identity (t_ccb05134).
 *
 * Skill invocation was already observed - the session importer writes a
 * `skill_invoked` continuity record for every real skill fetch. What was
 * missing is the other end of the arrow: an invocation carried nothing
 * naming the offer that produced it, so the two could never be joined and
 * the efficacy chain could not advance past its first link.
 *
 * An offer is the set of skills `skills_attach` put in front of an agent for
 * one turn. Its identity is content-addressed over the offer itself - the
 * normalised turn text plus the offered (name, path) pairs in rank order -
 * through the repository's one canonical-JSON digest helper. Two
 * consequences follow, and both are the point:
 *
 *   - The id is reproducible. Anyone holding the offer can recompute it, so
 *     no offer store has to exist for the join to be verifiable.
 *   - The id is specific. A different turn, a different offered set, or a
 *     different rank order is a different offer, so an id cannot be replayed
 *     across turns to claim credit for an offer that was never made.
 *
 * The id an invocation carries is the AGENT'S CLAIM about where the
 * invocation came from - there are no credentials in this system and none
 * are implied here. What the id buys is a claim that is checkable (it must
 * be well formed, and it must match an offer that can be recomputed),
 * rather than no claim at all.
 */

import { computePayloadHash } from "../brain/idempotency-ledger.ts";

/** Payload / tool-argument key carrying an offer id. */
export const SKILL_OFFER_ID_KEY = "offer_id";

/**
 * Hex characters kept from the digest. Long enough that an accidental
 * collision across a vault's offers is not a practical concern, short
 * enough to sit in a rendered attach block an agent has to quote back.
 */
export const SKILL_OFFER_ID_LENGTH = 16;

const OFFER_ID_PATTERN = new RegExp(`^[0-9a-f]{${SKILL_OFFER_ID_LENGTH}}$`);

/** The part of an offered skill that identifies it: which skill, from where. */
export interface SkillOfferedItem {
  readonly name: string;
  readonly path: string;
}

/**
 * Content-addressed id for one offer. The query is trimmed and its internal
 * whitespace collapsed so a turn reformatted by a host runtime still yields
 * the same offer; everything else is taken verbatim, in the order offered.
 */
export function computeSkillOfferId(query: string, items: ReadonlyArray<SkillOfferedItem>): string {
  const normalisedQuery = query.trim().replace(/\s+/gu, " ");
  return computePayloadHash({
    query: normalisedQuery,
    // An array preserves rank order under the canonical encoding, which a
    // keyed object would not.
    offered: items.map((item) => [item.name, item.path]),
  }).slice(0, SKILL_OFFER_ID_LENGTH);
}

/** Whether a value is a well-formed offer id. */
export function isSkillOfferId(value: unknown): value is string {
  return typeof value === "string" && OFFER_ID_PATTERN.test(value);
}

/**
 * Lift the cited offer id out of a tool call's input, or null when the call
 * cited none. A value that is present but not a well-formed offer id is not
 * an offer either: it names nothing that could have been offered, so it is
 * reported the same as absence rather than stamped onto a record where it
 * would read as provenance. Surfaces that can refuse the caller outright
 * (the `get_skill` tool) use {@link isSkillOfferId} and say so instead; this
 * reader exists for a historical session log, which cannot be refused.
 */
export function readSkillOfferId(
  input: Readonly<Record<string, unknown>> | undefined | null,
): string | null {
  if (input === undefined || input === null) return null;
  const value = input[SKILL_OFFER_ID_KEY];
  return isSkillOfferId(value) ? value : null;
}
