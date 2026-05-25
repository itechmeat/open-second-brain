/**
 * Unicode-aware key normaliser used wherever the Brain layer
 * constructs a dedup or comparison key from user-supplied text.
 *
 * Two transforms applied in order:
 *
 * 1. `String.prototype.normalize("NFKC")` - compatibility composition.
 *    Folds visually-equivalent codepoint variants (fullwidth /
 *    halfwidth Latin, half-width katakana vs full-width, composed vs
 *    decomposed accents, ligature decomposition, etc.) into one
 *    canonical form. NFC is too narrow - it keeps fullwidth `Ｈ`
 *    distinct from halfwidth `H`. NFKC merges them.
 *
 * 2. `String.prototype.toLowerCase()` - Unicode-aware case folding.
 *    JavaScript's default `toLowerCase` performs locale-independent
 *    Unicode case mapping (per the spec it uses the
 *    `String.prototype.toLowerCase` algorithm from ECMA-262 §22.1).
 *    Not as exhaustive as Python's `str.casefold` but close enough
 *    for vault dedup: Cyrillic `Т` → `т`, Greek `Σ` → `σ`, Latin
 *    `Ä` → `ä`, etc.
 *
 * The resulting string is suitable as the canonical input to a hash
 * function or as a comparison key for near-duplicate detection.
 * It is NOT suitable for display - the casefold step is lossy.
 */
export function normalizeForDedup(input: string): string {
  return input.normalize("NFKC").toLowerCase();
}
