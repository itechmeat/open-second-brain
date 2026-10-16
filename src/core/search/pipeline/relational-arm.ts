/**
 * Typed-edge relational arm (t_09b7ccea): the fourth RRF arm. Resolves the
 * query's wikilink seeds, fans out over typed edges, and contributes one
 * representative chunk per reached node - with the link types and hop
 * distance it was reached by, for attribution.
 *
 * Deepened traversal (truth-correctable-time-aware): the walk runs under
 * the resolved traversal width budgets, abandons its frontier when the
 * caller's deadline predicate reports the composite recall clock fired,
 * and - when the entity-bridge flag allows and the store provides the
 * reader - walks `chunk_entities` entity bridges beside the typed edges.
 * The per-call options default to the same environment-over-machine-config
 * resolution every search knob follows, resolved against the config file
 * the caller's own resolution read (`options.configPath`, threaded from
 * the resolved search config): the arm answers the caller's config map,
 * never a fresh read of the default path the caller may not have used.
 */

import { DEFAULT_RELATION_TYPES, normalizeRelation } from "../../graph/relation-vocab.ts";
import { normalizeAgentScope } from "../../graph/agent-scope.ts";
import { loadSchemaPack } from "../../brain/schema-pack.ts";
import { rrfKey } from "../../scope-key.ts";
import { resolvedTransportReach, type TransportReach } from "../../graph/transport-reach.ts";
import { EXACT_WIKILINK_RE } from "../../brain/wikilink.ts";
import { SUPERSEDED_BY_KEY } from "../../brain/lifecycle/tombstone.ts";
import { discoverConfig } from "../../config.ts";
import { envOrConfig, parseBool } from "../../validate.ts";
import {
  relationalFanout,
  resolveTraversalBudgets,
  type RelationalFanoutStore,
  type RelationalPathStep,
  type TraversalBudgets,
} from "../relational-fanout.ts";
import { parseRelationalQuery } from "../relational-query.ts";
import {
  isPathOwnerVisible,
  isPathReadableAtReach,
  readCachedFrontmatterEntry,
  type FrontmatterCache,
} from "../result-filters.ts";
import { parseValidityWindow } from "../validity.ts";
import { SearchError } from "../search-error.ts";
import {
  RETRIEVAL_TRUST_EXCLUSION_REASON,
  SEARCH_TRUST_GATE_MODE,
  classifyRetrievalTrust,
  resolveSearchTrustGateMode,
} from "../../brain/trust/retrieval-gate.ts";
import {
  RETRIEVAL_TRUST_REFUSAL_LANE,
  type RetrievalTrustRefusal,
} from "../../brain/trust/retrieval-receipts.ts";
import type { BrainSearchResult } from "../search-result.ts";
import type { Store } from "../store.ts";
import type { ResolvedSearchConfig, SearchOptions } from "../types.ts";

/** Bounded typed-edge fan-out depth for the relational arm (t_09b7ccea). */
const RELATIONAL_MAX_DEPTH = 2;

/** Environment override for walking entity bridges. */
export const ENTITY_BRIDGES_ENV = "OPEN_SECOND_BRAIN_SEARCH_ENTITY_BRIDGES";
/** Machine-config key for walking entity bridges. */
export const ENTITY_BRIDGES_CONFIG = "search_entity_bridges_enabled";

/**
 * Namespace the arm's refusal reasons carry, mirroring how the kernel
 * namespaces an adjuster's exclusion: the origin of the verdict, never
 * prose. Combined with the per-lane split on the refusal record, an arm
 * refusal and a pool exclusion can never blur.
 */
export const RELATIONAL_ARM_REFUSAL_NAMESPACE = "relational_arm";

