/**
 * Offline local embedder (Embedding Provider Suite).
 *
 * A dependency-free, deterministic embedder that works the instant the
 * package installs - no cloud call, no API key, no model download. It
 * uses the feature-hashing ("hashing trick") technique: token unigrams
 * and character trigrams are hashed into a fixed-dimension vector with a
 * signed bucket, then unit-normalised so the existing cosine-from-L2
 * ranker math is unchanged.
 *
 * This is a lexical baseline, not a transformer: it matches shared
 * tokens and subword shapes, not paraphrase or semantics. It exists so a
 * privacy-first install has a no-cloud recall path; `openai-compat`
 * remains the recommended provider for semantic depth. A future opt-in
 * local transformer can register as a distinct model without touching
 * this one.
 */

import type { EmbeddingProvider } from "./contract.ts";
import { LOCAL_EMBEDDING_MODEL } from "./signature.ts";

/** Default vector width when `embedding_dimension` is not configured. */
export const LOCAL_DEFAULT_DIMENSION = 256;

/** FNV-1a 32-bit hash, seeded so the two derived hashes diverge. */
function fnv1a(text: string, seed: number): number {
  let h = (0x811c9dc5 ^ seed) >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    // h *= 16777619, kept in 32-bit via the shift-add decomposition.
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

/** Tokens (unigrams) plus padded character trigrams, the hashed features. */
function* features(text: string): Generator<string> {
  const tokens = text
    .normalize("NFC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u);
  for (const tok of tokens) {
    if (tok.length === 0) continue;
    yield `w:${tok}`;
    const padded = `^${tok}$`;
    for (let i = 0; i + 3 <= padded.length; i++) {
      yield `t:${padded.slice(i, i + 3)}`;
    }
  }
}

function embedOne(text: string, dimension: number): number[] {
  const vec: number[] = Array.from({ length: dimension }, () => 0);
  for (const feature of features(text)) {
    const bucket = fnv1a(feature, 0) % dimension;
    const sign = (fnv1a(feature, 0x9e3779b9) & 1) === 0 ? 1 : -1;
    vec[bucket]! += sign;
  }
  let sumSquares = 0;
  for (const x of vec) sumSquares += x * x;
  const len = Math.sqrt(sumSquares);
  if (len === 0) return vec; // empty / featureless text -> zero vector
  for (let i = 0; i < dimension; i++) vec[i]! /= len;
  return vec;
}

export class LocalProvider implements EmbeddingProvider {
  readonly name = "local";
  readonly model = LOCAL_EMBEDDING_MODEL;
  readonly dimension: number;

  constructor(dimension: number = LOCAL_DEFAULT_DIMENSION) {
    this.dimension = Math.max(1, Math.floor(dimension));
  }

  async embed(texts: ReadonlyArray<string>): Promise<number[][]> {
    return texts.map((t) => embedOne(t, this.dimension));
  }

  async ping(): Promise<{ ok: true; dimension: number } | { ok: false; reason: string }> {
    return { ok: true, dimension: this.dimension };
  }
}
