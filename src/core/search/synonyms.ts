/**
 * Pure, language-agnostic query expansion via local co-occurrence
 * (pseudo-relevance feedback), v0.20.0.
 *
 * Goal: broaden recall when the caller's wording differs from the stored
 * wording, WITHOUT any per-language synonym dictionary. The signal is
 * derived entirely from the vault's own content: given the top candidate
 * chunks for the original query, the terms that co-occur across several
 * of those chunks (but are not themselves in the query) are likely
 * related and worth adding as optional FTS alternatives.
 *
 * Tokenization is purely structural - maximal Unicode letter/digit runs,
 * lowercased. There is deliberately NO language-specific segmentation
 * (a continuous CJK run stays one token, exactly as FTS5 indexes it), so
 * the behaviour is identical across scripts and bit-stable on every
 * Syncthing peer.
 *
 * The module is pure and deterministic: no I/O, no clock, no randomness.
 * Ties break alphabetically so the output never depends on input order
 * beyond the documented frequency ranking.
 */

export interface ExpansionOptions {
  /** Maximum number of expansion terms to return. */
  readonly maxTerms: number;
  /** Minimum token length (in code points) to be eligible. */
  readonly minLength: number;
  /** Minimum number of distinct candidate docs a term must appear in. */
  readonly minDocFreq: number;
}

export const DEFAULT_EXPANSION: ExpansionOptions = Object.freeze({
  maxTerms: 3,
  minLength: 3,
  minDocFreq: 2,
});

const TOKEN_RE = /[\p{L}\p{N}]+/gu;

/** Maximal Unicode letter/digit runs, lowercased. No language rules. */
export function tokenizeForExpansion(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(TOKEN_RE)) {
    out.push(m[0].toLowerCase());
  }
  return out;
}

/** Code-point length, so multi-byte scripts are measured fairly. */
function codePointLength(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/**
 * Derive expansion terms from the texts of the top candidate chunks for
 * a query. Returns up to `maxTerms` terms that (a) are not query tokens,
 * (b) are at least `minLength` code points, and (c) appear in at least
 * `minDocFreq` distinct candidate docs - ranked by document frequency
 * descending, then alphabetically. Empty input or no qualifying term
 * yields `[]` (a no-op for the caller).
 */
export function deriveExpansionTerms(
  queryTokens: ReadonlyArray<string>,
  candidateTexts: ReadonlyArray<string>,
  opts: ExpansionOptions,
): string[] {
  if (candidateTexts.length === 0 || opts.maxTerms <= 0) return [];

  const queryset = new Set(queryTokens.map((t) => t.toLowerCase()));
  const docFreq = new Map<string, number>();

  for (const text of candidateTexts) {
    // Count each term once per document (document frequency).
    const seen = new Set<string>();
    for (const tok of tokenizeForExpansion(text)) {
      if (seen.has(tok)) continue;
      seen.add(tok);
      if (queryset.has(tok)) continue;
      if (codePointLength(tok) < opts.minLength) continue;
      docFreq.set(tok, (docFreq.get(tok) ?? 0) + 1);
    }
  }

  return [...docFreq.entries()]
    .filter(([, df]) => df >= opts.minDocFreq)
    .sort((a, b) => (b[1] !== a[1] ? b[1] - a[1] : a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, opts.maxTerms)
    .map(([term]) => term);
}