/**
 * The full structural reason vocabulary of the arm's edge-level
 * eligibility gate: the page gate's three controlled-vocabulary signals
 * reused verbatim ({@link RETRIEVAL_TRUST_EXCLUSION_REASON} - the same
 * controlled-vocabulary frontmatter signals the page gate reads), plus
 * the four tokens only an edge and its window can fail on. Fixed tokens,
 * not prose, so the same vault yields the same record.
 */
export const RELATIONAL_ARM_REFUSAL_REASON = Object.freeze({
  ...RETRIEVAL_TRUST_EXCLUSION_REASON,
  /** A DECLARED validity window value that cannot be parsed. */
  invalidValidityWindow: "invalid_validity_window",
  /** A declared window whose inclusive end is strictly past. */
  closedValidityWindow: "closed_validity_window",
  /** A declared window whose start is still ahead of query time. */
  pendingValidityWindow: "pending_validity_window",
  /** The arriving relation's polarity is a counted exclusion. */
  contradictsPolarity: "contradicts_polarity",
} as const);

/**
 * The relation polarities the edge gate counts as exclusions, from the
 * existing relation-polarity vocabulary: `contradicts` is the
 * relevant-but-not-endorsing edge the pool-level pass only warns about.
 * `superseded_by` is not here - it is the supersession backbone the arm
 * annotates (`supersededBy`), pointing stale-to-fresh - and the positive
 * relations boost.
 */
const REFUSAL_POLARITIES: ReadonlySet<string> = new Set(["contradicts"]);

/**
 * Whether the arm walks entity bridges: on by default (design decision 11),
 * overridable per environment or machine config. A present but invalid
 * value is a misconfiguration and is refused with a `SearchError` naming
 * the key in force - never silently defaulted.
 */
export function resolveEntityBridgesEnabled(input: {
  readonly env?: NodeJS.ProcessEnv;
  readonly config?: Readonly<Record<string, string>>;
}): boolean {
  const env = input.env ?? {};
  const config = input.config ?? {};
  const raw = envOrConfig(env, config, ENTITY_BRIDGES_ENV, ENTITY_BRIDGES_CONFIG);
  if (raw === null) return true;
  // The key actually in force, by the same env-over-config precedence the
  // raw value resolved with - the refusal names the key the operator
  // wrote, never the one that lost the precedence race.
  const inForce = env[ENTITY_BRIDGES_ENV] ? ENTITY_BRIDGES_ENV : ENTITY_BRIDGES_CONFIG;
  try {
    return parseBool(raw, true, inForce);
  } catch (e) {
    throw new SearchError("INVALID_INPUT", `${inForce}: ${(e as Error).message}`);
  }
}

/** Per-call runtime overrides for the arm; every member defaults to resolved config. */
export interface RelationalArmOptions {
  /** Traversal width budgets. Default: {@link resolveTraversalBudgets} over env + machine config. */
  readonly budgets?: TraversalBudgets;
  /**
   * Fired-clock predicate bounding the walk (the composite recall
   * deadline). Default: none - the width caps still bound the walk.
   */
  readonly isExpired?: () => boolean;
  /**
   * Walk entity bridges. Default: {@link resolveEntityBridgesEnabled} over
   * env + machine config, AND the store must provide the bridge reader.
   */
  readonly entityBridges?: boolean;
  /**
   * The caller's transport reach, gating every provenance path node
   * (per-node gating, the `brain_derive_fact` premise-gate precedent). A
   * node whose page is unreadable at this reach is omitted from the path,
   * never named and never counted. Default: the same resolution the
   * row-level filters apply (`resolvedTransportReach`) - an absent reach
   * answers remote, the narrowest, so provenance never names a page the
   * row gate withholds.
   */
  readonly reach?: TransportReach;
  /**
   * The caller's agent-ownership scope, gating provenance path nodes the
   * same way the row-level filters gate content rows: a node whose page
   * another agent owns is omitted from the path, never named. Null /
   * absent means no scope requested - no ownership filtering, the opt-in
   * default every unscoped search ran with before.
   */
  readonly agentScope?: string | null;
  /**
   * The config file the caller's own config resolution read, threaded
   * from the resolved search config. Default: null - the knobs resolve
   * env-only, exactly as a caller that consulted no config file did.
   */
  readonly configPath?: string | null;
}

