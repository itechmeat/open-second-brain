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
import { normalizeScopeFilter } from "../../scope-key.ts";
import {
  applyAgentScope,
  applyDegreeFilter,
  applyPropertyFilter,
  applyScopeFilter,
  applyStatusFilter,
  applyVisibilityScope,
  type FrontmatterCache,
} from "../result-filters.ts";
import type { Store } from "../store.ts";
import type { DegreePredicate } from "../property-filter.ts";
import type { BrainSearchResult, SearchOptions } from "../types.ts";

export interface PoolFilters {
  readonly properties: ReadonlyMap<string, ReadonlyArray<string>> | null;
  readonly degreeFilters: ReadonlyArray<DegreePredicate>;
  readonly visibilityScope: ReturnType<typeof normalizeVisibilityScope>;
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
  const properties =
    opts.properties !== undefined && opts.properties.size > 0 ? opts.properties : null;
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
    degreeFilters,
    visibilityScope,
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
   * Row count before visibility scoping, for the backfill decision - and,
   * since evidence-at-the-boundary C2, for the retrieval trail: the gap
   * between this and `visible` is the only evidence that an owner,
   * visibility or session scope removed the answer rather than the vault
   * holding no match.
   */
  readonly preVisibility: number;
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
  // Graph-degree cardinality predicates (t_9bee8f0b): drop rows whose
  // backlink/outlink counts fail the predicates, backed by the
  // link-graph degree index. No-op when no predicate was requested.
  const degreeFiltered =
    filters.degreeFilters.length > 0
      ? applyDegreeFilter(propFiltered, filters.degreeFilters, ctx.store)
      : propFiltered;
  const visible = applyVisibilityScope(
    degreeFiltered,
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
  return { preVisibility: degreeFiltered.length, visible: compositeScoped };
}
