/**
 * Shared "sign of record" helper.
 *
 * A taste signal carries a polarity (`positive` / `negative`). A
 * preference inherits a derived sign from the signals it cites in
 * `evidenced_by` - the dominant polarity among them. This module is the
 * single definition of that derivation, lifted out of `dream.ts` so the
 * dream pass and the semantic-health contradiction detector agree on one
 * tie-break and one notion of "unresolved".
 *
 * Language-agnostic by construction: polarity comes from the signal's
 * structured `signal` field, never from inspecting principle text.
 */

import { BRAIN_SIGNAL_SIGN, type BrainSignalSign } from "./types.ts";
import { parseWikilink } from "./wikilink.ts";

/**
 * A resolved sign, or `"unknown"` when no evidence settles the polarity.
 * Callers decide how to treat unknown: the contradiction detector skips
 * such preferences; the dream pass falls back to its topic / heuristic
 * tiers.
 */
export type ResolvedSign = BrainSignalSign | "unknown";

/** Count positive vs negative signs in an iterable of polarities. */
export function countSigns(signs: Iterable<BrainSignalSign>): { pos: number; neg: number } {
  let pos = 0;
  let neg = 0;
  for (const s of signs) {
    if (s === BRAIN_SIGNAL_SIGN.positive) pos++;
    else if (s === BRAIN_SIGNAL_SIGN.negative) neg++;
  }
  return { pos, neg };
}

/**
 * Reduce a pos/neg tally to a dominant sign. A tie breaks to
 * `positive` - the same `pos >= neg` rule `dream.ts` has always used.
 * An all-zero tally is `"unknown"`.
 */
export function dominantSignFromCounts(pos: number, neg: number): ResolvedSign {
  if (pos === 0 && neg === 0) return "unknown";
  return pos >= neg ? BRAIN_SIGNAL_SIGN.positive : BRAIN_SIGNAL_SIGN.negative;
}

/**
 * Resolve a preference's sign of record from the signals it cites.
 * Wikilinks that do not resolve in `signSignById` are ignored; when no
 * cited signal resolves, the result is `"unknown"`.
 */
export function dominantSignOf(
  evidencedBy: ReadonlyArray<string>,
  signSignById: ReadonlyMap<string, BrainSignalSign>,
): ResolvedSign {
  const signs: BrainSignalSign[] = [];
  for (const wl of evidencedBy) {
    const id = parseWikilink(wl);
    if (!id) continue;
    const s = signSignById.get(id);
    if (s) signs.push(s);
  }
  const { pos, neg } = countSigns(signs);
  return dominantSignFromCounts(pos, neg);
}