export interface RelationalReach {
  readonly via: ReadonlyArray<string>;
  readonly hops: number;
  /**
   * The ordered steps that reached this node, gated per node at the
   * caller's reach and owner scope: a step whose page is unreadable there
   * or owned by another agent is omitted - never named, and never
   * counted, so the provenance a row shows reads the same whether the
   * walk crossed unreadable documents or not (the views'
   * identical-to-absent convention: a count would tell the caller that a
   * node it may not see exists).
   */
  readonly path: ReadonlyArray<RelationalPathStep>;
  /**
   * Set when a readable path node is a non-tip superseded predecessor with
   * a CLOSED validity window, read from frontmatter only (`superseded_by`
   * plus `valid_until` already past) - never from the ledger. The bare tip
   * name the frontmatter pointer declares.
   */
  readonly supersededBy?: string;
}

export interface RelationalArmOutcome {
  readonly rankedChunkIds: number[];
  readonly reachByChunk: Map<number, RelationalReach>;
  /**
   * The arm's lane of the retrieval trust receipts' refusal record
   * (session-mining-economy, t_05a0eaa4). Present only when the trust
   * gate's resolved mode is not off - the eligibility gate ran - and
   * lists every walked node whose arrival (its own frontmatter signals,
   * its validity window at query time, the arriving edge's polarity, or
   * the arrived edge's source endpoint) the classification marked
   * ineligible AND whose derivation the caller could read: a node, or an
   * edge source, withheld at the caller's reach and owner scope
   * contributes no record, so the receipts read the same whether the walk
   * crossed unreadable documents or not. This is a DIFFERENT act from the
   * reach gating's identical-to-absent provenance convention above: a
   * refusal is removed from (enforce) or kept in (shadow) the
   * contribution set AND counted here, while an omitted provenance step
   * is never named and never counted.
   */
  readonly refusals?: ReadonlyArray<RetrievalTrustRefusal>;
}

/**
 * Whether a caller at this reach and owner scope could read the page: the
 * exact verdict {@link gatePath} applies to every provenance step, so
 * both disclosure channels - the provenance beside a row and the trust
 * receipts' refusal records - are held to the same line.
 */
function isCallerReadable(
  vault: string,
  path: string,
  reach: TransportReach,
  agentScope: string | null,
  cache: FrontmatterCache,
): boolean {
  return (
    isPathReadableAtReach(vault, path, reach, cache) &&
    (agentScope === null || isPathOwnerVisible(vault, path, agentScope, cache))
  );
}

/**
 * The arm engages ONLY in rrf fusion and when enabled (per-call override
 * ahead of the config default). Off / linear fusion leaves the pool and
 * ranking byte-identical.
 */
export function isRelationalArmActive(config: ResolvedSearchConfig, opts: SearchOptions): boolean {
  return config.fusionMode === "rrf" && (opts.relationalArm ?? config.recall.relationalArmEnabled);
}

export function noRelationalArm(): RelationalArmOutcome {
  return { rankedChunkIds: [], reachByChunk: new Map() };
}

/**
 * The machine config map the arm's own knobs resolve against: the file
 * at the caller's resolved config path, or no file at all when the
 * caller resolved env-only - the same map the search call's own config
 * resolution consulted, never a fresh read of the default path the
 * caller may not have used. A present-but-unreadable caller path fails
 * the same way here as it did there - deliberately not guarded into a
 * silent default.
 */
function machineConfigData(configPath: string | null | undefined): Record<string, string> {
  return configPath ? discoverConfig(configPath).data : {};
}

