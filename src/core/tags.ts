/**
 * The one shared tag rule (search/diagnostics/vault-hygiene wave;
 * kanban t_c8508241).
 *
 * `TAG_RE` and the tag extraction over cleaned text moved here from
 * `src/core/search/links.ts` so that both consumers - the search index
 * (link-table rows) and the vault-hygiene `tags` detector - read ONE
 * definition, not two spellings. This is also the seam board sibling
 * t_11ee559f (write-time tag syntax validation, not in this wave; the
 * overlap is recorded as a coordination note) must consume: it should
 * validate against the rule defined HERE, never against a copy.
 *
 * The index-side rule: `#word` where word starts with a letter/`_` and
 * may contain letters, digits, dashes, underscores, and `/` for
 * hierarchy. The regex is deliberately NOT widened this wave - a
 * looser rule is an index-semantics change with reindex gating; the
 * tags detector reports the diff instead of the index absorbing it.
 *
 * The code-fence / inline-code stripping lives here too because the
 * tag rules are defined over cleaned text: the detector must apply
 * them to exactly the prose the indexer extracts from, and holding
 * the stripping here keeps that cleaning one definition as well.
 */

/**
 * Obsidian-style tag: #word where word starts with a letter/_ and may contain
 * letters, digits, dashes, underscores, and '/' for hierarchy.
 */
export const TAG_RE = /(^|[^\w/])#([A-Za-z_][\w\-/]*)/g;

const CODE_FENCE_RE = /(^|\n)(```|~~~)[^\n]*\n[\s\S]*?(?:\n(?:```|~~~)[^\n]*|$)/g;
const INLINE_CODE_RE = /`[^`\n]*`/g;

/**
 * Strip code fences and inline-code spans so a code sample mentioning
 * `#hash` (or `[[foo]]`) does not become a real tag/link. Best-effort:
 * nested fenced fences are rare and we err on the side of stripping
 * too much rather than capturing junk.
 */
export function stripCode(text: string): string {
  let out = text.replace(CODE_FENCE_RE, "\n");
  out = out.replace(INLINE_CODE_RE, " ");
  return out;
}

/**
 * The tag values `TAG_RE` captures over ALREADY-CLEANED text (run
 * {@link stripCode} first), in occurrence order, empty values skipped.
 * Callers decide the row shape: the index emits `tag` link rows, the
 * hygiene detector aggregates values per document.
 */
export function extractTagValues(cleaned: string): string[] {
  const out: string[] = [];
  for (const m of cleaned.matchAll(TAG_RE)) {
    const tag = (m[2] ?? "").trim();
    if (tag === "") continue;
    out.push(tag);
  }
  return out;
}
