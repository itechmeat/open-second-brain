/**
 * Thread topics - pure facet detection and the adaptive topic budget
 * (recall-quality wave, Lane B / t_2c2a883c).
 *
 * Facets are derived from the thread itself, never from a word list:
 * distinct mined entity keys (`session_entity_mention` ledger rows) and
 * depth-1 summary clusters (the summary nodes whose source lists
 * partition a segment's turns). The topic budget is the corpus-shaped
 * clamp the wave design pins: budget = clamp(distinct facets, floor 12,
 * cap 16). "Adaptive" means the thread's own facet count decides where
 * between floor and cap the fan-out lands; the realized count is
 * reported honestly - a 3-facet thread floors at 12 and says 3 were
 * realized. The exported constants leave room for operator config to
 * layer later, exactly like `DEFAULT_GROUP_SIZE`.
 *
 * Pure and deterministic: no I/O, no clock, no randomness; the same
 * input yields the same facets in the same order across calls. Facet
 * order follows each facet's chronologically first establishing turn
 * (input turn order), so a budget cut spreads across the thread instead
 * of clustering at its head.
 */

/** Lower bound of the adaptive topic budget. */
export const TOPIC_BUDGET_FLOOR = 12;
/** Upper bound of the adaptive topic budget. */
export const TOPIC_BUDGET_CAP = 16;

/** Where one detected thread facet came from. */
export type ThreadFacetOrigin = "mined" | "cluster";

/**
 * One facet of a conversation thread: a distinct sub-topic the coverage
 * pass fans out over. A facet carries its in-scope establishing turns
 * and either a text needle (`mined` facets match turn text through the
 * same keyword machinery as grep) or cluster membership (`cluster`
 * facets reach their turns through the summary node's source list).
 */
export interface ThreadFacet {
  /** Stable facet id: `cluster:<record id>` or `mined:<family>:<key>`. */
  readonly key: string;
  readonly origin: ThreadFacetOrigin;
  /** Text needle for the keyword pass; `null` for membership facets. */
  readonly needle: string | null;
  /** In-scope establishing turns, in the input turn order. */
  readonly turnIds: ReadonlyArray<string>;
}

/** One mined-mention row scoped to the thread: the ledger's payload spine. */
export interface ThreadFacetMention {
  readonly family: string;
  readonly key: string;
  readonly turnId: string;
}

/** One depth-1 summary cluster scoped to the thread. */
export interface ThreadFacetCluster {
  readonly id: string;
  readonly turnIds: ReadonlyArray<string>;
}

export interface ThreadFacetInput {
  /** The thread's turn ids, in chronological order (the ordering axis). */
  readonly turns: ReadonlyArray<string>;
  readonly mentions: ReadonlyArray<ThreadFacetMention>;
  readonly clusters: ReadonlyArray<ThreadFacetCluster>;
}

/**
 * The clamped topic budget for a thread holding `distinctFacets`
 * distinct facets, plus the honest realized count: the fan-out can only
 * ever span the facets that exist.
 */
export function resolveTopicBudget(distinctFacets: number): {
  budget: number;
  realized: number;
} {
  const budget = clampTopicBudget(distinctFacets);
  return { budget, realized: Math.min(distinctFacets, budget) };
}

/** clamp(distinctFacets, TOPIC_BUDGET_FLOOR, TOPIC_BUDGET_CAP). */
export function clampTopicBudget(distinctFacets: number): number {
  return Math.min(Math.max(distinctFacets, TOPIC_BUDGET_FLOOR), TOPIC_BUDGET_CAP);
}

/**
 * Detect a thread's coverage facets from its own records. Mined mentions
 * group into family-scoped facets (the ledger's keys are case-sensitive,
 * so `SessionStore` and `sessionstore` stay distinct); clusters become
 * membership facets. A facet whose establishing turns all fall outside
 * the thread cannot contribute coverage and is not detected - nothing
 * selectable is dropped, and the ledger rows remain for every other
 * reader.
 */
export function detectThreadFacets(input: ThreadFacetInput): ReadonlyArray<ThreadFacet> {
  const order = new Map<string, number>();
  input.turns.forEach((turnId, index) => {
    if (!order.has(turnId)) order.set(turnId, index);
  });
  const facets: ThreadFacet[] = [];
  interface MinedGroup {
    readonly family: string;
    readonly key: string;
    readonly turnIds: string[];
  }
  const mined = new Map<string, MinedGroup>();
  for (const mention of input.mentions) {
    if (!order.has(mention.turnId)) continue;
    const facetKey = `mined:${mention.family}:${mention.key}`;
    const group = mined.get(facetKey);
    if (group === undefined) {
      mined.set(facetKey, { family: mention.family, key: mention.key, turnIds: [mention.turnId] });
    } else if (!group.turnIds.includes(mention.turnId)) {
      group.turnIds.push(mention.turnId);
    }
  }
  for (const [facetKey, group] of mined) {
    facets.push({
      key: facetKey,
      origin: "mined",
      needle: group.key,
      turnIds: group.turnIds,
    });
  }
  for (const cluster of input.clusters) {
    const turnIds: string[] = [];
    for (const turnId of cluster.turnIds) {
      if (order.has(turnId) && !turnIds.includes(turnId)) turnIds.push(turnId);
    }
    if (turnIds.length === 0) continue;
    facets.push({ key: `cluster:${cluster.id}`, origin: "cluster", needle: null, turnIds });
  }
  return facets.toSorted(
    (left, right) =>
      firstTurnIndex(left, order) - firstTurnIndex(right, order) ||
      compareCodeUnits(left.key, right.key),
  );
}

/**
 * Code-unit string order: the same order on every host, where
 * `localeCompare` varies with the host locale and would make the facet
 * tie-break - and with it what survives the topic budget - depend on
 * where the process runs.
 */
function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function firstTurnIndex(facet: ThreadFacet, order: ReadonlyMap<string, number>): number {
  let best = Number.MAX_SAFE_INTEGER;
  for (const turnId of facet.turnIds) {
    const index = order.get(turnId);
    if (index !== undefined && index < best) best = index;
  }
  return best;
}
