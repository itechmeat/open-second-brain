/**
 * Informal privacy markers (write-honesty, F1).
 *
 * `graph/visibility.ts` reserves ONE token - `private` - and reads it from
 * the `visibility:` key only. Vaults written before that convention say
 * `access: private`, `confidentiality: secret` or
 * `sensitivity: confidential` instead, and those pages resolve to default
 * visibility: the reserved-token rule never sees the claim the author
 * wrote. This module is that missing reading, and nothing else.
 *
 * What it answers, in three functions:
 *
 *   - {@link hasPrivacyDenyMarker} - does the frontmatter carry a value
 *     under one of the three marker keys that says "not for everyone";
 *   - {@link markerDenyTokens} - the reserved token to UNION into the
 *     page's declared visibility, or an empty list when no marker denies;
 *   - {@link remoteDenyVisibilityTokens} - the declaration and that union
 *     folded into one token list, for the read roots and the indexed
 *     column.
 *
 * ## Scope of the rule, stated rather than implied
 *
 * A marker reserves a page against REMOTE reads only. It is not a
 * caller-scope token: it never enters {@link pageVisibility} and no scope
 * request can name it, so it can neither widen nor narrow what a caller
 * reaches at local reach. Folding it into `pageVisibility` would have made
 * `visibility:` and an informal key one vocabulary with two spellings;
 * keeping it here leaves each statement saying exactly one thing.
 *
 * The values are token-matched through {@link normToken} - the same NFC +
 * trim + lower-case normalisation the visibility layer uses - rather than
 * through a second normaliser, and the KEYS are matched through it too: a
 * vault that spells the key `Access` or `CONFIDENTIALITY` makes the same
 * claim as the lower-case spelling. A value that spells something else (a
 * phrase, a negation, a Markdown sentence) is not a deny marker: this
 * module recognises the three token spellings the design pins and does not
 * guess at prose.
 */

import type { FrontmatterMap } from "../types.ts";
import { REMOTE_DENY_VISIBILITY_TOKEN, normToken, pageVisibility } from "./visibility.ts";

/**
 * The informal frontmatter keys a pre-`visibility:` vault used to state a
 * privacy claim under. Closed: a key outside this list is not a marker,
 * whatever value it carries.
 */
export const PRIVACY_MARKER_KEYS: ReadonlyArray<string> = Object.freeze([
  "access",
  "confidentiality",
  "sensitivity",
]);

/**
 * The marker VALUES that deny a remote read, already in the normal form
 * {@link normToken} produces. Compared by exact normalised equality: a
 * value that merely contains one of these words is a different claim.
 */
export const PRIVACY_DENY_MARKER_VALUES: ReadonlyArray<string> = Object.freeze([
  "private",
  "secret",
  "confidential",
]);

/** Marker values declared as a string or an array of strings. */
function declaredValues(raw: unknown): string[] {
  if (typeof raw === "string") return [raw];
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === "string");
}

/**
 * The marker keys in the normal form {@link normToken} produces. The values
 * are matched after normalisation, so the KEYS are too: a vault that spells
 * the key `Access`, `ACCESS` or with stray surrounding whitespace makes the
 * same claim as the lower-case spelling, and a reader that matched keys by
 * exact case would hand that claim to a remote reader.
 */
const PRIVACY_MARKER_KEY_TOKENS: ReadonlySet<string> = Object.freeze(
  new Set(PRIVACY_MARKER_KEYS.map((key) => normToken(key))),
);

/**
 * Does this frontmatter carry ANY key under a marker key spelling, whatever
 * the value? The migration re-stamping the indexed visibility column gates
 * on this, because a row whose frontmatter carries a marker key at all is a
 * row the column's pre-marker stamp may understate.
 */
export function hasPrivacyMarkerKey(meta: FrontmatterMap): boolean {
  for (const key of Object.keys(meta)) {
    if (PRIVACY_MARKER_KEY_TOKENS.has(normToken(key))) return true;
  }
  return false;
}

/**
 * Does this frontmatter carry a privacy-denying informal marker value?
 *
 * True when any key whose normalised spelling is one of
 * {@link PRIVACY_MARKER_KEYS} declares a string (or an array holding a
 * string) whose {@link normToken} form is one of
 * {@link PRIVACY_DENY_MARKER_VALUES}. Absent keys, non-string scalars,
 * empty values and every other token answer false.
 */
export function hasPrivacyDenyMarker(meta: FrontmatterMap): boolean {
  for (const key of Object.keys(meta)) {
    if (!PRIVACY_MARKER_KEY_TOKENS.has(normToken(key))) continue;
    for (const value of declaredValues(meta[key])) {
      if (PRIVACY_DENY_MARKER_VALUES.includes(normToken(value))) return true;
    }
  }
  return false;
}

/**
 * The token to union into the page's declared visibility when an informal
 * marker denies a remote read, else an empty list.
 *
 * Exactly the reserved token: the marker says the same thing the formal
 * reservation says, so it resolves to the same identifier rather than
 * minting a second one.
 */
export function markerDenyTokens(meta: FrontmatterMap): ReadonlyArray<string> {
  return hasPrivacyDenyMarker(meta)
    ? Object.freeze([REMOTE_DENY_VISIBILITY_TOKEN])
    : Object.freeze([]);
}

/**
 * The page's declared visibility tokens plus any informal marker's
 * reservation, deduplicated in declaration order.
 *
 * This is what a read root hands to {@link isRemotelyReadable} and what
 * the indexer stamps into the measured column. The declared tokens are
 * kept verbatim (already normalised by {@link pageVisibility}); the
 * reserved token is appended only when a marker denies and it is not
 * already declared.
 */
export function remoteDenyVisibilityTokens(meta: FrontmatterMap): ReadonlyArray<string> {
  const declared = pageVisibility(meta);
  const out = [...declared];
  for (const token of markerDenyTokens(meta)) {
    if (!out.includes(token)) out.push(token);
  }
  return Object.freeze(out);
}