/**
 * The fanout view of the store. The walk merges bridges whenever the store
 * view carries the reader, so this wrapper is the flag's enforcement point:
 * bridges on AND the store carrying the reader yields a view that exposes
 * it; anything else yields a view with typed edges only, so a flag-off run
 * is byte-identical to a store with no reader at all.
 */
function fanoutStoreFor(store: Store, bridges: boolean): RelationalFanoutStore {
  const reader = (store as Partial<RelationalFanoutStore>).entityBridgesForDocuments;
  if (typeof reader !== "function") return store;
  if (!bridges) {
    return { typedRelationEdgesForDocuments: (ids) => store.typedRelationEdgesForDocuments(ids) };
  }
  return {
    typedRelationEdgesForDocuments: (ids) => store.typedRelationEdgesForDocuments(ids),
    entityBridgesForDocuments: (ids) => reader.call(store, ids),
  };
}

/**
 * A bounded depth-2 typed-edge fan-out from the resolved seeds. A
 * non-relational query (no wikilink seed plus schema-vocabulary edge-type
 * token) contributes nothing - and the knob resolution runs only after
 * that early return, so a non-relational query pays no config-file read
 * and a malformed knob value fails no search the knobs cannot affect.
 * Source identity from the shared key module dedups the lane (federation
 * hardening).
 */
export function runRelationalArm(
  store: Store,
  vault: string,
  query: string,
  opts: RelationalArmOptions = {},
): RelationalArmOutcome {
  const outcome = noRelationalArm();
  const relQuery = parseRelationalQuery(query, relationalEdgeVocabulary(vault));
  if (relQuery === null) return outcome;
  const seedDocIds = resolveSeedDocumentIds(store, relQuery.seeds);
  if (seedDocIds.length === 0) return outcome;
  const config = machineConfigData(opts.configPath);
  const budgets = opts.budgets ?? resolveTraversalBudgets({ env: process.env, config });
  const bridges = opts.entityBridges ?? resolveEntityBridgesEnabled({ env: process.env, config });
  // The edge-level eligibility gate (session-mining-economy, t_05a0eaa4)
  // runs under the same resolved trust-gate mode the page gate answers
  // to - the same env and the caller's own config map, so the two gates
  // can never disagree about the posture. Off: no classification, no
  // refusal field, the outcome shape byte-identical.
  const trustGateMode = resolveSearchTrustGateMode({ env: process.env, config });
  const nodes = relationalFanout(fanoutStoreFor(store, bridges), seedDocIds, {
    maxDepth: RELATIONAL_MAX_DEPTH,
    edgeTypes: relQuery.edgeTypes,
    ...budgets,
    ...(opts.isExpired !== undefined ? { isExpired: opts.isExpired } : {}),
  });
  const reps = store.representativeChunks(nodes.map((n) => n.documentId));
  // Per-node gating for the ordered path provenance: one titles read and
  // one frontmatter cache per arm run, shared by every node's gate. The
  // caller's owner scope rides beside the transport reach, so a
  // reach-readable node another agent owns is withheld the same way. The
  // absent reach resolves exactly as the row-level filters resolve it,
  // so a withheld page is never named in provenance the rows do not show.
  const reach = resolvedTransportReach(opts.reach);
  const agentScope = normalizeAgentScope(opts.agentScope ?? undefined);
  const frontmatterCache: FrontmatterCache = new Map();
  const titles = store.documentTitles();
  const nowMs = Date.now();
  const seenKeys = new Set<string>();
  const gateActive = trustGateMode !== SEARCH_TRUST_GATE_MODE.off;
  const refusals: RetrievalTrustRefusal[] = [];
  for (const node of nodes) {
    const rep = reps.get(node.documentId);
    if (rep === undefined) continue;
    const key = rrfKey({ origin: null, path: rep.path, chunkId: rep.chunkId });
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    if (gateActive) {
      // The walked edge that carried the walk in is the path's last step;
      // its source endpoint is another walked node except at hop 1, where
      // the source is a seed the caller named itself.
      const lastStep = node.path.at(-1);
      const sourceStep = node.path.length >= 2 ? node.path.at(-2) : undefined;
      const sourceMeta = sourceStep === undefined ? undefined : titles.get(sourceStep.documentId);
      const sourcePath = sourceMeta?.path ?? null;
      const eligibility = classifyArrivalEligibility({
        vault,
        nodePath: rep.path,
        sourcePath,
        arrivingRelation: lastStep?.relation ?? null,
        cache: frontmatterCache,
        nowMs,
      });
      if (eligibility.node.length + eligibility.source.length > 0) {
        // A refusal is RECORDED only for what the caller could read at
        // its reach and owner scope - the identical-to-absent convention
        // the provenance gate below holds: a page withheld there
        // contributes nothing to the receipts, so the records a caller
        // sees read the same whether the walk crossed unreadable
        // documents or not. The enforcement verdict below stays the FULL
        // classification: the exclusion (enforce) or the kept
        // contribution (shadow) does not depend on what was recordable.
        const recordable = isCallerReadable(vault, rep.path, reach, agentScope, frontmatterCache)
          ? [
              ...eligibility.node,
              ...(sourcePath === null ||
              isCallerReadable(vault, sourcePath, reach, agentScope, frontmatterCache)
                ? eligibility.source
                : []),
            ]
          : [];
        if (recordable.length > 0) {
          refusals.push(
            Object.freeze({
              document_id: rep.documentId,
              chunk_id: rep.chunkId,
              path: rep.path,
              reasons: Object.freeze(recordable.toSorted()),
              lane: RETRIEVAL_TRUST_REFUSAL_LANE.arm,
            }),
          );
        }
        // Enforce removes the ineligible edge's node from the
        // contribution set; shadow counts it and contributes as usual.
        if (trustGateMode === SEARCH_TRUST_GATE_MODE.enforce) continue;
      }
    }
    const gated = gatePath(vault, node.path, titles, reach, agentScope, frontmatterCache, nowMs);
    outcome.rankedChunkIds.push(rep.chunkId);
    outcome.reachByChunk.set(rep.chunkId, {
      via: node.viaLinkTypes,
      hops: node.hops,
      ...gated,
    });
  }
  return { ...outcome, ...(gateActive ? { refusals: Object.freeze(refusals) } : {}) };
}

