/**
 * The one shared tag rule (search/diagnostics/vault-hygiene wave;
 * kanban t_c8508241).
 *
 * `TAG_RE` and the tag extraction over cleaned text moved here from
 * `src/core/search/links.ts` so that both consumers - the search index
 * (link-table rows) and the vault-hygiene `tags` detector - read ONE
 * definition, not two spellings. This is also the seam board sibling
 * t_11ee559f (write-time tag syntax validation, trust-surface-hardening
 * wave) consumes: the composers validate against the rule defined HERE
 * ({@link isObsidianTagValue}, via `src/core/brain/tag-syntax.ts`),
 * never against a copy.
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
 * The value-level rule the index regex and the write-time predicate
 * share, spelled ONCE below: a value starts with a letter/underscore and
 * continues with letters, digits, dashes, underscores, and `/`
 * (nesting). By the shared onset a value may not begin with a slash and
 * may never be purely numeric. {@link TAG_RE} wraps this source with the
 * prose boundary and the `#`; {@link isObsidianTagValue} matches it
 * anchored - one spelling, two anchors.
 */
const TAG_VALUE_SOURCE = "[A-Za-z_][\\w\\-/]*";

/**
 * Obsidian-style tag: #word where word starts with a letter/_ and may contain
 * letters, digits, dashes, underscores, and '/' for hierarchy.
 */
export const TAG_RE = new RegExp(`(^|[^\\w/])#(${TAG_VALUE_SOURCE})`, "g");

/** Matches a whole tag value: the same rule TAG_RE captures, anchored. */
const TAG_VALUE_RE = new RegExp(`^${TAG_VALUE_SOURCE}$`);

/**
 * Does `value` (WITHOUT its `#`) satisfy the one tag rule - the rule the
 * search index extracts with, the hygiene detectors report against, and
 * board sibling t_11ee559f validates composed tags at the write sites
 * with (consumed via `src/core/brain/tag-syntax.ts`, never re-copied).
 */
export function isObsidianTagValue(value: string): boolean {
  return TAG_VALUE_RE.test(value);
}

// A fenced block runs from an opening line of three or more backticks or
// tildes to the first later line that starts with a run of the SAME
// character at least as long (or to the end of the text), the CommonMark
// rule: a shorter run, or a run of the other character, is content. A
// stored excerpt is fenced one backtick longer than any run it holds, so
// its lines never close it early. The opening run is a whole run, which
// fixes its length and keeps the scan linear on a long line of marks.
const CODE_FENCE_RE =
  /(^|\n)(?:(`{3,})(?!`)[^\n]*\n[\s\S]*?(?:\n\2`*[^\n]*|$)|(~{3,})(?!~)[^\n]*\n[\s\S]*?(?:\n\3~*[^\n]*|$))/g;
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
