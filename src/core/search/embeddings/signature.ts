/**
 * Embedding signature + cost kernel (Embedding Provider Suite).
 *
 * The single source of provider-identity truth shared by the local
 * embedder, the provider registry, the cost gate, and the store's
 * corpus-generation fingerprint. Centralising it here keeps those call
 * sites from drifting on what "the same embedding configuration" means.
 *
 * Pure and I/O-free: canonicalise an identity to a stable signature
 * string, look up a best-effort per-model price, estimate tokens and
 * spend, and compare two signatures for staleness.
 */

/** Identity triple that determines whether two embeddings are comparable. */
export interface EmbeddingIdentity {
  readonly provider: string;
  readonly model: string | null;
  readonly dimension: number | null;
}

/** Model name produced by the offline local embedder (priced at 0). */
export const LOCAL_EMBEDDING_MODEL = "hashing-ngram-v1";

/** Sentinel for a null model/dimension so signatures stay parseable. */
const NULL_FIELD = "?";

function canonicalToken(raw: string): string {
  return raw.normalize("NFC").trim().toLowerCase();
}

/**
 * Canonical signature `<provider>:<model>:<dimension>`. Provider and
 * model are NFC-normalised, trimmed, and lowercased; a null model or
 * dimension renders as the stable `?` sentinel. Two configurations that
 * produce the same signature yield comparable vectors.
 */
export function embeddingSignature(id: EmbeddingIdentity): string {
  const provider = canonicalToken(id.provider);
  const model = id.model === null ? NULL_FIELD : canonicalToken(id.model);
  const dimension = id.dimension === null ? NULL_FIELD : String(id.dimension);
  return `${provider}:${model}:${dimension}`;
}

/**
 * Best-effort embedding price in USD per million input tokens, keyed by
 * model name. Rates drift as providers change pricing, so the table is
 * deliberately small and any model NOT listed is treated as free
 * (price 0) - the cost gate must never falsely block on a model whose
 * rate we do not know. The local embedder is listed explicitly at 0.
 */
export const EMBEDDING_PRICING: Readonly<Record<string, number>> = Object.freeze({
  [LOCAL_EMBEDDING_MODEL]: 0,
  "text-embedding-3-small": 0.02,
  "text-embedding-3-large": 0.13,
  "text-embedding-ada-002": 0.1,
});

/** Per-million-token price for a model; 0 for the local/unknown/null case. */
export function pricePerMillionTokens(model: string | null): number {
  if (model === null) return 0;
  const rate = EMBEDDING_PRICING[canonicalToken(model)];
  return typeof rate === "number" && Number.isFinite(rate) && rate > 0 ? rate : 0;
}

/**
 * Cheap token estimate: a chars/4 heuristic per text, rounded up, summed.
 * This is the same order-of-magnitude approximation embedding providers
 * use for quick quotes; it intentionally avoids a real tokenizer so the
 * estimate stays dependency-free and deterministic.
 */
export function estimateTokens(texts: ReadonlyArray<string>): number {
  let total = 0;
  for (const t of texts) {
    if (t.length === 0) continue;
    total += Math.ceil(t.length / 4);
  }
  return total;
}

/** Estimated spend in USD for `tokens` against `model`'s rate. */
export function estimateCostUsd(tokens: number, model: string | null): number {
  const rate = pricePerMillionTokens(model);
  if (rate === 0) return 0;
  return (tokens / 1_000_000) * rate;
}

/** True when the active signature differs from the stored one. */
export function isStaleSignature(active: string, stored: string): boolean {
  return active !== stored;
}
