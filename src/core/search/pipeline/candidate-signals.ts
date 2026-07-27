/**
 * Per-candidate ranking signals: everything the ranker needs about the
 * candidate set beyond the two lanes' own scores - link sources, tags,
 * entity overlap, access-reinforced activation and its co-access
 * companions, freshness trend, observed reuse, and declared event time.
 *
 * Every map here is OMITTED when it would be empty, so a vault that
 * carries none of these signals ranks bit-identically.
 */

import { parseFreshnessTrend } from "../../brain/temporal/freshness-trend.ts";
import { observedReuseRates } from "../../brain/observed-use.ts";
import { effectiveActivation, halfLifeDays, resolveActivationKind } from "../activation/decay.ts";
import { CO_ACCESS_MIN_COUNT, readActivationState } from "../activation/store.ts";
import type { ActivationPathState, CoAccessPair } from "../activation/types.ts";
import { extractEntities } from "../entities.ts";
import { expandQueryEntities } from "../entity-alias.ts";
import { readCachedFrontmatter, type FrontmatterCache } from "../result-filters.ts";
import type { HydratedChunk, Store } from "../store.ts";
import type { ResolvedSearchConfig } from "../types.ts";

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/** The freshness-trend stamp is a preference-lifecycle field, not a generic page property. */
const FRESHNESS_TREND_PATH_PREFIX = "Brain/preferences/";

export interface CandidateSignalsInput {
  readonly store: Store;
  readonly config: ResolvedSearchConfig;
  readonly ids: ReadonlyArray<number>;
  readonly hydrated: ReadonlyMap<number, HydratedChunk>;
  /** Residual query text, for entity extraction. */
  readonly query: string;
  readonly frontmatterCache: FrontmatterCache;
  /** Present only when the query declares a temporal window. */
  readonly temporalIntentActive: boolean;
  readonly declaredEventTimeMs: (path: string) => number | null;
}

export interface CandidateSignals {
  readonly inboundLinkSources: ReadonlyMap<number, ReadonlySet<number>>;
  readonly tagsByDoc: ReadonlyMap<number, ReadonlySet<string>>;
  readonly entityMatchByChunk: ReadonlyMap<number, number> | undefined;
  /** Chunks matching a registry-ADDED form, for canonical-hop attribution. */
  readonly canonicalMatchByChunk: ReadonlyMap<number, number> | undefined;
  /** Canonical entity ids the expansion hopped through. */
  readonly canonicalSourceIds: ReadonlyArray<string>;
  readonly activationByChunk: ReadonlyMap<number, number> | undefined;
  readonly coAccessByChunk: ReadonlyMap<number, ReadonlyMap<number, number>> | undefined;
  readonly trendByDoc: ReadonlyMap<number, string> | undefined;
  readonly reuseRateByChunk: ReadonlyMap<number, number> | undefined;
  readonly eventTimeMsByChunk: ReadonlyMap<number, number> | undefined;
}

export function collectCandidateSignals(input: CandidateSignalsInput): CandidateSignals {
  const { store, config, ids } = input;
  const inboundLinkSources = store.inboundLinkSources(ids);
  const tagsByDoc = store.tagsByChunkDocument(ids);

  // Entity-boosted retrieval (v0.13.0): extract entities from the
  // query and count overlaps with each candidate chunk. Empty when the
  // query names no entities or the index predates the entity store.
  // The canonical entity registry (Memory Integrity Suite) expands the
  // set so a query naming an alias also matches chunks naming the
  // canonical entity; identity expansion (no registry) keeps ranking
  // bit-identical to pre-registry behaviour.
  const queryEntities = extractEntities(input.query);
  const entityExpansion = expandQueryEntities(config.vault, queryEntities);
  const entityMatchByChunk =
    entityExpansion.expanded.length > 0
      ? store.chunkEntityMatches(ids, entityExpansion.expanded)
      : undefined;
  const canonicalMatchByChunk =
    entityExpansion.added.length > 0
      ? store.chunkEntityMatches(ids, entityExpansion.added)
      : undefined;

  const activation = config.recall.activationEnabled
    ? collectActivationSignals(input)
    : { activationByChunk: undefined, coAccessByChunk: undefined };

  return {
    inboundLinkSources,
    tagsByDoc,
    entityMatchByChunk,
    canonicalMatchByChunk,
    canonicalSourceIds: entityExpansion.sourceIds,
    activationByChunk: activation.activationByChunk,
    coAccessByChunk: activation.coAccessByChunk,
    trendByDoc: collectFreshnessTrend(input),
    reuseRateByChunk: collectReuseRates(input),
    eventTimeMsByChunk: input.temporalIntentActive ? collectDeclaredEventTimes(input) : undefined,
  };
}

