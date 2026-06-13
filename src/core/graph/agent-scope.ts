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

import type { FrontmatterMap } from "../types.ts";

/** NFC + trim + lower-case a single ownership token. */
function normToken(raw: string): string {
  return raw.normalize("NFC").trim().toLowerCase();
}

/**
 * The owner a page declares, or `null` for a shared (ownerless) page.
 * A non-string `owner:` value is treated as absent.
 */
export function pageOwner(meta: FrontmatterMap): string | null {
  const raw = meta["owner"];
  if (typeof raw !== "string") return null;
  const token = normToken(raw);
  return token.length > 0 ? token : null;
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
