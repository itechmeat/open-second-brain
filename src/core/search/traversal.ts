/**
 * Link-graph traversal during recall.
 *
 * Relevance ranking answers "which documents match the query". This
 * second stage answers "what is one or two hops away from a strong
 * match" - common in vault workflows where one principle links to
 * several application notes. For each top hit we follow outbound
 * wikilinks, surfacing linked documents scored as
 * `parent_score * hop_decay^hop`, deduped against the existing result
 * set (an already-present document keeps its higher relevance score).
 *
 * Pure function: `search.ts` precomputes the outbound adjacency and a
 * representative chunk per document; this module does the bounded walk
 * and scoring. No I/O.
 */

import type { BrainSearchResult } from "./types.ts";

/** Representative chunk of an expansion document (one per documentId). */
export interface TraversalDoc {
  readonly documentId: number;
  readonly chunkId: number;
  readonly path: string;
  readonly title: string | null;
  readonly content: string;
  readonly startLine: number;
  readonly endLine: number;
}

export interface TraversalInputs {
  /** Relevance-ranked results, sorted by score descending. */
  readonly ranked: ReadonlyArray<BrainSearchResult>;
  /** documentId -> outbound-linked documentIds (resolved targets). */
  readonly outbound: ReadonlyMap<number, ReadonlyArray<number>>;
  /** Representative chunk for an expansion document, or null if absent. */
  readonly expansionDoc: (documentId: number) => TraversalDoc | null;
}

export interface TraversalOptions {
  /** Maximum hop depth. 0 disables traversal (identity). */
  readonly maxHops: number;
  /** Per-hop score multiplier in (0, 1]. */
  readonly hopDecay: number;
  /** Cap on links followed per node. */
  readonly maxExpansionPerHit: number;
}

/** Hard ceiling on seed hits we expand from, to keep recall bounded. */
const MAX_SEEDS = 10;

function makeLinkResult(
  doc: TraversalDoc,
  score: number,
  hop: number,
  fromPath: string,
): BrainSearchResult {
  return Object.freeze({
    documentId: doc.documentId,
    chunkId: doc.chunkId,
    path: doc.path,
    title: doc.title,
    content: doc.content,
    startLine: doc.startLine,
    endLine: doc.endLine,
    score,
    keywordScore: 0,
    semanticScore: 0,
    linkBoost: 0,
    recencyBoost: 0,
    searchType: "link" as const,
    reasons: Object.freeze([`link_traversal: hop ${hop} from ${fromPath}`]),
  });
}

/**
 * Expand the ranked set by walking outbound links. Returns a new array
 * (ranked results first, then deduped expansions) re-sorted by score
 * descending. Identity when `maxHops <= 0` or there is nothing to walk.
 */
export function expandByTraversal(
  inputs: TraversalInputs,
  opts: TraversalOptions,
): BrainSearchResult[] {
  if (opts.maxHops <= 0 || inputs.ranked.length === 0) {
    return inputs.ranked.slice();
  }
  const decay = opts.hopDecay > 0 && opts.hopDecay <= 1 ? opts.hopDecay : 1;
  const perHit = Math.max(0, opts.maxExpansionPerHit | 0);
  if (perHit === 0) return inputs.ranked.slice();

  // Documents already represented by a relevance hit must never be
  // replaced by a lower-scored traversal copy.
  const present = new Set<number>();
  for (const r of inputs.ranked) present.add(r.documentId);

  // Best traversal score per newly-surfaced document (dedup; keep max).
  const added = new Map<number, BrainSearchResult>();

  // BFS frontier of (documentId, hop, score). Seeds are the top hits.
  interface Node {
    readonly documentId: number;
    readonly hop: number;
    readonly score: number;
    readonly fromPath: string;
  }
  const queue: Node[] = [];
  for (const seed of inputs.ranked.slice(0, MAX_SEEDS)) {
    queue.push({
      documentId: seed.documentId,
      hop: 0,
      score: seed.score,
      fromPath: seed.path,
    });
  }

  while (queue.length > 0) {
    const node = queue.shift()!;
    if (node.hop >= opts.maxHops) continue;
    const targets = inputs.outbound.get(node.documentId);
    if (!targets || targets.length === 0) continue;
    let expanded = 0;
    for (const targetId of targets) {
      if (expanded >= perHit) break;
      if (targetId === node.documentId || present.has(targetId)) continue;
      expanded++;
      const hopScore = node.score * decay;
      const existing = added.get(targetId);
      if (existing && existing.score >= hopScore) {
        // Already surfaced at an equal-or-better score; do not enqueue
        // a weaker path again (keeps the walk terminating).
        continue;
      }
      const doc = inputs.expansionDoc(targetId);
      if (!doc) continue;
      added.set(
        targetId,
        makeLinkResult(doc, hopScore, node.hop + 1, node.fromPath),
      );
      queue.push({
        documentId: targetId,
        hop: node.hop + 1,
        score: hopScore,
        fromPath: doc.path,
      });
    }
  }

  if (added.size === 0) return inputs.ranked.slice();

  const merged = [...inputs.ranked, ...added.values()];
  merged.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.chunkId - b.chunkId;
  });
  return merged;
}