/**
 * The two signals derived from one read of the activation state: the
 * decayed per-chunk strength and the co-access companions.
 */
function collectActivationSignals(input: CandidateSignalsInput): {
  activationByChunk: ReadonlyMap<number, number> | undefined;
  coAccessByChunk: ReadonlyMap<number, ReadonlyMap<number, number>> | undefined;
} {
  const activationState = readActivationState(input.config.vault);
  if (activationState === null) {
    return { activationByChunk: undefined, coAccessByChunk: undefined };
  }
  return {
    activationByChunk:
      Object.keys(activationState.paths).length > 0
        ? decayedActivationByChunk(input, activationState.paths)
        : undefined,
    coAccessByChunk:
      activationState.coAccess.length > 0
        ? coAccessCompanions(input, activationState.coAccess)
        : undefined,
  };
}

/**
 * Access-reinforced activation (Time-Aware Recall & Activation Suite):
 * map the derived activation state onto the candidate set.
 * O(candidates): one state read per query, one frontmatter read per
 * candidate path that actually carries activation. The type half-life
 * decays the stored strength at read time, so a vault without recorded
 * events contributes nothing and ranks bit-identically.
 */
function decayedActivationByChunk(
  input: CandidateSignalsInput,
  paths: Readonly<Record<string, ActivationPathState>>,
): ReadonlyMap<number, number> | undefined {
  const { config, ids, hydrated, frontmatterCache } = input;
  const nowActivationMs = Date.now();
  const kindCache = new Map<string, string>();
  const kindFor = (path: string): string => {
    const cached = kindCache.get(path);
    if (cached !== undefined) return cached;
    let fmKind: string | null = null;
    try {
      const meta = readCachedFrontmatter(frontmatterCache, config.vault, path);
      const raw = (meta as Record<string, unknown>)["kind"];
      fmKind = typeof raw === "string" ? raw : null;
    } catch {
      fmKind = null;
    }
    const kind = resolveActivationKind(fmKind, path);
    kindCache.set(path, kind);
    return kind;
  };
  const byChunk = new Map<number, number>();
  for (const chunkId of ids) {
    const h = hydrated.get(chunkId);
    if (h === undefined) continue;
    const row = paths[h.path];
    if (row === undefined) continue;
    const days = (nowActivationMs - row.lastAccessAt) / MILLISECONDS_PER_DAY;
    const act = effectiveActivation(row.strength, days, halfLifeDays(kindFor(h.path)));
    if (act > 0) byChunk.set(chunkId, act);
  }
  return byChunk.size > 0 ? byChunk : undefined;
}

/**
 * Co-access companions (t_c5ef25a3): restrict the recorded pairs to
 * documents present in this candidate set, then hand each chunk its
 * companion documentIds with pair counts. Pairs seen fewer than
 * CO_ACCESS_MIN_COUNT times are noise and skipped.
 */