/**
 * The recognised edge-type vocabulary for the relational parser: the schema
 * pack's declared link types unioned with the default relation vocabulary,
 * all normalized. An unreadable pack falls back to the defaults. This is the
 * only place edge-type vocabulary enters the search path - never a
 * natural-language word list.
 */
function relationalEdgeVocabulary(vault: string): string[] {
  const vocab = new Set<string>(DEFAULT_RELATION_TYPES.map((t) => normalizeRelation(t)));
  try {
    for (const t of loadSchemaPack(vault).link_types) vocab.add(normalizeRelation(t));
  } catch {
    // An unreadable schema pack falls back to the default relation vocabulary.
  }
  return [...vocab];
}

/**
 * Resolve relational-query wikilink seeds to document ids. Tries the exact
 * `<seed>.md` path, then the bare seed, then an UNAMBIGUOUS basename match
 * anywhere in the tree (an ambiguous basename stays unresolved -
 * deterministic inertness beats guessing the wrong page). Deduped.
 */
function resolveSeedDocumentIds(store: Store, seeds: ReadonlyArray<string>): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  let titles: Map<number, { readonly path: string; readonly title: string | null }> | null = null;
  for (const seed of seeds) {
    let docId = store.getDocumentIdByPath(`${seed}.md`) ?? store.getDocumentIdByPath(seed);
    if (docId === null) {
      titles ??= store.documentTitles();
      const matches: number[] = [];
      for (const [id, meta] of titles) {
        const base = meta.path.split("/").pop() ?? meta.path;
        if (base === `${seed}.md`) matches.push(id);
      }
      if (matches.length === 1) docId = matches[0]!;
    }
    if (docId !== null && !seen.has(docId)) {
      seen.add(docId);
      out.push(docId);
    }
  }
  return out;
}

