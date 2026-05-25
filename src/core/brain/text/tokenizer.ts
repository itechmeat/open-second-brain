/**
 * Heuristic token counter for vault content. Not a true tokenizer -
 * no BPE merges, no model-specific vocabulary - just a stable,
 * deterministic estimate that lets brain_digest and `brain
 * token-footprint` describe vault size in roughly LLM-equivalent
 * units without taking a tokenizer dependency.
 *
 * Calibration target: GPT-style tokenisation on Latin prose is
 * close to 1 token per 4 characters or ~1.33 tokens per word. CJK
 * blocks tokenise denser; we count 1 token per character for
 * CJK ideographs / hiragana / katakana / hangul to bias the
 * estimate upward there (still an undercount of real tokenizers
 * for CJK, but conservative for budgeting).
 *
 * Determinism matters more than per-string accuracy: the same input
 * must always produce the same count so digests stay stable across
 * runs.
 */

// Match contiguous spans of CJK ideographs + Japanese kana + Korean hangul.
// Each character in these scripts contributes ~1 token in most modern BPE
// tokenizers, sometimes more.
const CJK_RUN = /[぀-ヿ㐀-鿿가-힣]+/g;

// Whitespace runs collapse to single separators when counting words.
const WS_RUN = /\s+/g;

export function estimateTokens(input: string): number {
  if (input.length === 0) return 0;

  // First, count CJK characters separately and strip them so the
  // word-based heuristic does not under-count.
  let cjkChars = 0;
  const noCjk = input.replace(CJK_RUN, (run) => {
    cjkChars += [...run].length; // surrogate-safe character count
    return " ";
  });

  // Word-based estimate for the rest. Empty splits collapse out of
  // the count.
  const words = noCjk
    .replace(WS_RUN, " ")
    .trim()
    .split(" ")
    .filter((w) => w.length > 0);

  // 1.3 tokens per word approximates GPT BPE on English prose;
  // punctuation-heavy content rounds up naturally because each
  // punctuation cluster is its own "word" after the split.
  const wordTokens = Math.ceil(words.length * 1.3);

  return wordTokens + cjkChars;
}