function coAccessCompanions(
  input: CandidateSignalsInput,
  pairs: ReadonlyArray<CoAccessPair>,
): ReadonlyMap<number, ReadonlyMap<number, number>> | undefined {
  const { ids, hydrated } = input;
  const docIdByPath = new Map<string, number>();
  const chunksByDocId = new Map<number, number[]>();
  for (const chunkId of ids) {
    const h = hydrated.get(chunkId);
    if (h === undefined) continue;
    docIdByPath.set(h.path, h.documentId);
    const list = chunksByDocId.get(h.documentId) ?? [];
    list.push(chunkId);
    chunksByDocId.set(h.documentId, list);
  }
  const companionsByChunk = new Map<number, Map<number, number>>();
  const addCompanion = (ownDoc: number, otherDoc: number, count: number): void => {
    for (const chunkId of chunksByDocId.get(ownDoc) ?? []) {
      const m = companionsByChunk.get(chunkId) ?? new Map<number, number>();
      m.set(otherDoc, Math.max(m.get(otherDoc) ?? 0, count));
      companionsByChunk.set(chunkId, m);
    }
  };
  for (const pair of pairs) {
    if (pair.count < CO_ACCESS_MIN_COUNT) continue;
    const docA = docIdByPath.get(pair.a);
    const docB = docIdByPath.get(pair.b);
    if (docA === undefined || docB === undefined) continue;
    addCompanion(docA, docB, pair.count);
    addCompanion(docB, docA, pair.count);
  }
  return companionsByChunk.size > 0 ? companionsByChunk : undefined;
}

/**
 * Freshness-trend bias (t_ee09a6ce): preference pages stamped with a
 * `freshness_trend` by the dream refresh get a bounded relevance
 * multiplier. O(candidate preference pages) frontmatter reads.
 *
 * Cache note: like the tier signal, the stamp is read from frontmatter at
 * query time and is NOT part of the query-cache key; a dream re-stamp
 * reaches cached queries on the next reindex (the content change bumps the
 * corpus generation).
 */
function collectFreshnessTrend(
  input: CandidateSignalsInput,
): ReadonlyMap<number, string> | undefined {
  const { config, ids, hydrated, frontmatterCache } = input;
  const byDoc = new Map<number, string>();
  const seenDocs = new Set<number>();
  for (const chunkId of ids) {
    const h = hydrated.get(chunkId);
    if (h === undefined || seenDocs.has(h.documentId)) continue;
    seenDocs.add(h.documentId);
    if (!h.path.startsWith(FRESHNESS_TREND_PATH_PREFIX)) continue;
    try {
      const meta = readCachedFrontmatter(frontmatterCache, config.vault, h.path);
      const trend = parseFreshnessTrend((meta as Record<string, unknown>)["freshness_trend"]);
      if (trend !== null) byDoc.set(h.documentId, trend);
    } catch {
      // Unreadable frontmatter stays neutral.
    }
  }
  return byDoc.size > 0 ? byDoc : undefined;
}

/**
 * Observed-reuse boost (t_65588d8b): fold the session-end USED/IGNORED/
 * CONTRADICTED verdicts into a per-document reuse score and map it onto
 * each candidate chunk. Keyed by path (else id) to match how verdicts
 * are recorded. Empty (byte-identical) when no verdicts exist.
 */
function collectReuseRates(input: CandidateSignalsInput): ReadonlyMap<number, number> | undefined {
  const { config, ids, hydrated } = input;
  const reuse = observedReuseRates(config.vault);
  if (reuse.size === 0) return undefined;
  const byChunk = new Map<number, number>();
  for (const chunkId of ids) {
    const h = hydrated.get(chunkId);
    if (h === undefined) continue;
    const entry = reuse.get(h.path) ?? reuse.get(`${h.documentId}:${chunkId}`);
    if (entry !== undefined && entry.score > 0) byChunk.set(chunkId, entry.score);
  }
  return byChunk.size > 0 ? byChunk : undefined;
}

/**
 * Query-side temporal intent (t_58fc4720): hand the ranker the DECLARED
 * event time of every candidate that states one, so the temporal layer
 * judges a note by when it is about rather than by when it was last
 * written. Candidates with no declaration are omitted and the ranker falls
 * back to their mtime.
 */
function collectDeclaredEventTimes(
  input: CandidateSignalsInput,
): ReadonlyMap<number, number> | undefined {
  const { ids, hydrated, declaredEventTimeMs } = input;
  const byChunk = new Map<number, number>();
  for (const chunkId of ids) {
    const h = hydrated.get(chunkId);
    if (h === undefined) continue;
    const declared = declaredEventTimeMs(h.path);
    if (declared !== null) byChunk.set(chunkId, declared);
  }
  return byChunk.size > 0 ? byChunk : undefined;
}