/**
 * The bare tip a frontmatter `superseded_by` pointer names, when the page
 * is a non-tip superseded predecessor whose validity window has CLOSED.
 * Closedness follows the shared frontmatter grammar's INCLUSIVE end
 * (`parseValidityWindow` in `src/core/search/validity.ts` snaps a bare
 * `valid_until` date to its whole final day, so the boundary instant
 * itself is still inside the window): closed once now is strictly past
 * the end. Frontmatter only - never the ledger. A missing pointer, an
 * unparseable window, an open side, or a window still open answers null.
 */
function closedSupersessionTip(
  vault: string,
  path: string,
  cache: FrontmatterCache,
  nowMs: number,
): string | null {
  const entry = readCachedFrontmatterEntry(cache, vault, path);
  if (entry.unreadable) return null;
  const raw = entry.meta[SUPERSEDED_BY_KEY];
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const window = parseValidityWindow(entry.meta);
  if (window === null || window.invalid || window.validUntilMs === null) return null;
  if (window.validUntilMs >= nowMs) return null;
  const wikilink = EXACT_WIKILINK_RE.exec(raw.trim());
  return (wikilink !== null ? wikilink[1]! : raw).trim();
}

/**
 * The eligibility verdict for one walked node's arrival, split by which
 * page each reason was derived from. Four questions, all frontmatter-
 * structural, none prose:
 *
 *   - the node's page and - for a node reached from another walked node -
 *     the arrived edge's source page carry one of the page gate's three
 *     controlled-vocabulary signals (a seed is the caller's own entry
 *     point and is judged only as far as the walk reads it, never
 *     refused for its own markers);
 *   - the node's declared validity window covers query time
 *     (`parseValidityWindow`, the `closedSupersessionTip` inclusive-end
 *     grammar; a DECLARED value that cannot be parsed is a refusal of
 *     its own, never a silent pass);
 *   - the arriving relation's polarity is not a counted exclusion
 *     (the existing relation-polarity vocabulary).
 *
 * The split exists for the receipts' disclosure line: the `node` reasons
 * describe the node's own page and arriving edge, the `source` reasons
 * describe ANOTHER page, and a record may carry a page's facts only when
 * that page is readable at the caller's reach and scope. The enforcement
 * verdict is the union and never differs between modes.
 *
 * An unreadable page answers no signals, the same tolerance the page
 * gate's shared frontmatter reader gives it.
 */
function classifyArrivalEligibility(input: {
  readonly vault: string;
  /** The arrived-at node's page path. */
  readonly nodePath: string;
  /** The arrived edge's source page path, when the walk records it. */
  readonly sourcePath: string | null;
  /** The relation that carried the walk into the node, when known. */
  readonly arrivingRelation: string | null;
  readonly cache: FrontmatterCache;
  readonly nowMs: number;
}): { readonly node: string[]; readonly source: string[] } {
  const node: string[] = [];
  const source: string[] = [];
  const pageGateReasons = (path: string, into: string[]): void => {
    const entry = readCachedFrontmatterEntry(input.cache, input.vault, path);
    if (entry.unreadable) return;
    for (const reason of classifyRetrievalTrust(entry.meta).reasons) {
      into.push(`${RELATIONAL_ARM_REFUSAL_NAMESPACE}:${reason}`);
    }
  };
  pageGateReasons(input.nodePath, node);
  if (input.sourcePath !== null) pageGateReasons(input.sourcePath, source);

  const entry = readCachedFrontmatterEntry(input.cache, input.vault, input.nodePath);
  if (!entry.unreadable) {
    // Null window: neither side declared - an open window, which covers
    // query time trivially.
    const window = parseValidityWindow(entry.meta);
    if (window !== null) {
      if (window.invalid) {
        node.push(
          `${RELATIONAL_ARM_REFUSAL_NAMESPACE}:${RELATIONAL_ARM_REFUSAL_REASON.invalidValidityWindow}`,
        );
      } else if (window.validFromMs !== null && window.validFromMs > input.nowMs) {
        node.push(
          `${RELATIONAL_ARM_REFUSAL_NAMESPACE}:${RELATIONAL_ARM_REFUSAL_REASON.pendingValidityWindow}`,
        );
      } else if (window.validUntilMs !== null && window.validUntilMs < input.nowMs) {
        node.push(
          `${RELATIONAL_ARM_REFUSAL_NAMESPACE}:${RELATIONAL_ARM_REFUSAL_REASON.closedValidityWindow}`,
        );
      }
    }
  }

  if (
    input.arrivingRelation !== null &&
    REFUSAL_POLARITIES.has(normalizeRelation(input.arrivingRelation))
  ) {
    node.push(
      `${RELATIONAL_ARM_REFUSAL_NAMESPACE}:${RELATIONAL_ARM_REFUSAL_REASON.contradictsPolarity}`,
    );
  }
  return { node, source };
}

