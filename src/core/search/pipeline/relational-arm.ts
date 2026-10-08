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
  for (const node of nodes) {
    const rep = reps.get(node.documentId);
    if (rep === undefined) continue;
    const key = rrfKey({ origin: null, path: rep.path, chunkId: rep.chunkId });
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    const gated = gatePath(vault, node.path, titles, reach, agentScope, frontmatterCache, nowMs);
    outcome.rankedChunkIds.push(rep.chunkId);
    outcome.reachByChunk.set(rep.chunkId, {
      via: node.viaLinkTypes,
      hops: node.hops,
      ...gated,
    });
  }
  return outcome;
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
      meta === undefined ||
      !isPathReadableAtReach(vault, meta.path, reach, cache) ||
      // The same owner-scope verdict the row-level filters apply to
      // content rows: an owner-private page another agent owns is as
      // withheld from provenance as an unreadable one. No requested
      // scope means no ownership filtering - the opt-in default.
      (agentScope !== null && !isPathOwnerVisible(vault, meta.path, agentScope, cache));
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
