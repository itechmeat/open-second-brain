/**
 * Content visibility scoping (typed graph semantics, unit 3).
 *
 * A page may carry a `visibility:` frontmatter field (string or string
 * array) that scopes which consumers can reach it. The rule, defined
 * once here and consumed identically by the CLI and the MCP read
 * surface:
 *
 *   - A page with no `visibility:` is at DEFAULT visibility and is
 *     always reachable (zero behaviour change for vaults that never set
 *     the field).
 *   - A page that declares visibility values is reachable only when the
 *     caller's requested scope includes at least one of those values.
 *
 * Visibility values are opaque, language-neutral tokens (e.g. `private`,
 * `team`, `agent:foo`); nothing here hardcodes a natural-language
 * phrase or a closed enum.
 *
 * ONE of those tokens is additionally RESERVED - see
 * {@link REMOTE_DENY_VISIBILITY_TOKEN} - as a controlled-vocabulary
 * identifier meaning "not readable at remote reach". That is a second,
 * independent question from the caller-scope rule above, answered by
 * {@link isRemotelyReadable}, and the two compose: the caller's scope may
 * only ever NARROW, and can no longer lift the reserved token.
 */

import { TRANSPORT_REACH, type TransportReach } from "./transport-reach.ts";
import type { FrontmatterMap } from "../types.ts";

/** Lower-case + NFC + trim a single visibility token. */
function normToken(raw: string): string {
  return raw.normalize("NFC").trim().toLowerCase();
}

/**
 * The visibility tokens a page declares. Empty array = default
 * visibility (reachable by every consumer).
 */
export function pageVisibility(meta: FrontmatterMap): string[] {
  const v = meta["visibility"];
  const list = Array.isArray(v) ? v : typeof v === "string" && v.length > 0 ? [v] : [];
  return list.map((s) => normToken(String(s))).filter((s) => s.length > 0);
}

/** Normalise a caller's requested visibility scope into a token set. */
export function normalizeVisibilityScope(values: ReadonlyArray<string>): Set<string> {
  const out = new Set<string>();
  for (const v of values) {
    const t = normToken(v);
    if (t) out.add(t);
  }
  return out;
}

/**
 * Is a page with `pageTags` reachable by a caller requesting `scope`?
 * Default-visibility pages (no tags) are always reachable; a tagged
 * page is reachable only when one of its tags is in the requested
 * scope (an empty scope reaches default pages only).
 */
export function isVisible(pageTags: ReadonlyArray<string>, scope: ReadonlySet<string>): boolean {
  if (pageTags.length === 0) return true;
  for (const t of pageTags) if (scope.has(t)) return true;
  return false;
}

/**
 * The one visibility token that denies a remote read.
 *
 * A vocabulary identifier, in the same sense as `kind: entity` or an
 * entity `status` value - not a natural-language phrase, and not the head
 * of a list of translations. It is written here once, already in the
 * normal form {@link normToken} produces, so a page cannot spell it a
 * second way and mean something else.
 *
 * Every OTHER token, reserved-adjacent or not, keeps exactly the
 * caller-liftable semantics {@link isVisible} gives it: this constant
 * reserves one identifier and defines no policy for any other.
 */
export const REMOTE_DENY_VISIBILITY_TOKEN = "private";

/**
 * May a caller that reached this process at `reach` read a page carrying
 * `pageTags`?
 *
 * Deny by default at {@link TRANSPORT_REACH.remote} for the reserved
 * token, and nothing else: an untagged page, and a page carrying only
 * non-reserved tokens, answer `true` at every reach and are left entirely
 * to {@link isVisible}. A vault that never wrote the reserved token
 * therefore sees no change from this predicate at all.
 *
 * `pageTags` must come from {@link pageVisibility}, which is where the
 * normalisation happens; passing raw frontmatter strings would compare an
 * un-normalised token against a normalised constant and silently admit a
 * page that declared the reserved token in another case.
 */
export function isRemotelyReadable(
  pageTags: ReadonlyArray<string>,
  reach: TransportReach,
): boolean {
  if (reach === TRANSPORT_REACH.local) return true;
  return !pageTags.includes(REMOTE_DENY_VISIBILITY_TOKEN);
}
