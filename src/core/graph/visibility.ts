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
 */

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
