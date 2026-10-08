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
 *
 * Deepened traversal (truth-correctable-time-aware): the walk runs under
 * width budgets - a seed cap, a per-node expansion cap, a total-node cap -
 * skips expanding hub nodes (whose walked-edge degree exceeds a threshold),
 * and abandons the frontier deterministically once a caller-supplied
 * deadline predicate reports the clock fired, keeping every node already
 * reached. All four budgets ship as named constants and are overridable
 * through the `OPEN_SECOND_BRAIN_SEARCH_TRAVERSAL_*` environment variables
 * (or their `search_traversal_*` config keys) via {@link resolveTraversalBudgets}.
 */

import { SearchError } from "./search-error.ts";
import { parseInteger } from "../validate.ts";

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
  /**
   * Deterministic rank score `1/hops + min(MAX_RICHNESS_BONUS, RICHNESS_BONUS
   * * edgeRichness)`. Ranges in `(0, 1 + MAX_RICHNESS_BONUS]` (currently
   * `(0, 1.49]`), NOT a normalized `(0, 1]`. The richness bonus is capped
   * below the gap between adjacent hop tiers, so the hop-dominance invariant
   * holds: a nearer node always outranks a farther one regardless of richness.
   * Treat it as an intra-fanout ordering key, not a probability - do not
   * compose it with other bounded scores without renormalizing.
   */
  readonly score: number;
}

/** Maximum hop depth. Clamped to >= 1. */
const DEFAULT_MAX_DEPTH = 2;
/** Per-edge richness bonus, capped so a nearer node always outranks a farther one. */
const RICHNESS_BONUS = 0.05;
const MAX_RICHNESS_BONUS = 0.49;

// ─── traversal budgets (truth-correctable-time-aware) ───────────────────────

/** How many query seeds the walk admits, in the order the caller supplied. */
export const TRAVERSAL_MAX_SEEDS = 8;
/** How many walked edges of one node the walk may follow, in edge order. */
export const TRAVERSAL_MAX_EXPANSION_PER_NODE = 4;
/** How many nodes the walk may reach in total, across every depth. */
export const TRAVERSAL_MAX_TOTAL_NODES = 16;
/**
 * A reached node whose walked-edge degree (resolvable walked edges, typed
 * edges plus entity bridges) EXCEEDS this threshold is reached but never
 * expanded: its own fan-out is withheld from the frontier.
 */
export const TRAVERSAL_HUB_DEGREE_THRESHOLD = 12;

/** Environment override for {@link TRAVERSAL_MAX_SEEDS}. */
export const TRAVERSAL_MAX_SEEDS_ENV = "OPEN_SECOND_BRAIN_SEARCH_TRAVERSAL_MAX_SEEDS";
/** Environment override for {@link TRAVERSAL_MAX_EXPANSION_PER_NODE}. */
export const TRAVERSAL_MAX_EXPANSION_PER_NODE_ENV =
  "OPEN_SECOND_BRAIN_SEARCH_TRAVERSAL_MAX_EXPANSION_PER_NODE";
/** Environment override for {@link TRAVERSAL_MAX_TOTAL_NODES}. */
export const TRAVERSAL_MAX_TOTAL_NODES_ENV = "OPEN_SECOND_BRAIN_SEARCH_TRAVERSAL_MAX_TOTAL_NODES";
/** Environment override for {@link TRAVERSAL_HUB_DEGREE_THRESHOLD}. */
export const TRAVERSAL_HUB_DEGREE_THRESHOLD_ENV =
  "OPEN_SECOND_BRAIN_SEARCH_TRAVERSAL_HUB_DEGREE_THRESHOLD";

/** Machine-config key for {@link TRAVERSAL_MAX_SEEDS}. */
export const TRAVERSAL_MAX_SEEDS_CONFIG = "search_traversal_max_seeds";
/** Machine-config key for {@link TRAVERSAL_MAX_EXPANSION_PER_NODE}. */
export const TRAVERSAL_MAX_EXPANSION_PER_NODE_CONFIG = "search_traversal_max_expansion_per_node";
/** Machine-config key for {@link TRAVERSAL_MAX_TOTAL_NODES}. */
export const TRAVERSAL_MAX_TOTAL_NODES_CONFIG = "search_traversal_max_total_nodes";
/** Machine-config key for {@link TRAVERSAL_HUB_DEGREE_THRESHOLD}. */
export const TRAVERSAL_HUB_DEGREE_THRESHOLD_CONFIG = "search_traversal_hub_degree_threshold";

