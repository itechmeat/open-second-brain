/**
 * The post-rank filters that can drop a ranked row: belief status,
 * frontmatter properties, graph degree, visibility scope, agent ownership
 * and the composite session/project scope.
 *
 * Resolving them is separate from applying them, because the pool width
 * has to know up front whether ANY of them can shrink the window.
 */

import { normalizeAgentScope } from "../../graph/agent-scope.ts";
import { normalizeVisibilityScope } from "../../graph/visibility.ts";
import { resolvedTransportReach, type TransportReach } from "../../graph/transport-reach.ts";
import { normalizeSchemaToken } from "../../brain/schema-vocab.ts";
import { normalizeScopeFilter } from "../../scope-key.ts";
import {
  resolvePropertyPushdown,
  type PropertyFilterMap,
  type PropertyPushdown,
} from "../property-pushdown.ts";
import {
  applyAgentScope,
  applyDegreeFilter,
  applyPropertyFilter,
  applyScopeFilter,
  applyStatusFilter,
  applyReachFilter,
  applyVisibilityScope,
  readCachedFrontmatter,
  type FrontmatterCache,
} from "../result-filters.ts";
import type { Store } from "../store.ts";
import type { DegreePredicate } from "../property-filter.ts";
import type { BrainSearchResult, SearchOptions } from "../types.ts";

export interface PoolFilters {
  /**
   * The UNPROMOTED property keys (recall-quality, C4): the half of the
   * caller's map no index storage can answer faithfully, applied post-rank
   * against the live file. The promoted half is compiled to SQL
   * ({@link pushdown}) by the lanes before ranking.
   */
  readonly properties: ReadonlyMap<string, ReadonlyArray<string>> | null;
  /** The promoted half of the property map, pushed into the lanes' SQL. */
  readonly pushdown: PropertyPushdown | null;
  /**
   * The promoted half AS THE CALLER WROTE IT (recall-quality review), or
   * null when nothing was promoted. The lanes' SQL constrains only the
   * candidates that ran through it; traversal-arm rows (searchType "link"
   * - link-graph expansions and relational-only admissions) bypassed the
   * SQL entirely, so the post-rank stage re-judges them with this map
   * under the same live predicate the fallback half runs. Without it, a
   * `type: report` note surfaces under a `type: note` filter by riding a
   * link in from a matching page.
   */
  readonly promoted: PropertyFilterMap | null;
  readonly degreeFilters: ReadonlyArray<DegreePredicate>;
  readonly visibilityScope: ReturnType<typeof normalizeVisibilityScope>;
  /**
   * The reach this search's caller was established at. Absent from the
   * options means nobody established one, which resolves to the narrowest
   * - see {@link SearchOptions.transportReach}.
   */
  readonly reach: TransportReach;
  readonly agentScope: ReturnType<typeof normalizeAgentScope>;
  readonly scopeFilter: ReturnType<typeof normalizeScopeFilter> | null;
  /**
   * True when at least one requested filter can drop a ranked row, which
   * is what makes the candidate pool overfetch up front.
   */
  readonly canDropRows: boolean;
}

export function resolvePoolFilters(opts: SearchOptions): PoolFilters {
  // When a property filter is active, overfetch the ranked
  // candidates so the post-filter result set still has a chance
  // of producing `limit` matching rows. Without this, the
  // top-`limit` ranked hits can lose all their property-matching
  // candidates to the filter and surface zero results even when
  // matches exist deeper in the rank.
  //
  // The split (recall-quality, C4): the promoted half is already answered
  // inside the lanes' SQL, so only the fallback half can still drop a
  // ranked row here - a fully promoted map needs no overfetch, a mixed
  // one keeps it for the keys that remain.
  const split = resolvePropertyPushdown(opts.properties);
  const properties = split.fallback;
  const pushdown = split.pushdown;
  const promoted = split.promoted;
  // Graph-degree cardinality predicates (t_9bee8f0b): a post-rank filter
  // that can drop ranked rows, so it shares the frontmatter-filter
  // overfetch. Absent / empty leaves the pool and results byte-identical.
  const degreeFilters = opts.degreeFilters ?? [];
  // An explicit visibility scope can also drop ranked rows, so it
  // shares the property filter's overfetch. The default (no scope)
  // path does NOT overfetch up front - all-untagged vaults stay
  // byte-identical to prior behaviour - and instead relies on the
  // one-shot backfill in the assembly when tagged pages actually shrink
  // the window.
  const visibilityScope = normalizeVisibilityScope(opts.visibility ?? []);
  const hasVisibilityRequest = (opts.visibility?.length ?? 0) > 0;
  // Deny-by-default reach. NOT folded into `canDropRows`: a reserved page
  // dropped at remote reach shrinks the window exactly the way a tagged
  // page already does under the default scope, and the assembly's
  // one-shot backfill is what widens the pool when it actually happens.
  // Folding it in would make every remote search overfetch up front,
  // including in the vaults that never wrote the token.
  const reach = resolvedTransportReach(opts.transportReach);
  // Agent-ownership scope (Unit 5): null means "no scope requested" -
  // no ownership filtering, so untagged vaults stay byte-identical.
  const agentScope = normalizeAgentScope(opts.agentScope);
  // Composite scope filter (t_37c05a34): session/project axes on top of
  // owner. Null when no axis is requested, so an omitted filter never
  // narrows the pool (byte-identical default).
  const normalizedScope = opts.scope !== undefined ? normalizeScopeFilter(opts.scope) : null;
  const scopeFilter =
    normalizedScope !== null &&
    (normalizedScope.session !== null || normalizedScope.project !== null)
      ? normalizedScope
      : null;
  return {
    properties,
    pushdown,
    promoted,
    degreeFilters,
    visibilityScope,
    reach,
    agentScope,
    scopeFilter,
    canDropRows:
      properties !== null ||
      hasVisibilityRequest ||
      agentScope !== null ||
      scopeFilter !== null ||
      degreeFilters.length > 0,
  };
}

