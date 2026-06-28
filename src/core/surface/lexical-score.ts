/**
 * Deterministic BM25-style lexical scorer over surface descriptors
 * (Agent Surface Suite). No LLM, no embeddings - tokenized term
 * matching with field weights, reproducible across processes.
 *
 * Field weighting follows the house convention from search ranking:
 * a name-token match is the strongest relevance signal, tags sit
 * between name and description. Weights are applied as term-frequency
 * multipliers so one BM25 core serves both turn-vs-tool and
 * turn-vs-skill scoring without divergent formulas.
 */

import type { SurfaceDescriptor } from "./descriptor.ts";

export interface ScoredDescriptor {
  readonly descriptor: SurfaceDescriptor;
  readonly score: number;
}

export interface LexicalScoreOptions {
  /** Term-frequency multiplier for name tokens. Default 3. */
  readonly nameWeight?: number;
  /** Term-frequency multiplier for tag tokens. Default 2. */
  readonly tagWeight?: number;
  /** BM25 k1 (term-frequency saturation). Default 1.2. */
  readonly k1?: number;
  /** BM25 b (length normalisation). Default 0.75. */
  readonly b?: number;
}

const DEFAULTS = Object.freeze({ nameWeight: 3, tagWeight: 2, k1: 1.2, b: 0.75 });

/**
 * Lowercase, split on non-alphanumerics, drop 1-char tokens. Plain
 * toLowerCase keeps tokenisation identical across host locales.
 * Han text without spaces (e.g. "实现方式") additionally gets overlapping
 * bigrams so queries like "gbrain的实现方式" can match trigger/description
 * tokens like "实现方式". This bigram pass is intentionally global to the
 * tokenizer (not gated behind skills_attach_triggers): ASCII tokenisation
 * is provably unchanged, and the only consumer of scoreDescriptors today
 * is the skill-attach path. The range covers Han Unified Ideographs only;
 * kana / Hangul / CJK extensions are not bigram-split.
 */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 2) continue;
    // Han bigram pass: a token with a Han character and length > 2 also
    // emits overlapping 2-char windows so "实现方式" and "的实现方式"
    // share the bigram "实现".
    if (/[\u4e00-\u9fff]/.test(raw) && raw.length > 2) {
      for (let i = 0; i < raw.length - 1; i++) {
        out.push(raw.slice(i, i + 2));
      }
    }
    out.push(raw);
  }
  return out;
}

interface DescriptorDoc {
  readonly descriptor: SurfaceDescriptor;
  /** token -> weighted term frequency */
  readonly tf: ReadonlyMap<string, number>;
  readonly length: number;
}

function buildDoc(
  descriptor: SurfaceDescriptor,
  opts: Required<LexicalScoreOptions>,
): DescriptorDoc {
  const tf = new Map<string, number>();
  let length = 0;
  const add = (tokens: string[], weight: number): void => {
    for (const token of tokens) {
      tf.set(token, (tf.get(token) ?? 0) + weight);
      length += weight;
    }
  };
  add(tokenize(descriptor.name), opts.nameWeight);
  add(tokenize(descriptor.tags.join(" ")), opts.tagWeight);
  add(tokenize(descriptor.description), 1);
  return { descriptor, tf, length };
}

/**
 * Rank descriptors against a free-text query. Zero-score entries are
 * dropped; ties break by descriptor name ascending so output is fully
 * deterministic.
 */
export function scoreDescriptors(
  query: string,
  descriptors: ReadonlyArray<SurfaceDescriptor>,
  options: LexicalScoreOptions = {},
): ScoredDescriptor[] {
  const opts = { ...DEFAULTS, ...options };
  const queryTokens = [...new Set(tokenize(query))];
  if (queryTokens.length === 0 || descriptors.length === 0) return [];

  const docs = descriptors.map((d) => buildDoc(d, opts));
  const n = docs.length;
  const avgLength = docs.reduce((sum, doc) => sum + doc.length, 0) / n || 1;

  // Document frequency per query token (over weighted-tf presence).
  const df = new Map<string, number>();
  for (const token of queryTokens) {
    let count = 0;
    for (const doc of docs) if (doc.tf.has(token)) count++;
    df.set(token, count);
  }

  const scored: ScoredDescriptor[] = [];
  for (const doc of docs) {
    let score = 0;
    for (const token of queryTokens) {
      const tf = doc.tf.get(token);
      if (tf === undefined) continue;
      const docFreq = df.get(token) ?? 0;
      // BM25+ style idf floor: keeps a term present in every document
      // from zeroing out, which matters in tiny descriptor corpora.
      const idf = Math.log(1 + (n - docFreq + 0.5) / (docFreq + 0.5));
      const norm = tf + opts.k1 * (1 - opts.b + opts.b * (doc.length / avgLength));
      score += idf * ((tf * (opts.k1 + 1)) / norm);
    }
    if (score > 0) scored.push({ descriptor: doc.descriptor, score });
  }

  scored.sort(
    (a, b) =>
      b.score - a.score ||
      (a.descriptor.name < b.descriptor.name ? -1 : a.descriptor.name > b.descriptor.name ? 1 : 0),
  );
  return scored;
}
