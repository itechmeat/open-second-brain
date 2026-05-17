/**
 * Small string-level utilities shared across `src/core/`.
 *
 * Kept here rather than inlined per call site so multiple modules
 * (templates renderer, brain protect fence parser, future regex
 * builders) stay consistent on the metachar set they escape.
 */

/**
 * Escape every regex metacharacter in `text` so the result is safe
 * to interpolate into a `RegExp` source string as a literal match.
 * Mirrors the canonical MDN escape set.
 */
export function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