/**
 * Gate one node's walked path at the caller's reach and owner scope:
 * unreadable steps and steps another agent owns (under a requested scope)
 * are omitted alike, so a hidden node's document id is never named, never
 * counted, and never contributes the supersession annotation; the first
 * readable, in-scope step carrying a closed supersession names the
 * reach's `supersededBy` tip. Nothing reports how many steps were
 * dropped - the provenance answer must read the same whether the walk
 * crossed unreadable documents or not (the views'
 * identical-to-absent convention).
 */
function gatePath(
  vault: string,
  steps: ReadonlyArray<RelationalPathStep>,
  titles: ReadonlyMap<number, { readonly path: string }>,
  reach: TransportReach,
  agentScope: string | null,
  cache: FrontmatterCache,
  nowMs: number,
): {
  readonly path: ReadonlyArray<RelationalPathStep>;
  readonly supersededBy?: string;
} {
  const gated: RelationalPathStep[] = [];
  let supersededBy: string | undefined;
  for (const step of steps) {
    const meta = titles.get(step.documentId);
    const unreadable =
      meta === undefined || !isCallerReadable(vault, meta.path, reach, agentScope, cache);
    if (unreadable) continue;
    gated.push(step);
    if (supersededBy === undefined) {
      const tip = closedSupersessionTip(vault, meta.path, cache, nowMs);
      if (tip !== null) supersededBy = tip;
    }
  }
  return {
    path: Object.freeze(gated),
    ...(supersededBy !== undefined ? { supersededBy } : {}),
  };
}

/**
 * Relational rerank pin (t_d9f863e9): the protect rule applied at the
 * cross-encoder hand-off. Rerank may PROMOTE relational-origin candidates,
 * never SINK them below their pre-rerank heuristic order - tightened
 * (truth-correctable-time-aware) by the direct-hit ceiling: a
 * relational-origin row may also never cross ABOVE an organic direct hit
 * (a row the keyword lane scored), because the traversal widens the pool
 * and never outranks what the lanes matched.
 *
 * This is deliberately NOT a second floor beside the cross-encoder's
 * `minScore` (the premise warned against a parallel mechanism): `minScore`
 * keeps applying unchanged, and this rule only constrains ORDER after the
 * rerank stage has spoken, which makes the pin strictly weaker than
 * rerank-off - a relational candidate may rise wherever the rerank genuinely
 * scores it above peers, and never falls below the line the heuristic ranker
 * gave it unless the ceiling demands it (the ceiling wins: admission below
 * the organic tail is the structural guarantee the pin protects).
 *
 * Mechanism: every candidate in `preRerank` carrying `relationalOrigin`
 * (stamped by the ranker from the arm's contribution set) holds the
 * position it occupied there, and is processed in PRE-rerank order - the
 * floors are ordered, so honouring an earlier floor can never push a later
 * candidate past its own. Each pass removes the candidate and inserts it
 * at its target: the pre-rerank index when it sank, else just below the
 * deepest organic direct hit when it crossed the ceiling line (later
 * ceiling moves land after the earlier ones and after every already-placed
 * peer, so the relational block's pre-rerank order survives). A candidate
 * already at or above its floor and below the ceiling line is left
 * untouched and gains no receipt; a moved candidate gains
 * `relational_pin: floored at pre-rerank position N` (sunk) or
 * `relational_pin: held below the organic direct hits` (ceiling) so the
 * explain trail shows which rows the pin held. Deterministic given the two
 * orders.
 *
 * The pin is active only where the arm contributed something, so pools
 * without relational-origin rows return the rerank order unchanged.
 */
