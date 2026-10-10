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
 * The index-side rule is Obsidian's documented tag grammar: `#word`
 * where word may contain letters from ANY script, digits, dashes,
 * underscores, and `/` for hierarchy, must carry at least one non-digit
 * character (a bare number is a number, not a tag), and may not begin
 * with a slash. It was deliberately NOT widened in the wave that
 * introduced it (an index-semantics change with reindex gating; the
 * tags detector reported the diff instead) - the review round of
 * v1.78.0 superseded that refusal after the ASCII letter/underscore
 * onset proved narrower than Obsidian: it refused Unicode tags
 * (`#кодинг`) and digit-led non-numeric tags (`#2fa`, `#2024-notes`)
 * at the write sites and froze every dream refresh carrying such a
 * scope over.
 *
 * The code-fence / inline-code stripping lives here too because the
 * tag rules are defined over cleaned text: the detector must apply
 * them to exactly the prose the indexer extracts from, and holding
 * the stripping here keeps that cleaning one definition as well.
 */

/**
 * One tag character, per Obsidian's documented grammar: letters from any
 * script (`\p{L}`), numbers (`\p{N}`), underscores, dashes, and `/`
 * (nesting).
 */
const TAG_VALUE_CLASS = "\\p{L}\\p{N}_\\-/";

/** A maximal tag value: one or more tag characters. */
const TAG_VALUE_SOURCE = `[${TAG_VALUE_CLASS}]+`;

/**
 * The value-shape guards both anchorings share, keeping the old onset's
 * two guarantees without its ASCII narrowness: a value may not BEGIN
 * with a slash (an empty first nested-tag segment is no tag in Obsidian
 * either), and it is never purely numeric - a bare number is not a tag.
 * The digit guard is a lookahead rather than an onset so digit-led
 * values like `2fa` and `2024-notes` stay valid: it refuses only a run
 * of digits (`\p{Nd}`, so non-ASCII numerals refuse too) followed by NO
 * further tag character, which anchors the run at the end of the value -
 * end of string for the anchored predicate, the first non-tag character
 * in prose.
 */
const TAG_VALUE_GUARDS = `(?!/)(?!\\p{Nd}+(?![${TAG_VALUE_CLASS}]))`;

/**
 * Obsidian-style tag: #word where word may contain letters from any
 * script, digits, underscores, dashes, and '/' for hierarchy, never is
 * purely numeric, and never begins with a slash.
 */
export const TAG_RE = new RegExp(`(^|[^\\w/])#${TAG_VALUE_GUARDS}(${TAG_VALUE_SOURCE})`, "gu");

/** Matches a whole tag value: the same rule TAG_RE captures, anchored. */
const TAG_VALUE_RE = new RegExp(`^${TAG_VALUE_GUARDS}${TAG_VALUE_SOURCE}$`, "u");

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