/** The four traversal width budgets, resolved from env/config over defaults. */
export interface TraversalBudgets {
  readonly maxSeeds: number;
  readonly maxExpansionPerNode: number;
  readonly maxTotalNodes: number;
  readonly hubDegreeThreshold: number;
}

interface RawBudgetSetting {
  readonly raw: string;
  readonly field: string;
}

/**
 * One budget's raw value with the name of the source actually in force,
 * by the same env-over-config precedence `envOrConfig` applies (a present
 * but empty value counts as unset). Named because a refusal must name the
 * key the operator wrote, not both keys.
 */
function rawBudget(
  env: NodeJS.ProcessEnv,
  config: Readonly<Record<string, string>> | undefined,
  envKey: string,
  configKey: string,
): RawBudgetSetting | null {
  const fromEnv = env[envKey];
  if (fromEnv !== undefined && fromEnv !== "") return { raw: fromEnv, field: envKey };
  const fromConfig = config?.[configKey];
  if (fromConfig !== undefined && fromConfig !== "") return { raw: fromConfig, field: configKey };
  return null;
}

/**
 * Resolve the four traversal budgets from the environment (preferred) or
 * the machine config map, falling back to the shipped constants. A value
 * that is not an integer >= 1 is a misconfiguration and is refused with a
 * `SearchError` naming the key in force - never silently defaulted.
 */
export function resolveTraversalBudgets(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly config?: Readonly<Record<string, string>>;
}): TraversalBudgets {
  const { env, config } = input;
  const int = (
    envKey: string,
    configKey: string,
    fallback: number,
    label: string,
  ): number => {
    const raw = rawBudget(env, config, envKey, configKey);
    if (raw === null) return fallback;
    try {
      return parseInteger(raw.raw, fallback, raw.field, { min: 1 });
    } catch (e) {
      throw new SearchError("INVALID_INPUT", `${label}: ${(e as Error).message}`);
    }
  };
  return Object.freeze({
    maxSeeds: int(
      TRAVERSAL_MAX_SEEDS_ENV,
      TRAVERSAL_MAX_SEEDS_CONFIG,
      TRAVERSAL_MAX_SEEDS,
      "relational traversal budget",
    ),
    maxExpansionPerNode: int(
      TRAVERSAL_MAX_EXPANSION_PER_NODE_ENV,
      TRAVERSAL_MAX_EXPANSION_PER_NODE_CONFIG,
      TRAVERSAL_MAX_EXPANSION_PER_NODE,
      "relational traversal budget",
    ),
    maxTotalNodes: int(
      TRAVERSAL_MAX_TOTAL_NODES_ENV,
      TRAVERSAL_MAX_TOTAL_NODES_CONFIG,
      TRAVERSAL_MAX_TOTAL_NODES,
      "relational traversal budget",
    ),
    hubDegreeThreshold: int(
      TRAVERSAL_HUB_DEGREE_THRESHOLD_ENV,
      TRAVERSAL_HUB_DEGREE_THRESHOLD_CONFIG,
      TRAVERSAL_HUB_DEGREE_THRESHOLD,
      "relational traversal budget",
    ),
  });
}

export interface RelationalFanoutOptions {
  /** Maximum hop depth. Defaults to 2; clamped to >= 1. */
  readonly maxDepth?: number;
  /**
   * Edge types to traverse. Empty (the default) traverses every typed
   * edge; a non-empty list restricts the walk to those relations.
   */
  readonly edgeTypes?: ReadonlyArray<string>;
  /** Seed cap. Defaults to {@link TRAVERSAL_MAX_SEEDS}; clamped to >= 1. */
  readonly maxSeeds?: number;
  /**
   * How many walked edges of one node may be followed. Defaults to
   * {@link TRAVERSAL_MAX_EXPANSION_PER_NODE}; clamped to >= 1.
   */
  readonly maxExpansionPerNode?: number;
  /** Total reached-node cap. Defaults to {@link TRAVERSAL_MAX_TOTAL_NODES}; clamped to >= 1. */
  readonly maxTotalNodes?: number;
  /**
   * Walked-edge degree above which a reached node is not expanded.
   * Defaults to {@link TRAVERSAL_HUB_DEGREE_THRESHOLD}; clamped to >= 1.
   */
  readonly hubDegreeThreshold?: number;
  /**
   * Fired-clock predicate bounding the walk (the composite recall deadline).
   * Checked before each depth round and before expanding each frontier
   * node; once it reports true, the walk stops and every node already
   * reached is kept. Absent means the caller takes no deadline - the
   * width caps above still bound the walk.
   */
  readonly isExpired?: () => boolean;
}