export function applyRelationalRerankPin(
  preRerank: ReadonlyArray<BrainSearchResult>,
  postRerank: ReadonlyArray<BrainSearchResult>,
): ReadonlyArray<BrainSearchResult> {
  // Floor per relational-origin chunk id: its pre-rerank index. First
  // occurrence wins; the arm's contribution set never repeats a chunk.
  const floors = new Map<number, number>();
  for (let i = 0; i < preRerank.length; i++) {
    const r = preRerank[i]!;
    if (r.relationalOrigin === true && !floors.has(r.chunkId)) floors.set(r.chunkId, i);
  }
  if (floors.size === 0) return postRerank;

  // Walk the protected candidates in PRE-rerank order (floors are strictly
  // increasing along that walk): lift each sunk one to its floor, and hold
  // each one below the deepest organic direct hit.
  const working: BrainSearchResult[] = [...postRerank];
  const floored = new Set<number>();
  const ceilinged = new Set<number>();
  // Relational rows already placed, pre-rerank order - a ceiling move must
  // never land above one of them.
  const placedPeers: number[] = [];
  for (const [chunkId, floor] of floors) {
    const at = working.findIndex((r) => r.chunkId === chunkId);
    if (at === -1) {
      placedPeers.push(chunkId);
      continue;
    }
    let target = at;
    if (target > floor) target = floor;
    // The ceiling line: one past the deepest organic direct hit (a row the
    // keyword lane scored that the arm did not originate). A pool with no
    // direct hits has no line and the ceiling never fires.
    let cut = 0;
    for (let i = 0; i < working.length; i++) {
      const r = working[i]!;
      if (r.keywordScore > 0 && r.relationalOrigin !== true) cut = i + 1;
    }
    // Which rule moved the row is decided by which fired, never by where
    // the row landed - a floor lift can legitimately land on the cut index.
    let movedByCeiling = false;
    if (target < cut) {
      movedByCeiling = true;
      target = cut;
      for (const peerId of placedPeers) {
        const pi = working.findIndex((r) => r.chunkId === peerId);
        if (pi !== -1 && pi + 1 > target) target = pi + 1;
      }
    }
    if (target !== at) {
      const [row] = working.splice(at, 1);
      working.splice(target, 0, row!);
      (movedByCeiling ? ceilinged : floored).add(chunkId);
    }
    placedPeers.push(chunkId);
  }
  if (floored.size === 0 && ceilinged.size === 0) return postRerank;
  return working.map((r) => {
    if (floored.has(r.chunkId)) {
      return Object.freeze({
        ...r,
        reasons: Object.freeze([
          ...r.reasons,
          `relational_pin: floored at pre-rerank position ${floors.get(r.chunkId)}`,
        ]),
      });
    }
    if (ceilinged.has(r.chunkId)) {
      return Object.freeze({
        ...r,
        reasons: Object.freeze([
          ...r.reasons,
          "relational_pin: held below the organic direct hits",
        ]),
      });
    }
    return r;
  });
}
