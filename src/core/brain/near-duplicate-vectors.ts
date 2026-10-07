/**
 * Stored-vector tier for retire siblings (near-duplicate defense,
 * t_acab97de): cosine similarity between a probe page and candidate pages
 * over the vectors the search index ALREADY holds. Zero provider calls -
 * this module never imports from the embeddings layer, and a test pins
 * that by scanning its source. Same precedent as `surprisal.ts`: open the
 * store read-only and read what reindexing paid for.
 *
 * Only content chunks are compared. The indexer emits a page's frontmatter
 * as chunks of their own, and two preference frontmatter blocks share
 * their keys and most values, so a frontmatter pair would score near 1 for
 * any two preferences.
 *
 * The outcome is a named status, never a silent degrade:
 *   - `index_missing`: no index has been built;
 *   - `vec_unavailable`: the sqlite-vec extension did not load;
 *   - `not_embedded`: the probe has no stored content vector yet, so
 *     nothing was compared;
 *   - `model_mismatch`: the probe's stored vectors were written under a
 *     model or dimension other than the configured one;
 *   - `used`: the probe was compared; a candidate without comparable
 *     stored vectors simply has no score.
 * Any other store failure is a named `SearchError` and propagates.
 */

import { Store } from "../search/store.ts";
import type { ChunkRow } from "../search/store.ts";
import type { StoredChunkEmbedding } from "../search/store/vectors.ts";
import { SearchError } from "../search/search-error.ts";
import type { ResolvedSearchConfig } from "../search/types.ts";

export type StoredVectorStatus =
  | "used"
  | "index_missing"
  | "vec_unavailable"
  | "not_embedded"
  | "model_mismatch";

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
  return (await storedVectorSimilarities(config, [probePath], candidatePaths, deps))[0]!;
}

/**
 * {@link storedVectorSimilarity} for several probes over one read store:
 * one result per probe, in order, and each page's stored rows read once.
 */
export async function storedVectorSimilarities(
  config: ResolvedSearchConfig,
  probePaths: ReadonlyArray<string>,
  candidatePaths: ReadonlyArray<string>,
  deps: StoredVectorDeps = {},
): Promise<ReadonlyArray<StoredVectorSimilarity>> {
  const every = (status: StoredVectorStatus): ReadonlyArray<StoredVectorSimilarity> =>
    probePaths.map(() => ({ status, scores: NO_SCORES }));
  let store: Store;
  try {
    store = await Store.open(config, {
      mode: "read",
      ...(deps.loadVec !== undefined ? { loadVec: deps.loadVec } : {}),
    });
  } catch (e) {
    if (e instanceof SearchError && e.code === "INDEX_MISSING") return every("index_missing");
    throw e;
  }
  try {
    if (!store.vecLoaded()) return every("vec_unavailable");
    const rowsByPath = new Map<string, ReadonlyArray<StoredChunkEmbedding>>();
    const stored = (path: string): ReadonlyArray<StoredChunkEmbedding> => {
      const cached = rowsByPath.get(path);
      if (cached !== undefined) return cached;
      const docId = store.getDocumentIdByPath(path);
      let rows: ReadonlyArray<StoredChunkEmbedding> = [];
      if (docId !== null) {
        const frontmatter = frontmatterChunkIds(store.getChunksByDocument(docId));
        rows = store.storedEmbeddingsForDocument(docId).filter((r) => !frontmatter.has(r.chunkId));
      }
      rowsByPath.set(path, rows);
      return rows;
    };
    const { model, dimension } = config.semantic;
    return probePaths.map((probePath): StoredVectorSimilarity => {
      const probeRows = stored(probePath);
      if (probeRows.length === 0) return { status: "not_embedded", scores: NO_SCORES };
      const usable = probeRows.filter(
        (r) =>
          (model === null || r.model === model) &&
          (dimension === null || r.dimension === dimension),
      );
      if (usable.length === 0) return { status: "model_mismatch", scores: NO_SCORES };
      const scores = new Map<string, number>();
      for (const path of candidatePaths) {
        if (path === probePath) continue;
        const best = bestPairCosine(usable, stored(path));
        if (best !== null) scores.set(path, best);
      }
      return { status: "used", scores };
    });
  } finally {
    await store.close();
  }
}

/**
 * Ids of the leading chunks the chunker emitted for the frontmatter block:
 * chunk 0 opens with the `---` fence, and the block runs through the chunk
 * that ends on the closing fence. An oversize block spans several chunks,
 * and no body text shares a chunk with it.
 */
function frontmatterChunkIds(chunks: ReadonlyArray<ChunkRow>): Set<number> {
  const ids = new Set<number>();
  const ordered = chunks.toSorted((a, b) => a.chunkIndex - b.chunkIndex);
  const first = ordered[0];
  if (first === undefined || first.content.split("\n")[0]!.trim() !== "---") return ids;
  for (const [i, chunk] of ordered.entries()) {
    ids.add(chunk.id);
    const lines = chunk.content.trimEnd().split("\n");
    // Chunk 0's first line is the opening fence, never the closing one.
    const tail = i === 0 ? lines.slice(1) : lines;
    if (tail.at(-1)?.trim() === "---") break;
  }
  return ids;
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