interface MutableNode {
  hops: number;
  edgeRichness: number;
  viaLinkTypes: Set<string>;
}

/**
 * Fan out from `seedDocumentIds` over typed edges, bounded to `maxDepth`
 * hops and the traversal width budgets, returning reached nodes (seeds
 * excluded) ranked deterministically.
 *
 * Budget semantics, all deterministic in the caller's edge order:
 *   - only the first `maxSeeds` distinct seeds enter the walk;
 *   - each node expands at most its first `maxExpansionPerNode` walked
 *     edges (restriction-passing, resolvable, non-seed targets);
 *   - once `maxTotalNodes` nodes have been reached the walk stops;
 *   - a reached node whose walked-edge degree exceeds
 *     `hubDegreeThreshold` is kept but never expanded;
 *   - a fired `isExpired` abandons the frontier, keeping what is reached.
 */
export function relationalFanout(
  store: RelationalFanoutStore,
  seedDocumentIds: ReadonlyArray<number>,
  opts: RelationalFanoutOptions = {},
): RelationalNode[] {
  const maxDepth = Math.max(1, opts.maxDepth ?? DEFAULT_MAX_DEPTH);
  const allowed = new Set((opts.edgeTypes ?? []).map((t) => t));
  const restrict = allowed.size > 0;
  const maxSeeds = Math.max(1, opts.maxSeeds ?? TRAVERSAL_MAX_SEEDS);
  const maxExpansionPerNode = Math.max(
    1,
    opts.maxExpansionPerNode ?? TRAVERSAL_MAX_EXPANSION_PER_NODE,
  );
  const maxTotalNodes = Math.max(1, opts.maxTotalNodes ?? TRAVERSAL_MAX_TOTAL_NODES);
  const hubDegreeThreshold = Math.max(1, opts.hubDegreeThreshold ?? TRAVERSAL_HUB_DEGREE_THRESHOLD);
  const isExpired = opts.isExpired;

  if (isExpired?.() === true) return [];

  const seedIds = [...new Set(seedDocumentIds)].slice(0, maxSeeds);
  const seeds = new Set(seedIds);
  const reached = new Map<number, MutableNode>();
  // Set when the total-node cap or the deadline ends the walk early; the
  // depth loop then keeps everything already in `reached`.
  let stop = false;

  let frontier = seedIds;
  for (let depth = 1; depth <= maxDepth && frontier.length > 0 && !stop; depth++) {
    if (isExpired?.() === true) break;
    // One batched edge fetch per depth; grouped per source node so the
    // per-node expansion cap and the hub-degree rule answer a per-node
    // question without a second query.
    const bySource = new Map<number, Array<(typeof edges)[number]>>();
    const edges = store.typedRelationEdgesForDocuments(frontier);
    for (const edge of edges) {
      const mine = bySource.get(edge.sourceDocumentId);
      if (mine) mine.push(edge);
      else bySource.set(edge.sourceDocumentId, [edge]);
    }
    const nextFrontier: number[] = [];
    for (const sourceId of frontier) {
      if (isExpired?.() === true) {
        stop = true;
        break;
      }
      if (reached.size >= maxTotalNodes) {
        stop = true;
        break;
      }
      const declared = bySource.get(sourceId) ?? [];
      // A node's WALKED edges: the ones the traversal could actually
      // follow - restriction-passing with a resolvable target. Degree and
      // expansion answer this list, so a dangling edge neither inflates a
      // hub nor spends a node's expansion budget.
      const walked = declared.filter(
        (edge) =>
          (!restrict || allowed.has(edge.relation)) &&
          edge.targetDocumentId !== null &&
          !seeds.has(edge.targetDocumentId),
      );
      // Hub skipping: the node stays reached (its own provenance stands)
      // but its fan-out is withheld from the frontier.
      if (walked.length > hubDegreeThreshold) continue;
      let followed = 0;
      for (const edge of walked) {
        if (followed >= maxExpansionPerNode) break;
        const targetId = edge.targetDocumentId;
        if (targetId === null) continue;
        followed += 1;
        const existing = reached.get(targetId);
        if (existing === undefined) {
          if (reached.size >= maxTotalNodes) {
            stop = true;
            break;
          }
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
    }
    frontier = nextFrontier;
  }

  const nodes: RelationalNode[] = [];
  for (const [documentId, node] of reached) {
    // Intra-fanout ordering key in (0, 1 + MAX_RICHNESS_BONUS], NOT normalized
    // to (0, 1]. The bonus is capped below one hop tier so nearer always wins.
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
