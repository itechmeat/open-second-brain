/**
 * Deterministic session codec (Vault portability suite, Feature 1).
 *
 * A pure, lossless, language-agnostic codec for session-derived prose.
 * `expand(compress(x)) === x` holds for ALL input - brain memory must
 * never lose data, so this is a strict reversible transform, not a lossy
 * summariser. Token savings come from reversibly collapsing runs of
 * whitespace and blank lines; fenced and inline code spans are protected
 * (their whitespace is never collapsed), and structured tokens (URLs,
 * paths, identifiers, version numbers) are preserved byte-for-byte by
 * construction because nothing but long whitespace runs is ever rewritten.
 *
 * Detection is purely structural - no natural-language word lists - so
 * the codec behaves identically for any language or script.
 *
 * Encoding:
 *   - A run of >= RUN_MIN spaces becomes `ESC s <count> ESC`.
 *   - A run of >= RUN_MIN newlines becomes `ESC n <count> ESC`.
 *   - A literal ESC in the input is escaped to `ESC x` (x is neither
 *     marker letter), so a marker-looking input sequence can never be
 *     mistaken for a real marker on expand.
 * ESC is a Unicode Private-Use-Area code point that does not occur in
 * normal text; the escape rule makes correctness unconditional anyway.
 * RUN_MIN = 4 guarantees a whitespace-run marker is never longer than the
 * run it replaces, so for normal text (free of the PUA sentinel) the
 * compressed form never exceeds the original. The only growth case is an
 * input that already contains the sentinel: escaping adds one byte per
 * literal ESC - which does not occur in real prose, and round-trip stays
 * exact regardless.
 */

export const CODEC_VERSION = "1";

const ESC = "";
const ESC_LITERAL = `${ESC}x`;
// RUN_MIN = 4 is baked into the {4,} run regexes below: a 4-char marker
// never exceeds the run it replaces, keeping compressed <= original.

// Fenced code blocks and single-line inline code spans: their interior
// whitespace is significant, so it is left uncollapsed (still escaped for
// ESC safety). The capture group puts protected spans at odd split indices.
const PROTECTED_RE = /(```[\s\S]*?```|`[^`\n]*`)/g;
const MARKER_RE = new RegExp(`${ESC}([sn])(\\d+)${ESC}`, "g");

/** Escape any literal ESC so it can never be read as a marker on expand. */
function escapeEsc(s: string): string {
  return s.includes(ESC) ? s.split(ESC).join(ESC_LITERAL) : s;
}

/** Escape, then collapse long whitespace / blank-line runs reversibly. */
function collapseFree(seg: string): string {
  return escapeEsc(seg)
    .replace(/\n{4,}/g, (m) => `${ESC}n${m.length}${ESC}`)
    .replace(/ {4,}/g, (m) => `${ESC}s${m.length}${ESC}`);
}

/** Compress `text` into its reversible codec form. */
export function compress(text: string): string {
  if (text.length === 0) return text;
  const parts = text.split(PROTECTED_RE);
  let out = "";
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    // Odd indices are protected spans: escape only, never collapse.
    out += i % 2 === 1 ? escapeEsc(part) : collapseFree(part);
  }
  return out;
}

/** Expand a codec form back to the exact original text. */
export function expand(text: string): string {
  if (!text.includes(ESC)) return text;
  const restored = text.replace(MARKER_RE, (_full, kind: string, nStr: string) => {
    const n = Number(nStr);
    return (kind === "n" ? "\n" : " ").repeat(n);
  });
  // Unescape literal ESC last; marker scanning above already consumed the
  // structural ESCs, so the only pairs left are escapes.
  return restored.split(ESC_LITERAL).join(ESC);
}
