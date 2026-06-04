/**
 * Surprisal-based novelty sampling (t_fddfe64a): rank inbox signals
 * by how far they sit from everything the vault already knows -
 * mean L2 distance from the signal's own indexed embedding to its k
 * nearest non-self neighbours over the EXISTING sqlite-vec index.
 * Zero provider calls: a signal that was never embedded (or a vault
 * with no vec layer at all) scores `null` and consumers stay
 * byte-identical. The score only reorders review surfaces; it never
 * changes which signals the dream pass processes.
 */

import { Store } from "../search/store.ts";
import type { ResolvedSearchConfig } from "../search/types.ts";

/** Neighbours averaged into one novelty score. */
export const SURPRISAL_NEIGHBORS = 5;

export interface SignalRef {
  readonly id: string;
  /** Vault-relative path of the signal file. */
  readonly relPath: string;
}

export interface SignalNoveltyEntry {
  readonly id: string;
  readonly path: string;
  /** Mean kNN distance, or null when no embedding exists. */
  readonly novelty: number | null;
}

/**
 * Score each signal's novelty. Degrades to all-null without throwing
 * when the index is missing, the vec extension is unavailable, or a
 * signal carries no embedding.
 */
export async function scoreSignalNovelty(
  config: ResolvedSearchConfig,
  signals: ReadonlyArray<SignalRef>,
): Promise<SignalNoveltyEntry[]> {
  const allNull = (): SignalNoveltyEntry[] =>
    signals.map((s) => Object.freeze({ id: s.id, path: s.relPath, novelty: null }));
  if (signals.length === 0) return [];

  let store: Store;
  try {
    store = await Store.open(config, { mode: "read" });
  } catch {
    return allNull();
  }
  try {
    if (!store.vecLoaded()) return allNull();
    const out: SignalNoveltyEntry[] = [];
    for (const signal of signals) {
      const docId = store.getDocumentIdByPath(signal.relPath);
      if (docId === null) {
        out.push(Object.freeze({ id: signal.id, path: signal.relPath, novelty: null }));
        continue;
      }
      const chunks = store.chunksForDocument(docId);
      const embedding = chunks.length > 0 ? store.embeddingForChunk(chunks[0]!.id) : null;
      if (embedding === null) {
        out.push(Object.freeze({ id: signal.id, path: signal.relPath, novelty: null }));
        continue;
      }
      // Over-fetch so dropping the signal's own chunks still leaves k
      // genuine neighbours.
      const hits = store.semanticTopK(embedding, {
        limit: SURPRISAL_NEIGHBORS + chunks.length + 4,
      });
      const distances = hits
        .filter((h) => h.documentId !== docId)
        .slice(0, SURPRISAL_NEIGHBORS)
        .map((h) => h.distance);
      const novelty =
        distances.length > 0
          ? Math.round((distances.reduce((a, b) => a + b, 0) / distances.length) * 1e6) / 1e6
          : null;
      out.push(Object.freeze({ id: signal.id, path: signal.relPath, novelty }));
    }
    return out;
  } catch {
    return allNull();
  } finally {
    await store.close();
  }
}

/**
 * Sort novelty entries for review surfaces: scored first (highest
 * novelty wins), null-scored after, ties by id for determinism.
 */
export function sortByNovelty(
  entries: ReadonlyArray<SignalNoveltyEntry>,
): ReadonlyArray<SignalNoveltyEntry> {
  return Object.freeze(
    [...entries].toSorted((a, b) => {
      if (a.novelty === null && b.novelty === null) return a.id < b.id ? -1 : 1;
      if (a.novelty === null) return 1;
      if (b.novelty === null) return -1;
      if (a.novelty !== b.novelty) return b.novelty - a.novelty;
      return a.id < b.id ? -1 : 1;
    }),
  );
}
