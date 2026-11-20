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
  type FrontmatterCache,
} from "../result-filters.ts";
import type { Store } from "../store.ts";
import { documentSourceFor, type DocumentSource } from "../brain-store/constants.ts";
import { applyStoreEntityFilter } from "../brain-store/entity-filter.ts";
import { documentSources } from "../store/brain-records.ts";
import type { DegreePredicate } from "../property-filter.ts";
import type { BrainSearchResult, SearchOptions } from "../types.ts";
import { parseLinePointer } from "../line-numbering.ts";

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
  /** The document source the caller limited the search to, or null for both. */
  readonly source: DocumentSource | null;
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
  const source = opts.source !== undefined ? documentSourceFor(opts.source) : null;
  return {
    properties,
    pushdown,
    promoted,
    degreeFilters,
    visibilityScope,
    reach,
    agentScope,
    scopeFilter,
    source,
    canDropRows:
      source !== null ||
      properties !== null ||
      hasVisibilityRequest ||
      agentScope !== null ||
      scopeFilter !== null ||
      degreeFilters.length > 0,
  };
}

export interface FilterContext {
  readonly vault: string | null;
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
  // Source (design D5) first: it reads only the index, and a row it drops
  // costs no frontmatter read in the stages after it.
  const sourced = filters.source !== null ? applySourceFilter(ranked, filters.source, ctx) : ranked;
  // A store record is no page with frontmatter: whether the index may
  // show it is the ingest's own rule over the store as it is now, asked
  // here, fail-closed (`brain-store/entity-filter.ts`).
  const pageStatusFiltered = applyStatusFilter(sourced, ctx.vault, ctx.frontmatterCache);
  const statusFiltered = applyStoreEntityFilter(pageStatusFiltered, ctx.store);
  // Store records the rule withheld (stale rows of an index that has not
  // caught up yet) are counted for the backfill below, never for the
  // trail: like the reserved-token rule, the count would tell the caller
  // the index holds records it may not see.
  const entityWithheld = pageStatusFiltered.length - statusFiltered.length;
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
  // Promoted-NULL arbitration (recall-quality): the pushed type and pinned
  // clauses each carry an `... OR column IS NULL` arm for the rows the
  // columns cannot speak for - a non-scalar `type` shape, and every row an
  // in-place upgrade carried over without re-examining. The SQL arm that
  // admitted such a row proves nothing about the filter, so THIS stage
  // judges each NULL-column row under the live filter, PER ROW regardless
  // of the query's shape, and lets a non-NULL column keep its as-indexed
  // SQL verdict. The old shape gate arbitrated by the live frontmatter's
  // shape instead, so a stale-NULL row whose file had meanwhile become a
  // speakable scalar kept the SQL verdict it never received and surfaced
  // under a filter its own frontmatter fails.
  const arbitrated =
    filters.promoted !== null &&
    (filters.pushdown?.pageTypes !== undefined || filters.pushdown?.pinned === true)
      ? gateUnspokenPromotedRows(traversalGated, filters, ctx)
      : traversalGated;
  // Graph-degree cardinality predicates (t_9bee8f0b): drop rows whose
  // backlink/outlink counts fail the predicates, backed by the
  // link-graph degree index. No-op when no predicate was requested.
  const degreeFiltered =
    filters.degreeFilters.length > 0
      ? applyDegreeFilter(arbitrated, filters.degreeFilters, ctx.store)
      : arbitrated;
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
    prePoolFilters: degreeFiltered.length + entityWithheld,
    visible: stripWithheldDuplicates(compositeScoped, filters, ctx),
  };
}

/** A bare index reference: a page path and the document id it is stored under. */
export interface IndexRef {
  readonly path: string;
  readonly documentId: number;
}

/**
 * The pool filters over bare index references, for every surface that
 * names indexed pages without going through the ranked pool: the evidence
 * pack's recall union, the read planner, any later one. Each ref becomes a
 * synthetic row and runs through {@link applyPoolFilters} itself, so such
 * a surface and the main result list cannot disagree about what the
 * caller may see. The rows are marked as traversal rows (`searchType`
 * "link") because no lane's SQL constrained them, which makes the promoted
 * property filter judge them live. Order is kept; a ref the filters drop
 * is gone.
 */
export function admitIndexRefs<T extends IndexRef>(
  refs: ReadonlyArray<T>,
  filters: PoolFilters,
  ctx: FilterContext,
): ReadonlyArray<T> {
  if (refs.length === 0) return refs;
  // The synthetic chunk id is the ref's position, so a surface without a
  // chunk (the planner names documents) maps back exactly.
  const rows: BrainSearchResult[] = refs.map((ref, i) => ({
    documentId: ref.documentId,
    chunkId: i + 1,
    path: ref.path,
    title: null,
    content: "",
    startLine: 0,
    endLine: 0,
    score: 0,
    keywordScore: 0,
    semanticScore: 0,
    linkBoost: 0,
    recencyBoost: 0,
    searchType: "link",
    reasons: Object.freeze([]),
  }));
  const kept = new Set(applyPoolFilters(rows, filters, ctx).visible.map((r) => r.chunkId));
  return refs.filter((_, i) => kept.has(i + 1));
}

/** The pages an answer names, by path and by bare document id. */
interface NamedPages {
  readonly paths: Set<string>;
  readonly ids: Set<number>;
}

/**
 * Every page named anywhere below `value`: a string under a `path` key (a
 * row, a card, a duplicate location, an evidence record), the document ids
 * of a numeric `path` (a relational trail entry), and the page of each
 * `duplicatePointers` pointer (a card's folded copies).
 */
