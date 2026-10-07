/**
 * Stored-vector tier for retire siblings (near-duplicate defense,
 * t_acab97de): cosine similarity between a probe page and candidate pages
 * over the vectors the search index ALREADY holds. Zero provider calls -
 * this module never imports from the embeddings layer, and a test pins
 * that by scanning its source. Same precedent as `surprisal.ts`: open the
 * store read-only and read what reindexing paid for.
 *
 * The outcome is a named status, never a silent degrade:
 *   - `index_missing`: no index has been built;
 *   - `vec_unavailable`: the sqlite-vec extension did not load;
 *   - `model_mismatch`: the probe's stored vectors were written under a
 *     model or dimension other than the configured one;
 *   - `used`: the tier ran; a probe or candidate without comparable
 *     stored vectors simply has no score.
 * Any other store failure is a named `SearchError` and propagates.
 */

import { Store } from "../search/store.ts";
import type { StoredChunkEmbedding } from "../search/store/vectors.ts";
import { SearchError } from "../search/search-error.ts";
import type { ResolvedSearchConfig } from "../search/types.ts";

export type StoredVectorStatus = "used" | "index_missing" | "vec_unavailable" | "model_mismatch";

export interface StoredVectorSimilarity {
  readonly status: StoredVectorStatus;
  /** Vault-relative candidate path -> max chunk-pair cosine. */
  readonly scores: ReadonlyMap<string, number>;
}

export interface StoredVectorDeps {
  /** Whether the store loads sqlite-vec; omitted loads it. */
  readonly loadVec?: boolean;
}

const NO_SCORES: ReadonlyMap<string, number> = new Map();

/**
 * Score every candidate against the probe by the best cosine over their
 * comparable chunk pairs (same model, same dimension, finite). The probe's
 * rows must match the configured model and dimension when those are set.
 */
export async function storedVectorSimilarity(
  config: ResolvedSearchConfig,
  probePath: string,
  candidatePaths: ReadonlyArray<string>,
  deps: StoredVectorDeps = {},
): Promise<StoredVectorSimilarity> {
  let store: Store;
  try {
    store = await Store.open(config, {
      mode: "read",
      ...(deps.loadVec !== undefined ? { loadVec: deps.loadVec } : {}),
    });
  } catch (e) {
    if (e instanceof SearchError && e.code === "INDEX_MISSING") {
      return { status: "index_missing", scores: NO_SCORES };
    }
    throw e;
  }
  try {
    if (!store.vecLoaded()) return { status: "vec_unavailable", scores: NO_SCORES };
    const stored = (path: string): ReadonlyArray<StoredChunkEmbedding> => {
      const docId = store.getDocumentIdByPath(path);
      return docId === null ? [] : store.storedEmbeddingsForDocument(docId);
    };
    const probeRows = stored(probePath);
    const { model, dimension } = config.semantic;
    const usable = probeRows.filter(
      (r) =>
        (model === null || r.model === model) && (dimension === null || r.dimension === dimension),
    );
    if (probeRows.length > 0 && usable.length === 0) {
      return { status: "model_mismatch", scores: NO_SCORES };
    }
    const scores = new Map<string, number>();
    if (usable.length === 0) return { status: "used", scores };
    for (const path of candidatePaths) {
      if (path === probePath) continue;
      const best = bestPairCosine(usable, stored(path));
      if (best !== null) scores.set(path, best);
    }
    return { status: "used", scores };
  } finally {
    await store.close();
  }
}

function bestPairCosine(
  probe: ReadonlyArray<StoredChunkEmbedding>,
  candidate: ReadonlyArray<StoredChunkEmbedding>,
): number | null {
  let best: number | null = null;
  for (const a of probe) {
    for (const b of candidate) {
      if (a.model !== b.model || a.dimension !== b.dimension) continue;
      if (a.vector.length !== a.dimension || b.vector.length !== b.dimension) continue;
      const score = cosine(a.vector, b.vector);
      // A zero or non-finite row from an index written before the store
      // guard has no direction: unusable, never a NaN score.
      if (!Number.isFinite(score)) continue;
      if (best === null || score > best) best = score;
    }
  }
  return best;
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
