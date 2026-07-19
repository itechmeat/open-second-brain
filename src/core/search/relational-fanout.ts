/**
 * Typed-edge relational fan-out (t_09b7ccea).
 *
 * Generalizes single-hop link traversal to a SEED ARRAY with bounded
 * multi-hop depth (default 2), aggregating for each reached node its hop
 * distance, edge richness (how many typed edges reached it), and the set of
 * link types it was reached via. The result is a deterministic ranked node
 * list: nearer nodes first, richer nodes next, then document id.
 *
 * Deterministic and language-agnostic: it walks only typed edges already in
 * the index (edge types validated against the schema vocabulary upstream),
 * never inspecting note prose.
 */

/** The subset of Store this module needs; keeps it unit-testable. */
export interface RelationalFanoutStore {
  typedRelationEdgesForDocuments(documentIds: ReadonlyArray<number>): Array<{
    readonly sourceDocumentId: number;
    readonly relation: string;
    readonly target: string;
    readonly targetDocumentId: number | null;
  }>;
}

export interface RelationalNode {
  readonly documentId: number;
  /** Minimum hop distance from any seed (1 = direct neighbour). */
  readonly hops: number;
  /** Count of typed edges (across the traversal) that reached this node. */
  readonly edgeRichness: number;
  /** Distinct link types this node was reached via, sorted. */
  readonly viaLinkTypes: ReadonlyArray<string>;
  /** Deterministic rank score in (0, 1]; nearer + richer ranks higher. */
  readonly score: number;
}

export interface RelationalFanoutOptions {
  /** Maximum hop depth. Defaults to 2; clamped to >= 1. */
  readonly maxDepth?: number;
  /**
   * Edge types to traverse. Empty (the default) traverses every typed
   * edge; a non-empty list restricts the walk to those relations.
   */
  readonly edgeTypes?: ReadonlyArray<string>;
}

const DEFAULT_MAX_DEPTH = 2;
/** Per-edge richness bonus, capped so a nearer node always outranks a farther one. */
const RICHNESS_BONUS = 0.05;
const MAX_RICHNESS_BONUS = 0.49;

interface MutableNode {
  hops: number;
  edgeRichness: number;
  viaLinkTypes: Set<string>;
}

/**
 * Fan out from `seedDocumentIds` over typed edges, bounded to `maxDepth`
 * hops, returning reached nodes (seeds excluded) ranked deterministically.
 */
export function relationalFanout(
  store: RelationalFanoutStore,
  seedDocumentIds: ReadonlyArray<number>,
  opts: RelationalFanoutOptions = {},
): RelationalNode[] {
  const maxDepth = Math.max(1, opts.maxDepth ?? DEFAULT_MAX_DEPTH);
  const allowed = new Set((opts.edgeTypes ?? []).map((t) => t));
  const restrict = allowed.size > 0;

  const seeds = new Set(seedDocumentIds);
  const reached = new Map<number, MutableNode>();
  let frontier = [...seeds];

  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
    const edges = store.typedRelationEdgesForDocuments(frontier);
    const nextFrontier: number[] = [];
    for (const edge of edges) {
      if (restrict && !allowed.has(edge.relation)) continue;
      const targetId = edge.targetDocumentId;
      if (targetId === null || seeds.has(targetId)) continue;
      const existing = reached.get(targetId);
      if (existing === undefined) {
        reached.set(targetId, {
          hops: depth,
          edgeRichness: 1,
          viaLinkTypes: new Set([edge.relation]),
        });
        nextFrontier.push(targetId);
      } else {
        existing.edgeRichness += 1;
        existing.viaLinkTypes.add(edge.relation);
        // hops keeps the minimum (first reached), which is `depth` order.
      }
    }
    frontier = nextFrontier;
  }

  const nodes: RelationalNode[] = [];
  for (const [documentId, node] of reached) {
    const score = 1 / node.hops + Math.min(MAX_RICHNESS_BONUS, RICHNESS_BONUS * node.edgeRichness);
    nodes.push(
      Object.freeze({
        documentId,
        hops: node.hops,
        edgeRichness: node.edgeRichness,
        viaLinkTypes: Object.freeze(
          [...node.viaLinkTypes].toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
        ),
        score,
      }),
    );
  }
  // Nearer first, then richer, then stable by document id.
  nodes.sort((a, b) => {
    if (a.hops !== b.hops) return a.hops - b.hops;
    if (a.edgeRichness !== b.edgeRichness) return b.edgeRichness - a.edgeRichness;
    return a.documentId - b.documentId;
  });
  return nodes;
}
