/**
 * Bundled offline reranker (Retrieval & Ranking Quality, t_9f95ebb6).
 *
 * A deterministic, dependency-free cross-encoder-SHAPED reranker: it jointly
 * scores a query against each candidate document and returns one relevance
 * score per document, aligned to input order - the same contract the remote
 * cross-encoder provider implements, but computed locally with no model
 * runtime and no network.
 *
 * Following the OSB idiom (the local embedder is pure feature-hashing, not a
 * bundled neural model), the score is a blend of lexical/structural
 * query-document features rather than a learned transformer:
 *   - coverage  - fraction of distinct query terms present in the document,
 *   - proximity - how tightly the matched query terms cluster,
 *   - density   - bounded query-term frequency within the document.
 * Coverage dominates, so a document that answers more of the query ranks
 * above one that merely repeats a single term. Deterministic: identical
 * (query, documents) always yields identical scores.
 */

import type { RerankProvider } from "./provider.ts";

const TOKEN_RE = /[\p{L}\p{N}]{2,}/gu;

function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const m of text.toLowerCase().matchAll(TOKEN_RE)) out.push(m[0]);
  return out;
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Blend weights (sum to 1). Coverage-dominant by design. */
const W_COVERAGE = 0.6;
const W_PROXIMITY = 0.25;
const W_DENSITY = 0.15;

export function scoreLocalRerank(query: string, document: string): number {
  const queryTerms = [...new Set(tokenize(query))];
  if (queryTerms.length === 0) return 0;

  const docTokens = tokenize(document);
  if (docTokens.length === 0) return 0;

  const counts = new Map<string, number>();
  const firstPos = new Map<string, number>();
  for (let i = 0; i < docTokens.length; i++) {
    const t = docTokens[i]!;
    counts.set(t, (counts.get(t) ?? 0) + 1);
    if (!firstPos.has(t)) firstPos.set(t, i);
  }

  const present = queryTerms.filter((t) => counts.has(t));
  if (present.length === 0) return 0;

  const coverage = present.length / queryTerms.length;

  let densityAcc = 0;
  for (const t of queryTerms) densityAcc += Math.min(counts.get(t) ?? 0, 3);
  const density = densityAcc / (3 * queryTerms.length);

  let proximity = coverage;
  if (present.length > 1) {
    const positions = present.map((t) => firstPos.get(t)!);
    const span = Math.max(...positions) - Math.min(...positions);
    // present terms in the smallest span -> proximity 1; spread out -> lower.
    proximity = clamp01(present.length / (span + 1));
  }

  return clamp01(W_COVERAGE * coverage + W_PROXIMITY * proximity + W_DENSITY * density);
}

/** The bundled offline reranker. Stateless, deterministic, network-free. */
export class LocalRerankProvider implements RerankProvider {
  readonly name = "local";
  readonly model = "local-lexical-v1";

  rerank(query: string, documents: ReadonlyArray<string>): Promise<number[]> {
    return Promise.resolve(documents.map((doc) => scoreLocalRerank(query, doc)));
  }
}
