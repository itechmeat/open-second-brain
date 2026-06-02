/**
 * Principle-text sanitizer (token-diet, t_40eb1de7).
 *
 * Two corruption shapes were found verbatim in live preference
 * frontmatter, both introduced at signal-recording time by malformed
 * MCP client payloads:
 *
 *   1. Leaked tool-call XML fragments: the principle string carried a
 *      serialized tail of the tool call itself, e.g.
 *      `...approval.</principle>\n<parameter name="scope">collaboration`.
 *   2. Multi-level backslash-quote chains (`\\\\\\"`) - escape
 *      amplification from asymmetric frontmatter round-trips (fixed at
 *      the parser; this collapse repairs already-amplified text).
 *
 * The sanitizer is idempotent and pure; it is applied at every write
 * seam that persists a principle (signal + preference writers) and by
 * the one-shot `planUpgrade` repair for files corrupted before the fix.
 */

/**
 * First leaked tool-call boundary, gated to high-confidence signatures
 * so legitimate prose is never mutated:
 *
 *   - a closing XML-ish tag for a known tool-call field
 *     (`</principle>`, `</parameter>`, `</antml...>`) - prose has no
 *     reason to close a tag it never opened;
 *   - an opening `<parameter ...>` fragment ONLY when its attribute
 *     region carries escaped quotes (`name=\"...`) - the unmistakable
 *     mark of a serialized tool call, unlike a plain `<parameter>`
 *     mention in documentation text.
 *
 * Everything from the first match onward is dropped - the genuine
 * principle text always precedes the leak.
 */
const TOOL_CALL_LEAK_RE = /<\/(?:principle|parameter|antml[\w:-]*)>|<parameter\b[^>]*?\\+"/i;

/**
 * TWO or more backslashes immediately before a double quote: the
 * escape-amplification artifact. A single `\"` is left alone - it can
 * be legitimate prose about escaping.
 */
const ESCAPE_CHAIN_RE = /\\{2,}"/g;

/** Literal backslash-escape text (`\n`, `\\n`, ...) left at a cut edge. */
const TRAILING_ESCAPE_LITERALS_RE = /(?:\\+[nrt])+\s*$/;

export function sanitisePrinciple(value: unknown): string {
  if (typeof value !== "string") return "";
  let s = value;

  const leak = TOOL_CALL_LEAK_RE.exec(s);
  if (leak) {
    s = s.slice(0, leak.index);
    // Cut-edge residue (`...\n` literals) only exists when a leak was
    // cut; outside that branch a trailing literal `\n` may be the
    // rule's own text.
    s = s.replace(TRAILING_ESCAPE_LITERALS_RE, "");
  }

  s = s.replace(ESCAPE_CHAIN_RE, '"');

  return s.trim();
}

/** True when {@link sanitisePrinciple} would change the text. */
export function principleNeedsRepair(value: unknown): boolean {
  return typeof value === "string" && sanitisePrinciple(value) !== value;
}
