/**
 * Store-backed link-graph expansion phases: fetch the outbound adjacency
 * / typed-relation edges the pure scoring layers need, then delegate the
 * bounded scoring to `expandByTraversal` (link-graph traversal) and
 * `applyRelationPolarity` (typed relation polarity).
 */

import { applyRelationPolarity } from "./relation-polarity.ts";
import { Store } from "./store.ts";
import { expandByTraversal, type TraversalOptions } from "./traversal.ts";
import type { BrainSearchResult } from "./types.ts";

/**
 * Walk outbound links from the ranked hits and merge in related
 * documents. Fetches the outbound adjacency level-by-level (each
 * document fetched once) up to `maxHops`, then delegates the bounded
 * scoring to the pure `expandByTraversal`.
 */
export function applyTraversal(
  store: Store,
  ranked: BrainSearchResult[],
  opts: TraversalOptions,
): BrainSearchResult[] {
  const seedDocIds = Array.from(new Set(ranked.map((r) => r.documentId)));
  const present = new Set(seedDocIds);
  const outbound = new Map<number, ReadonlyArray<number>>();
  const seen = new Set<number>(seedDocIds);
  let level = new Set<number>(seedDocIds);

  for (let hop = 0; hop < opts.maxHops && level.size > 0; hop++) {
    const toFetch = Array.from(level).filter((id) => !outbound.has(id));
    if (toFetch.length === 0) break;
    const adjacency = store.outboundLinkTargets(toFetch);
    const next = new Set<number>();
    for (const [src, targets] of adjacency) {
      outbound.set(src, targets);
      for (const t of targets) {
        if (!seen.has(t)) {
          seen.add(t);
          next.add(t);
        }
      }
    }
    level = next;
  }

  const expansionIds = Array.from(seen).filter((id) => !present.has(id));
  if (expansionIds.length === 0) return ranked;
  const reps = store.representativeChunks(expansionIds);

  return expandByTraversal(
    {
      ranked,
      outbound,
      expansionDoc: (docId) => {
        const h = reps.get(docId);
        if (!h) return null;
        return {
          documentId: h.documentId,
          chunkId: h.chunkId,
          path: h.path,
          title: h.title,
          content: h.content,
          startLine: h.startLine,
          endLine: h.endLine,
        };
      },
    },
    opts,
  );
}

/**
 * Fetch the typed relation edges declared by the pool's documents and
 * delegate the polarity adjustment to the pure `applyRelationPolarity`.
 * Successor pull-in reuses the traversal layer's representative-chunk
 * mechanism (document head as the surfaced chunk).
 */
export function applyRelationPolarityPhase(
  store: Store,
  ranked: ReadonlyArray<BrainSearchResult>,
  includeSuperseded: boolean,
): ReadonlyArray<BrainSearchResult> {
  if (ranked.length === 0) return ranked;
  const docIds = Array.from(new Set(ranked.map((r) => r.documentId)));
  const edges = store.typedRelationEdgesForDocuments(docIds);
  if (edges.length === 0) return ranked;

  const present = new Set(docIds);
  const successorIds = Array.from(
    new Set(
      edges
        .map((e) => e.targetDocumentId)
        .filter((id): id is number => id !== null && !present.has(id)),
    ),
  );
  const reps = store.representativeChunks(successorIds);

  return applyRelationPolarity(
    {
      ranked,
      edges,
      successorDoc: (docId) => {
        const h = reps.get(docId);
        if (!h) return null;
        return {
          documentId: h.documentId,
          chunkId: h.chunkId,
          path: h.path,
          title: h.title,
          content: h.content,
          startLine: h.startLine,
          endLine: h.endLine,
        };
      },
    },
    { includeSuperseded },
  );
}