export interface FilterContext {
  readonly vault: string;
  readonly store: Store;
  readonly frontmatterCache: FrontmatterCache;
}

export interface FilteredPool {
  /**
   * Row count after the reach rule and before every CALLER-REQUESTED
   * scope. Since evidence-at-the-boundary C2 this is the retrieval
   * trail's baseline: the gap between it and `visible` is the only
   * evidence that an owner, visibility or session scope removed the
   * answer rather than the vault holding no match.
   *
   * The reserved-token rule is counted OUT of it. That rule is not a
   * scope the caller requested, and publishing how many rows it removed
   * would tell the caller that pages it may not read matched its query -
   * which is the existence oracle the boundary exists to close. Use
   * {@link FilteredPool.prePoolFilters} for anything that must see the
   * whole drop and does not report it.
   */
  readonly preVisibility: number;
  /**
   * Row count before ANY post-rank filter that can shrink the window,
   * the reach rule included.
   *
   * Exists for the assembly's one-shot backfill, which has to widen the
   * rank cap whenever the window shrank for a reason the caller did not
   * ask for - and a reserved page crowding the cap is exactly that. It
   * is deliberately NOT the trail's baseline: the backfill consumes this
   * number to fetch more rows and never reports it, so it discloses
   * nothing, while the trail publishes its baseline verbatim.
   */
  readonly prePoolFilters: number;
  readonly visible: ReadonlyArray<BrainSearchResult>;
}

