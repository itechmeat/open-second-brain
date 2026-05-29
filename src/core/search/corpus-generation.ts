/**
 * Corpus-generation fingerprint (v0.20.0).
 *
 * A short, deterministic string identifying the state of the index that
 * `search()` reads from. The query cache stores it alongside each cached
 * result and refuses to serve a row whose generation differs from the
 * current one, so the cache is invalidated the moment any input that can
 * change results changes:
 *
 *   - the embedding model or dimension (semantic ranking changes);
 *   - the schema version (index layout changes);
 *   - the monotonic index revision, bumped by the indexer whenever it
 *     mutates the index - so a content reindex invalidates the cache even
 *     though the embedding model/dimension/schema are unchanged.
 *
 * This is the documented "smaller first cut": generation-level
 * invalidation, not per-page corpus hashing.
 *
 * Pure and deterministic: no I/O, clock, or randomness.
 */

export interface CorpusGenerationInputs {
  readonly embeddingModel: string | null;
  readonly embeddingDimension: number | null;
  readonly schemaVersion: number;
  readonly indexRevision: number;
}

export function computeCorpusGeneration(inputs: CorpusGenerationInputs): string {
  const model = inputs.embeddingModel ?? "none";
  const dim = inputs.embeddingDimension ?? 0;
  return `${model}|${dim}|${inputs.schemaVersion}|${inputs.indexRevision}`;
}
