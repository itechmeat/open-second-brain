/**
 * Wikilink parsing helpers for the Brain layer.
 *
 * The Obsidian-flavoured wikilink shape is `[[target]]`, with optional
 * alias (`[[target|alias]]`) and anchor (`[[target#section]]`) suffixes.
 * Brain frontmatter writers always emit the bare `[[id]]` form, but the
 * parsers must tolerate the alias / anchor / folder-prefixed / `.md`-
 * suffixed variants because the on-disk artifacts are user-editable.
 *
 * Surface:
 *
 *   - {@link normaliseWikilinkTarget} extracts the bare target id from
 *     any of those shapes. Used by the doctor command (resolving
 *     `evidenced_by` / `supersedes` pointers against the Brain index)
 *     and by the query command (matching log payload values against a
 *     preference id).
 *
 *   - {@link parseWikilink} returns the target if the input is exactly
 *     a wikilink form (`^\[\[…\]\]$`), or `null` otherwise. Used by the
 *     dream loop's `evidenced_by` walker and the digest's tolerant
 *     contradiction-line parser, where the caller wants to distinguish
 *     "this is a wikilink" from "this is bare text".
 *
 * Both helpers are case-preserving and do NOT validate that the target
 * exists; that's a higher-layer concern (doctor cross-references against
 * the Brain index, dream relies on a follow-up `Map.has` check).
 */

import { basename } from "node:path";

/**
 * Strip wikilink decoration off `value` and return the bare target id.
 *
 * Recognises:
 *   - surrounding `[[…]]` brackets (only the first match wins)
 *   - `|alias` and `#anchor` suffixes (alias / anchor dropped)
 *   - leading folder segments (`folder/foo` → `foo`)
 *   - trailing `.md` extension
 *
 * Returns the input unchanged (minus a trim) when it isn't decorated;
 * callers can still distinguish bare text from "no input" via the empty
 * string.
 */
export function normaliseWikilinkTarget(value: string): string {
  let s = value.trim();
  // Strip surrounding wikilink brackets, retaining only the target.
  const wm = /^\[\[([^\]]+)\]\]/.exec(s);
  if (wm) s = wm[1]!.trim();
  // Drop alias / anchor suffixes (`foo|bar` or `foo#section`).
  const pipe = s.indexOf("|");
  if (pipe >= 0) s = s.slice(0, pipe).trim();
  const hash = s.indexOf("#");
  if (hash >= 0) s = s.slice(0, hash).trim();
  // Strip a leading folder if any (Obsidian links resolve by basename).
  s = basename(s);
  // Strip a trailing `.md` if the user supplied a filename.
  if (s.endsWith(".md")) s = s.slice(0, -".md".length);
  return s;
}

/**
 * Return the bare target id if `value` is exactly a wikilink form
 * (`^\[\[…\]\]$` modulo surrounding whitespace), otherwise `null`.
 *
 * Unlike {@link normaliseWikilinkTarget}, this is anchored: a bare id or
 * a mixed string ("see [[foo]]" embedded in prose) yields `null`. Use
 * this when "is this a wikilink at all?" is the question being asked.
 *
 * Alias / anchor / folder / `.md` decoration on the target itself is
 * stripped via the same logic as `normaliseWikilinkTarget` so callers
 * get a clean id either way.
 */
export function parseWikilink(value: string): string | null {
  const m = /^\s*\[\[([^\]]+)\]\]\s*$/.exec(value);
  if (!m) return null;
  return normaliseWikilinkTarget(m[1]!);
}