export function applyPoolFilters(
  ranked: ReadonlyArray<BrainSearchResult>,
  filters: PoolFilters,
  ctx: FilterContext,
): FilteredPool {
  // Optional post-rank property filter (v0.10.17). Reads each
  // result's source frontmatter and drops rows whose scalars do not
  // match the requested key/value pairs, then visibility scoping (v3)
  // drops pages outside the requested visibility scope. Caching by
  // document path bounds the read cost to the result set.
  // Belief lifecycle suite (t_7d5a3589): drop tombstoned (incl.
  // superseded-non-tip) memories before any other post-rank stage.
  // A vault with no tombstoned entries passes through unchanged.
  const statusFiltered = applyStatusFilter(ranked, ctx.vault, ctx.frontmatterCache);
  const propFiltered =
    filters.properties !== null
      ? applyPropertyFilter(statusFiltered, filters.properties, ctx.vault, ctx.frontmatterCache)
      : statusFiltered;
  // Traversal-arm gate (recall-quality review): rows whose candidate source
  // bypassed the lanes' SQL - searchType "link": the link-graph expansions
  // and the relational-only admissions - never met the promoted half's
  // pushdown, so the live property filter must judge them here or a
  // filtered query surfaces pages the filter excludes by riding a link in
  // from a matching one. The SAME predicate the fallback half runs, keyed
  // by the promoted half as the caller wrote it; lane rows keep their SQL
  // verdict untouched. No-op (same array) when nothing was promoted or no
  // traversal row is in the pool.
  const traversalGated =
    filters.promoted !== null && propFiltered.some((r) => r.searchType === "link")
      ? gateTraversalRows(propFiltered, filters.promoted, ctx)
      : propFiltered;
  // Shape gate (recall-quality review): documents.page_type records only
  // scalar-STRING `type` frontmatter, so the pushed clause is conditionally
  // faithful - its NULL arm keeps every row whose shape the column cannot
  // speak for (an array `type` most notably, which the live filter matches
  // element-wise), and THIS stage arbitrates exactly those rows under the
  // live filter's type key, in the caller's own spelling. Rows the SQL
  // legitimately decided (a scalar-string type) keep their as-indexed
  // verdict; nothing is re-read for them beyond the shared frontmatter
  // cache probe that recognises the blind shapes.
  const shapeGated =
    filters.promoted !== null &&
    filters.promoted.has("type") &&
    filters.pushdown?.pageTypes !== undefined
      ? gateBlindShapeRows(traversalGated, filters.promoted.get("type")!, ctx)
      : traversalGated;
  // Graph-degree cardinality predicates (t_9bee8f0b): drop rows whose
  // backlink/outlink counts fail the predicates, backed by the
  // link-graph degree index. No-op when no predicate was requested.
  const degreeFiltered =
    filters.degreeFilters.length > 0
      ? applyDegreeFilter(shapeGated, filters.degreeFilters, ctx.store)
      : shapeGated;
  // Root A, and it runs BEFORE the trail's baseline is taken. The
  // caller's own scopes are counted below, because "did my scope remove
  // my results" is a question the caller may ask about a filter it
  // requested; the reserved-token rule is not one of those, and a count
  // of what it withheld would say "there is one more page here than I am
  // showing you" - the existence oracle the boundary exists to close.
  const reachable = applyReachFilter(
    degreeFiltered,
    filters.reach,
    ctx.vault,
    ctx.frontmatterCache,
    ctx.store,
  );
  const visible = applyVisibilityScope(
    reachable,
    filters.visibilityScope,
    ctx.vault,
    ctx.frontmatterCache,
  );
  // Agent-ownership isolation (Unit 5): only when a scope is requested;
  // a null scope skips the filter entirely (byte-identical default).
  const scoped =
    filters.agentScope !== null
      ? applyAgentScope(visible, filters.agentScope, ctx.vault, ctx.frontmatterCache)
      : visible;
  // Composite session/project scope filter (t_37c05a34): applied only
  // when an axis is requested; a null filter skips it entirely so the
  // default path is byte-identical.
  const compositeScoped =
    filters.scopeFilter !== null
      ? applyScopeFilter(scoped, filters.scopeFilter, ctx.vault, ctx.frontmatterCache)
      : scoped;
  // Two counts, and the split is the whole point: the trail subtracts
  // from the pool AFTER the reach rule, so the number it publishes is
  // exactly what the caller's own arguments removed, while the backfill
  // subtracts from the pool BEFORE it, so a reserved page crowding the
  // rank cap still widens the window rather than emptying it.
  return {
    preVisibility: reachable.length,
    prePoolFilters: degreeFiltered.length,
    visible: compositeScoped,
  };
}

/**
 * Judge the traversal-arm rows (searchType "link") under the promoted
 * property filter with the same live predicate every other row's fallback
 * keys run through, and splice the verdict back in rank order: kept rows
 * stay exactly where the ranker put them, dropped ones leave the pool.
 * Non-link rows pass through untouched - their promoted verdict is the
 * lanes' SQL's to make.
 */
function gateTraversalRows(
  ranked: ReadonlyArray<BrainSearchResult>,
  promoted: PropertyFilterMap,
  ctx: FilterContext,
): ReadonlyArray<BrainSearchResult> {
  const linkRows = ranked.filter((r) => r.searchType === "link");
  if (linkRows.length === 0) return ranked;
  const kept = new Set(
    applyPropertyFilter(linkRows, promoted, ctx.vault, ctx.frontmatterCache).map((r) => r.chunkId),
  );
  return ranked.filter((r) => r.searchType !== "link" || kept.has(r.chunkId));
}

/**
 * The rows whose `type` frontmatter the page_type column cannot speak for
 * - the key absent, or present in a non-scalar shape (an array; the
 * parser keeps YAML scalars as strings, so a string whose token is empty
 * is the remaining blind case) - judged under the live filter's type key
 * and spliced back in rank order. A scalar-string type keeps its SQL
 * verdict: the column stored it, and that as-indexed answer is the C4
 * contract for the shapes the SQL reproduces exactly.
 */
function gateBlindShapeRows(
  ranked: ReadonlyArray<BrainSearchResult>,
  typeValues: ReadonlyArray<string>,
  ctx: FilterContext,
): ReadonlyArray<BrainSearchResult> {
  const blind: BrainSearchResult[] = [];
  for (const r of ranked) {
    const meta = readCachedFrontmatter(ctx.frontmatterCache, ctx.vault, r.path) as Record<
      string,
      unknown
    >;
    if (!Object.prototype.hasOwnProperty.call(meta, "type")) {
      blind.push(r);
      continue;
    }
    const value = meta["type"];
    if (typeof value !== "string" || normalizeSchemaToken(value).length === 0) blind.push(r);
  }
  if (blind.length === 0) return ranked;
  const kept = new Set(
    applyPropertyFilter(
      blind,
      new Map([["type", typeValues]]),
      ctx.vault,
      ctx.frontmatterCache,
    ).map((r) => r.chunkId),
  );
  return ranked.filter((r) => !blind.includes(r) || kept.has(r.chunkId));
}
