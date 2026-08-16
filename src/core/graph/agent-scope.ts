/**
 * Agent-ownership recall isolation (Unit 5 of the Vault Integrity & Trust
 * suite).
 *
 * A page may carry an `owner:` frontmatter token naming the agent that
 * owns it. The rule, defined once here and consumed by the search filter:
 *
 *   - A page with no `owner:` is SHARED and always reachable (zero
 *     behaviour change for vaults that never set the field).
 *   - A page that declares an owner is owner-private: reachable only when
 *     the caller requests that owner's scope.
 *   - A page that declares an owner this parser cannot resolve to one
 *     token is treated as SOMEBODY ELSE'S ({@link OWNER_UNRESOLVED}),
 *     never as shared. An unreadable ownership claim is still a claim.
 *   - When no scope is requested (the default), NO ownership filtering
 *     happens at all - every page is reachable, so a recall that opts
 *     into nothing is byte-identical to today.
 *
 * This differs from content visibility ({@link ../graph/visibility.ts}),
 * where an empty requested scope still drops tagged pages: agent-scope is
 * a pure opt-in isolation, never a default narrowing.
 *
 * Owner tokens are opaque, language-neutral identifiers (an agent name);
 * nothing here hardcodes a natural-language phrase or a closed enum.
 */

import { normalizeAgentArgument } from "../agent-identity.ts";
import type { FrontmatterMap } from "../types.ts";

/** NFC + trim + lower-case a single ownership token. */
function normToken(raw: string): string {
  return raw.normalize("NFC").trim().toLowerCase();
}

/**
 * The owner of a page that CLAIMS ownership in a shape this vault cannot
 * resolve to a single token.
 *
 * The shapes are routine rather than exotic: Obsidian Properties writes
 * any list-shaped field as a YAML block sequence, and `parseFrontmatterText`
 * parses both block and inline sequences into arrays; a nested mapping
 * under `owner:` leaves the key with an empty value and hoists the child
 * keys. Reading any of those as "no owner" would publish an owner-private
 * page to every scope - the exact inversion of an isolation boundary - so
 * they resolve to this token instead, which no requested scope can ever
 * equal and which therefore reads as "somebody else's".
 *
 * Unreachable by construction: {@link normalizeAgentScope} lower-cases
 * every requested scope, so no caller can request a scope containing an
 * upper-case letter. A page that literally declares
 * `owner: OWNER_UNRESOLVED` is therefore hidden from every scope, which
 * is the fail-closed direction.
 */
export const OWNER_UNRESOLVED = "OWNER_UNRESOLVED";

/**
 * Resolve any raw `owner` value - a frontmatter field, a parsed record's
 * `owner` slot - to the token the visibility rule compares.
 *
 *   - absent (`undefined` / `null`): SHARED, returns `null`.
 *   - a usable string: its normalized token.
 *   - present but unusable (empty/blank string, array, object, number):
 *     {@link OWNER_UNRESOLVED}.
 *
 * Idempotent: feeding {@link OWNER_UNRESOLVED} back in returns it
 * unchanged, so a record that already carries the token (a preference
 * parsed from a list-shaped `owner:`) resolves the same way as the page
 * it came from.
 */
export function ownerToken(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (raw === OWNER_UNRESOLVED) return OWNER_UNRESOLVED;
  if (typeof raw !== "string") return OWNER_UNRESOLVED;
  const token = normToken(raw);
  return token.length > 0 ? token : OWNER_UNRESOLVED;
}

/**
 * The owner a page declares, or `null` for a shared (ownerless) page.
 * A present-but-unresolvable `owner:` yields {@link OWNER_UNRESOLVED} —
 * never `null`, because an ownership claim that cannot be read is not
 * an absence of one.
 */
export function pageOwner(meta: FrontmatterMap): string | null {
  return ownerToken(meta["owner"]);
}

/**
 * The owner token a writer stamps on a page it CREATES on behalf of
 * `agent`, or `null` when that identity cannot be reduced to one token.
 *
 * `null` is a refusal for the caller to raise. It is deliberately NOT
 * {@link OWNER_UNRESOLVED}: that token is the fail-closed reading of a
 * claim already on disk, and writing it would hide the new page from
 * every scope INCLUDING its author's - the author could not read back
 * what they had just written, and nothing would ever say why. An
 * identity a writer cannot spell is an error to report, not a page to
 * bury.
 *
 * ## Why the placeholder is refused here and not only at the reader
 *
 * `normalizeAgentArgument` is the predicate the whole product uses for
 * "is this a real identity or a name a model guessed": it rejects
 * `agent`, `assistant`, `claude`, `gpt` and the rest, and
 * `refuseOwnerScopeRequest` cites it when it refuses a caller asking to
 * be answered as one of them - "the bottom of the identity chain is the
 * literal `agent`, which that predicate rejects, so an unconfigured
 * install cannot silently become an owner"
 * (`src/mcp/owner-scope-refusal.ts`).
 *
 * That sentence was false while this function accepted the same string.
 * `resolveAgentName` never fails; it returns `UNCONFIGURED_AGENT_NAME`
 * (`"agent"`), so on an install with no `agent_name` and the gate on,
 * every new preference was stamped `owner: agent` while every caller
 * asking for `agent_scope: "agent"` was refused as unverifiable - the
 * vault accumulated owner-private memories no caller could ever be
 * shown to own. One predicate, both halves: an identity that cannot be
 * requested cannot be stamped either.
 */
export function ownerStampFor(agent: string): string | null {
  if (normalizeAgentArgument(agent) === null) return null;
  const token = ownerToken(agent);
  return token === null || token === OWNER_UNRESOLVED ? null : token;
}

/**
 * Normalise a caller's requested agent scope. `undefined` / blank becomes
 * `null`, which means "no scope requested" - no ownership filtering.
 */
export function normalizeAgentScope(value: string | undefined): string | null {
  if (value === undefined) return null;
  const token = normToken(value);
  return token.length > 0 ? token : null;
}

/**
 * Is a page owned by `owner` reachable by a caller requesting `scope`?
 *
 *   - `scope === null` (no request): always reachable (default, unchanged).
 *   - shared page (`owner === null`): always reachable.
 *   - owner-private page: reachable only by its own owner.
 */
export function isOwnerVisible(owner: string | null, scope: string | null): boolean {
  if (scope === null) return true;
  if (owner === null) return true;
  return owner === scope;
}