function namedPages(value: unknown, out: NamedPages, depth = 0): void {
  if (depth > 32 || typeof value !== "object" || value === null) return;
  if (Array.isArray(value)) {
    for (const item of value) namedPages(item, out, depth + 1);
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (key === "path" && typeof item === "string") out.paths.add(item);
    else if (key === "path" && Array.isArray(item) && item.every((v) => typeof v === "number")) {
      for (const id of item as number[]) out.ids.add(id);
    } else if (key === "duplicatePointers" && Array.isArray(item)) {
      for (const pointer of item) {
        const parsed = typeof pointer === "string" ? parseLinePointer(pointer) : null;
        // A pointer that does not parse names a page nobody can check.
        out.paths.add(parsed === null ? "" : parsed.path);
      }
    } else namedPages(item, out, depth + 1);
  }
}

/**
 * Whether a precomputed answer (a query-cache row) may be served to this
 * caller: every page it names, in any shape (results, cards and their
 * duplicate pointers, duplicate locations, evidence pack records, the
 * relational trail's document ids), is a page the caller's pool filters
 * admit now. The cache key already partitions by the caller's reach and
 * scopes, so no row reaches a narrower caller than the one that cached
 * it; this covers the page side, a frontmatter edit (a visibility tag, an
 * owner, a project) the index has not ingested yet, which the corpus
 * generation does not see. A named page the index no longer holds fails
 * closed, so the answer is computed again.
 */
export function cachedAnswerAdmitted(
  outcome: unknown,
  filters: PoolFilters,
  ctx: FilterContext,
): boolean {
  const named: NamedPages = { paths: new Set(), ids: new Set() };
  namedPages(outcome, named);
  const refs = new Map<number, IndexRef>();
  for (const path of named.paths) {
    const documentId = path === "" ? null : ctx.store.getDocumentIdByPath(path);
    if (documentId === null) return false;
    refs.set(documentId, { path, documentId });
  }
  if ([...named.ids].some((id) => !refs.has(id))) {
    const titles = ctx.store.documentTitles();
    for (const id of named.ids) {
      if (refs.has(id)) continue;
      const meta = titles.get(id);
      if (meta === undefined) return false;
      refs.set(id, { path: meta.path, documentId: id });
    }
  }
  const all = [...refs.values()];
  return admitIndexRefs(all, filters, ctx).length === all.length;
}

/**
 * The visible rows with every folded duplicate location the filters
 * withhold taken out: the exact-duplicate merge runs before the filters,
 * so a copy whose own frontmatter now withholds it (a tag, an owner or a
 * project added since the copies were indexed alike) would otherwise ride
 * along on its twin as a path, title and line span. The row itself stays.
 */
function stripWithheldDuplicates(
  rows: ReadonlyArray<BrainSearchResult>,
  filters: PoolFilters,
  ctx: FilterContext,
): ReadonlyArray<BrainSearchResult> {
  if (!rows.some((r) => (r.duplicates?.length ?? 0) > 0)) return rows;
  return rows.map((row) => {
    const duplicates = row.duplicates;
    if (duplicates === undefined || duplicates.length === 0) return row;
    const kept = admitIndexRefs(duplicates, filters, ctx);
    if (kept.length === duplicates.length) return row;
    const { duplicates: _withheld, ...rest } = row;
    return (
      kept.length > 0 ? { ...rest, duplicates: Object.freeze([...kept]) } : rest
    ) as BrainSearchResult;
  });
}

/**
 * Keep the rows whose document has the requested source. A row whose
 * document the index no longer holds is dropped: nothing says which side
 * it belongs to.
 */
function applySourceFilter(
  ranked: ReadonlyArray<BrainSearchResult>,
  source: DocumentSource,
  ctx: FilterContext,
): ReadonlyArray<BrainSearchResult> {
  const sources = documentSources(
    ctx.store.brainRecordsConnection(),
    ranked.map((r) => r.documentId),
  );
  return ranked.filter((r) => sources.get(r.documentId) === source);
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
 * The rows a promoted column cannot speak for - stored `page_type` NULL
 * (the key absent, or present in a non-scalar shape, at index time) or
 * stored `pinned` NULL (a row an in-place upgrade carried over) - judged
 * under the live filter for exactly the keys that are NULL on them, and
 * spliced back in rank order. A non-NULL column keeps its SQL verdict: the
 * column stored it, and that as-indexed answer is the C4 contract for the
 * shapes the SQL reproduces exactly. A document row missing from the index
 * entirely is judged live too - there is nothing stored to trust.
 */
function gateUnspokenPromotedRows(
  ranked: ReadonlyArray<BrainSearchResult>,
  filters: PoolFilters,
  ctx: FilterContext,
): ReadonlyArray<BrainSearchResult> {
  const typeValues = filters.promoted?.get("type");
  const judgeType = typeValues !== undefined && filters.pushdown?.pageTypes !== undefined;
  const pinnedValues = filters.promoted?.get("pinned");
  const judgePinned = pinnedValues !== undefined && filters.pushdown?.pinned === true;
  if (!judgeType && !judgePinned) return ranked;
  const states = ctx.store.promotedColumnStates([...new Set(ranked.map((r) => r.documentId))]);
  const unspoken = ranked.filter((r) => {
    const state = states.get(r.documentId);
    if (state === undefined) return true;
    if (judgeType && state.pageType === null) return true;
    if (judgePinned && state.pinned === null) return true;
    return false;
  });
  if (unspoken.length === 0) return ranked;
  const live = new Map<string, ReadonlyArray<string>>();
  if (judgeType) live.set("type", typeValues);
  if (judgePinned) live.set("pinned", pinnedValues);
  const kept = new Set(
    applyPropertyFilter(unspoken, live, ctx.vault, ctx.frontmatterCache).map((r) => r.chunkId),
  );
  return ranked.filter((r) => !unspoken.includes(r) || kept.has(r.chunkId));
}
