/**
 * Heuristic token counter for vault content. Not a true tokenizer -
 * no BPE merges, no model-specific vocabulary - just a stable,
 * deterministic estimate that lets brain_digest and `brain
 * token-footprint` describe vault size in roughly LLM-equivalent
 * units without taking a tokenizer dependency.
 *
 * Heuristic: `ceil(utf8_bytes / 4)`. This is OpenAI's published
 * rule-of-thumb ("roughly 1 token per 4 characters of English"),
 * generalised to UTF-8 bytes so the same formula works for any
 * script. Non-Latin glyphs are encoded as 2-4 bytes in UTF-8, which
 * naturally tracks the way multilingual BPE tokenizers spend more
 * tokens per visible character in dense scripts.
 *
 * Trade-offs:
 *   - Overcounts pure ASCII English slightly versus modern BPE
 *     tokenizers (cl100k / o200k average closer to 1 token per 4-5
 *     characters).
 *   - Undercounts pathological cases (rare emojis with skin-tone
 *     modifiers, regional indicator sequences) where one visible
 *     glyph spans 8+ bytes.
 *   - Determinism, language-agnosticism, and zero-dependency cost
 *     are the priorities: this number must be stable across runs
 *     and not require a new vocabulary every time a new script
 *     ships.
 *
 * Determinism matters more than per-string accuracy: the same input
 * must always produce the same count so digests stay stable across
 * runs.
 */

const ENCODER = new TextEncoder();

export function estimateTokens(input: string): number {
  if (input.length === 0) return 0;
  const bytes = ENCODER.encode(input).length;
  return Math.ceil(bytes / 4);
}
