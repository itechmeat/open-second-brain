/**
 * Post-rank pool phases: everything that still adds, removes or re-orders
 * a candidate AFTER ranking and BEFORE the final `limit` slice - so a
 * demoted row can fall out of the window and a promoted one can enter it.
 *
 * Order is the contract here: structured exclusions, relation polarity,
 * reinforce, the cross-encoder reader, then the deterministic
 * rank-adjustment sink that emits the trust receipts. Only the
 * cross-encoder call can be cut short by the composite hybrid deadline;
 * every other phase runs on whichever order the reader step returned.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { emitGatedTelemetry } from "../../brain/continuity/emit.ts";
import { privateRegionTexts } from "../../redactor.ts";
import {
  MAX_CHAIN_DEPTH,
  SUPERSEDED_BY_KEY,
  isTombstoned,
} from "../../brain/lifecycle/tombstone.ts";
import {
  buildMemoryTrustAssessment,
  buildRetrievalDecisionTrace,
} from "../../brain/trust/retrieval-receipts.ts";
import { trustGateAdjuster } from "../../brain/trust/retrieval-gate.ts";
import { applyRelationPolarityPhase } from "../graph-phases.ts";
import { clamp01 } from "../../math.ts";
import { isVisible, pageVisibility } from "../../graph/visibility.ts";
import { SUPERSEDED_BY_RELATION } from "../../graph/relation-vocab.ts";
import { couplingVerdict, type CouplingVerdict } from "../correction-coupling.ts";
import { SUCCESSOR_CARRY } from "../relation-polarity.ts";
import {
  applyPoolFilters,
  resolvePoolFilters,
  type FilterContext,
  type PoolFilters,
} from "./pool-filters.ts";
import { applyRankAdjusters, type RankAdjuster } from "../rank-adjust.ts";
import { applyReinforceBoost, loadReinforceStrengths } from "../reinforce.ts";
import { applyCrossEncoderRerank } from "../rerank/index.ts";
import { applyRelationalRerankPin } from "./relational-arm.ts";
import type { DecisionRerankExtras } from "../rerank/decision-model.ts";
import { RERANK_QUESTIONS } from "../../decision-model/questions.ts";
import type { FrontmatterMap } from "../../types.ts";
import {
  applyReachFilter,
  isPathOwnerVisible,
  isPathReadableAtReach,
  readCachedFrontmatter,
  readCachedFrontmatterEntry,
  supersedeFadeAdjuster,
  type FrontmatterCache,
} from "../result-filters.ts";
import { applyStructuredExclusions } from "../structured-lanes.ts";
import type { HydratedChunk } from "../store/chunks.ts";
import {
  RETRIEVAL_DEGRADATION,
  noteDegradation,
  type RetrievalDegradationSink,
} from "../retrieval-trail.ts";
import type { Store } from "../store.ts";
import type {
  BrainSearchResult,
  ResolvedSearchConfig,
  SearchOptions,
  StructuredRecallQueryDocument,
} from "../types.ts";

export interface PostRankInput {
  readonly store: Store;
  readonly config: ResolvedSearchConfig;
  readonly opts: SearchOptions;
  /** Residual query text, the cross-encoder's reader input. */
  readonly query: string;
  readonly pool: ReadonlyArray<BrainSearchResult>;
  readonly structured: StructuredRecallQueryDocument | undefined;
  readonly frontmatterCache: FrontmatterCache;
  /**
   * The composite hybrid deadline's race over the cross-encoder call, the
   * one budgeted wait in this phase. Past the deadline it serves the
   * pre-rerank order, and every deterministic filter and adjuster below
   * still runs on it. Absent: the rerank is awaited as is.
   */
  readonly raceRerank?: RerankRace;
  /** The deadline's cancellation, handed to the rerank provider request. */
  readonly signal?: AbortSignal;
  /** The request's clock, for the rerank sunset decision. */
  readonly nowMs: number;
}

/** Start `work` under a budget; serve `fallback()` when the budget wins. */
export type RerankRace = (
  work: () => Promise<ReadonlyArray<BrainSearchResult>>,
  fallback: () => ReadonlyArray<BrainSearchResult>,
) => Promise<ReadonlyArray<BrainSearchResult>>;

export interface TrustReceipts {
  readonly retrievalDecisionTrace: ReturnType<typeof buildRetrievalDecisionTrace>;
  readonly memoryTrustAssessment: ReturnType<typeof buildMemoryTrustAssessment>;
}

export interface PostRankOutcome {
  readonly results: ReadonlyArray<BrainSearchResult>;
  /** Null on the default path, where the outcome shape stays unchanged. */
  readonly trustReceipts: TrustReceipts | null;
  readonly warnings: string[];
  /**
   * The typed codes beside {@link warnings}, merged into the search's own
   * sink like every lane's. A failed cross-encoder request records
   * `rerank-provider-unavailable` with its failure category here, and a
   * request skipped for a retired model records `rerank-model-sunset`.
   */
  readonly degraded: RetrievalDegradationSink;
  /**
   * Extra decision-model answers carried by the rerank request (issue
   * #213, Part 2). Present only when rerank kind `decision-model` ran,
   * the `answerable` use is not `off` and a valid answer arrived; absent
   * everywhere else, so the outcome shape is unchanged by default.
   */
  readonly decisionModel?: DecisionRerankExtras;
  /**
   * True when rerank kind `decision-model` returned the heuristic order in
   * place of the configured one (degraded, not active, or skipped on a
   * hook surface). Such an outcome must not be written to the query cache,
   * or a later search would be served the fallback as the enforced order.
   */
  readonly decisionFallback?: boolean;
}

/**
 * The frontmatter values a decision-model rerank sends beside a passage:
 * only the fields `questions.ts` names, only scalar values, as strings.
 * Null when the page declares none of them.
 */
function decisionMetaFields(meta: FrontmatterMap): Readonly<Record<string, string>> | null {
  const out: Record<string, string> = {};
  for (const key of RERANK_QUESTIONS.metaFields) {
    const value = meta[key];
    if (typeof value === "string" || typeof value === "number") out[key] = String(value);
  }
  return Object.keys(out).length > 0 ? out : null;
}

// ----- Serve-with-correction coupling ---------------------------------------

// The chain walk reads its edge relation through the relation
// vocabulary's single boundary: SUPERSEDED_BY_RELATION is the same word
// as the frontmatter key ({@link SUPERSEDED_BY_KEY}), but a distinct
// vocabulary - this one names an indexed edge relation.

/**
 * Provenance stamped on a correction row the coupling stage pulled in,
 * naming the retired-but-serveable row it legitimized - the machine
 * reason vocabulary the polarity phase's `supersedes_matched:` belongs to.
 */
export const CORRECTION_FOR_REASON_PREFIX = "correction_for:";

interface CouplingOutcome {
  readonly pool: ReadonlyArray<BrainSearchResult>;
  /** True when the stage appended a correction row absent from the pool. */
  readonly pulledIn: boolean;
}

/**
 * Resolve a row's `superseded_by` chain to its tip document id, walking
 * the index's typed edges - the frontmatter's own pointers, one edge
 * fetch per hop, bounded by the lifecycle chain cap. Null when any hop
 * dangles, the walk cycles, or the cap is hit: an unresolved tip is the
 * coupling predicate's fail-closed input.
 */
function resolveChainTipDocumentId(
  store: PostRankInput["store"],
  startDocumentId: number,
): number | null {
  let documentId: number | null = startDocumentId;
  const visited = new Set<number>();
  for (let hop = 0; hop < MAX_CHAIN_DEPTH; hop++) {
    if (documentId === null || visited.has(documentId)) return null;
    visited.add(documentId);
    // A page declaring several successors is pathological; the
    // target-ordered first edge keeps the walk deterministic.
    const edges = store
      .typedRelationEdgesForDocuments([documentId])
      .filter((edge) => edge.relation === SUPERSEDED_BY_RELATION)
      .toSorted((a, b) => (a.target < b.target ? -1 : a.target > b.target ? 1 : 0));
    if (edges.length === 0) return documentId;
    documentId = edges[0]!.targetDocumentId;
  }
  return null;
}

/**
 * May the caller's full filter set serve this correction page? The
 * composed verdict carried as the predicate's `successorReadable` input:
 * the page must be readable, not itself tombstoned, inside the caller's
 * agent scope and visibility scope, and readable at its reach. Every
 * answer here is fail-closed - a page that fails any rung makes the row
 * it would legitimize drop instead of surface bare.
 */
function correctionReadableAtCaller(
  path: string,
  vault: string,
  frontmatterCache: FrontmatterCache,
  store: PostRankInput["store"],
  filters: PoolFilters,
): boolean {
  const entry = readCachedFrontmatterEntry(frontmatterCache, vault, path);
  if (entry.unreadable || isTombstoned(entry.meta)) return false;
  if (
    filters.agentScope !== null &&
    !isPathOwnerVisible(vault, path, filters.agentScope, frontmatterCache)
  ) {
    return false;
  }
  if (!isVisible(pageVisibility(entry.meta), filters.visibilityScope)) return false;
  const indexedTags = store.indexedVisibilityByPaths([path]).get(path);
  return isPathReadableAtReach(vault, path, filters.reach, frontmatterCache, indexedTags);
}

/**
 * The row shape both the tip probe and the appended correction are built
 * into: a representative chunk projected into a result row - the one
 * shape every pool filter answers, which never reads the projection's
 * scores.
 */
function rowFromHead(
  head: HydratedChunk,
  score: number,
  reasons: ReadonlyArray<string>,
): BrainSearchResult {
  return {
    documentId: head.documentId,
    chunkId: head.chunkId,
    path: head.path,
    title: head.title,
    content: head.content,
    startLine: head.startLine,
    endLine: head.endLine,
    score,
    keywordScore: 0,
    semanticScore: 0,
    linkBoost: 0,
    recencyBoost: 0,
    searchType: "link",
    reasons: Object.freeze([...reasons]),
  };
}

/**
 * Would a row for this correction page survive the caller's full filter
 * set? {@link correctionReadableAtCaller} carries the readability, status,
 * agent-scope, visibility-scope and reach rungs; the property, degree and
 * composite-scope rungs are the caller's opt-in pool filters, and rather
 * than re-spelling them as extra verdict rungs the tip candidate is
 * probed through {@link applyPoolFilters} itself - the ONE pipeline the
 * widened-pool re-filter runs, so the verdict and that re-filter cannot
 * disagree. A tip the probe drops counts as unresolved, and its
 * predecessor drops with it: a dropped correction can never leave its
 * predecessor served bare.
 */
function correctionSurvivesPoolFilters(
  head: HydratedChunk,
  filters: PoolFilters,
  ctx: FilterContext,
): boolean {
  return applyPoolFilters([rowFromHead(head, 0, [])], filters, ctx).visible.length === 1;
}

/**
 * The coupling verdict for one retired row whose chain walk already
 * resolved to `tipDocumentId` (null when the walk's tip is the row's own
 * id, the unresolved corner): the tip must be a DISTINCT readable page
 * that survives the caller's full filter set, fail-closed on every rung.
 * The predecessor's own verdict and a chain-tip correction's verdict for
 * itself are the same question over a different start row, so both ask
 * it here - one spelling of the rule.
 */
function chainTipVerdict(
  store: PostRankInput["store"],
  vault: string,
  frontmatterCache: FrontmatterCache,
  filters: PoolFilters,
  filterCtx: FilterContext,
  predecessorPath: string,
  tipDocumentId: number | null,
): CouplingVerdict {
  const representative =
    tipDocumentId === null
      ? undefined
      : store.representativeChunks([tipDocumentId]).get(tipDocumentId);
  const successorPath = representative?.path ?? null;
  return couplingVerdict({
    predecessorPath,
    successorPath,
    successorReadable:
      successorPath !== null &&
      representative !== undefined &&
      correctionReadableAtCaller(successorPath, vault, frontmatterCache, store, filters) &&
      correctionSurvivesPoolFilters(representative, filters, filterCtx),
  });
}

/**
 * The serve-with-correction coupling over the pool's retired-but-serveable
 * rows (truth-correctable-time-aware, contract item 3, Task 18). A row
 * whose page carries a `superseded_by` pointer but survived the status
 * filter is served only beside its resolved chain-tip correction when the
 * caller's FULL filter set would serve that correction - decided by
 * {@link couplingVerdict} over the composed readability rungs plus the
 * {@link correctionSurvivesPoolFilters} probe - and is dropped
 * otherwise, so a withheld correction takes its predecessor with it. The
 * tip arrives as a link-type row beside the row it corrects, carrying a
 * share of its score so the pair survives the final slice together.
 *
 * A pool with no retired rows returns the input untouched (same array,
 * same order): the neutral path is byte-identical by construction.
 */
function applyCorrectionCoupling(
  pool: ReadonlyArray<BrainSearchResult>,
  store: PostRankInput["store"],
  vault: string,
  frontmatterCache: FrontmatterCache,
  filters: PoolFilters,
): CouplingOutcome {
  interface RetiredRow {
    readonly result: BrainSearchResult;
    readonly tipDocumentId: number | null;
  }
  const retired: RetiredRow[] = [];
  for (const result of pool) {
    const pointer = readCachedFrontmatter(frontmatterCache, vault, result.path)[SUPERSEDED_BY_KEY];
    if (typeof pointer !== "string" || pointer.trim() === "") continue;
    retired.push({ result, tipDocumentId: resolveChainTipDocumentId(store, result.documentId) });
  }
  if (retired.length === 0) return { pool, pulledIn: false };

  const droppedChunkIds = new Set<number>();
  const filterCtx: FilterContext = { vault, store, frontmatterCache };
  interface PendingCorrection {
    readonly documentId: number;
    readonly predecessors: string[];
    carriedScore: number;
  }
  const pending = new Map<string, PendingCorrection>();
  for (const { result, tipDocumentId } of retired) {
    // A blocked (schema-constrained) or stale `superseded_by` index edge
    // leaves the walk no first hop, and the walk then answers the START
    // document as its own tip. That is not a resolved chain - the page's
    // frontmatter declares a successor that its own id cannot answer - so
    // it is classified as unresolved and the row drops fail-closed: a
    // retired row is served only beside a DISTINCT readable chain-tip
    // correction, never bare.
    const tipId = tipDocumentId !== result.documentId ? tipDocumentId : null;
    const verdict = chainTipVerdict(
      store,
      vault,
      frontmatterCache,
      filters,
      filterCtx,
      result.path,
      tipId,
    );
    // A chain-tip correction that is itself a retired row the pool never
    // carried (its own pointer postdates the index, or its chain is
    // otherwise unresolved) asks the same question for itself before it
    // can be appended beside this row: appended bare, its own drop
    // verdict would re-enter the pool exactly the way the branch below
    // forbids. The drop counts as unresolved for the predecessor too,
    // and the fail-closed branch takes the predecessor with it.
    if (verdict.action === "serve_coupled") {
      const tipPointer = readCachedFrontmatter(frontmatterCache, vault, verdict.correctionPath)[
        SUPERSEDED_BY_KEY
      ];
      if (typeof tipPointer === "string" && tipPointer.trim() !== "") {
        const ownTipId = resolveChainTipDocumentId(store, tipId!);
        const ownVerdict = chainTipVerdict(
          store,
          vault,
          frontmatterCache,
          filters,
          filterCtx,
          verdict.correctionPath,
          ownTipId !== tipId ? ownTipId : null,
        );
        if (ownVerdict.action === "drop") {
          droppedChunkIds.add(result.chunkId);
          continue;
        }
      }
    }
    if (verdict.action === "drop") {
      droppedChunkIds.add(result.chunkId);
      continue;
    }
    const carried = clamp01(result.score * SUCCESSOR_CARRY);
    const existing = pending.get(verdict.correctionPath);
    if (existing !== undefined) {
      existing.carriedScore = Math.max(existing.carriedScore, carried);
      if (!existing.predecessors.includes(result.path)) existing.predecessors.push(result.path);
      continue;
    }
    pending.set(verdict.correctionPath, {
      documentId: tipId!,
      predecessors: [result.path],
      carriedScore: carried,
    });
  }

  const kept = pool.filter((r) => !droppedChunkIds.has(r.chunkId));
  const representatives = store.representativeChunks(
    Array.from(new Set(Array.from(pending.values(), (c) => c.documentId))),
  );
  const appended: BrainSearchResult[] = [];
  for (const [correctionPath, entry] of pending) {
    // Already served by its own rank: the correction is beside the row
    // that needs it, and its own reasons already explain the match.
    if (kept.some((r) => r.path === correctionPath)) continue;
    const head = representatives.get(entry.documentId);
    if (head === undefined) continue;
    appended.push(
      Object.freeze(
        rowFromHead(
          head,
          entry.carriedScore,
          entry.predecessors.map((p) => `${CORRECTION_FOR_REASON_PREFIX} ${p}`),
        ),
      ),
    );
  }
  if (appended.length === 0) return { pool: kept, pulledIn: false };
  // Same tie-break family as the ranker and the polarity phase, so a
  // pulled correction lands beside the row it corrects deterministically.
  const out = [...kept, ...appended];
  out.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.keywordScore !== a.keywordScore) return b.keywordScore - a.keywordScore;
    return a.chunkId - b.chunkId;
  });
  return { pool: out, pulledIn: true };
}

export async function applyPostRankPhases(input: PostRankInput): Promise<PostRankOutcome> {
  const { store, config, opts, frontmatterCache } = input;
  const warnings: string[] = [];
  const degraded: RetrievalDegradationSink = [];

  const excluded = applyStructuredExclusions(input.pool, input.structured);
  // Relation polarity (recall-trust-suite): typed relation edges adjust
  // the pool BEFORE the final slice so a demoted predecessor can fall
  // out of the window and a pulled-in successor can enter it. A pool
  // whose documents declare no typed edges passes through untouched.
  const polarized = config.recall.relationPolarityEnabled
    ? applyRelationPolarityPhase(store, excluded, opts.includeSuperseded === true)
    : excluded;
  // Serve-with-correction coupling (truth-correctable-time-aware,
  // contract item 3): a retired-but-serveable row - a page whose
  // frontmatter declares a successor but which survived the status
  // filter - is served only beside its resolved, readable chain-tip
  // correction and is dropped otherwise, fail-closed. The predicate
  // replaces the polarity branch's best-effort treatment of retired
  // rows, where an unresolved successor used to leave the predecessor
  // served bare.
  const poolFilters = resolvePoolFilters(opts);
  const coupled = applyCorrectionCoupling(
    polarized,
    store,
    config.vault,
    frontmatterCache,
    poolFilters,
  );
  // Root A again, and it has to be: the polarity phase resolves typed
  // `superseded_by` edges to documents that were NEVER in the filtered
  // pool, fetches their representative chunks off the store and appends
  // them with full path, title and content; the coupling stage appends
  // chain-tip corrections the same way. Nothing between that append and
  // the outcome used to re-ask any pool filter, so a public page naming a
  // reserved successor was a route to that successor's body at remote
  // reach, and the caller's `visibility` scope and `agentScope` had the
  // same gap - the recorded defect this stage now closes. Re-asking over
  // the whole pool rather than the pulled-in rows alone is deliberate:
  // every pass is idempotent and every already-filtered row answers off
  // the shared frontmatter cache, so one spelling of the rule costs less
  // than a second one that tracked which rows were new. With no pull-in
  // the single reach re-filter below is exactly what ran before, and a
  // pool with neither pull-in nor retired row is byte-identical.
  const polarityPulled = polarized.length !== excluded.length;
  // The caller's post-rank filter set re-asked over a pool a post-rank
  // phase widened goes through applyPoolFilters - the ONE pipeline the
  // visibility census pins as applyVisibilityScope's single call site.
  // Every pass is idempotent over the rows that already answered it, so
  // re-running the whole pool costs shared-cache reads and keeps one
  // spelling of each rule; tracking which rows were new would be a
  // second copy of the same bookkeeping.
  const reachable =
    polarityPulled || coupled.pulledIn
      ? applyPoolFilters(coupled.pool, poolFilters, {
          vault: config.vault,
          store,
          frontmatterCache,
        }).visible
      : applyReachFilter(coupled.pool, poolFilters.reach, config.vault, frontmatterCache, store);
  // Self-tuning reinforce (Search & Recall Quality Suite): opt-in. When
  // the caller passes a reinforce set, the persisted ledger lifts
  // proven-useful memories by a bounded boost BEFORE the top_k cut, so
  // a reinforced hit can enter the window. Absent leaves the pool
  // untouched; an empty ledger is a no-op either way.
  const reinforced =
    opts.reinforce !== undefined
      ? applyReinforceBoost(reachable, loadReinforceStrengths(config.vault))
      : reachable;
  // Cross-encoder rerank (retrieval-precision-quality-loop, card A): the
  // final reader step, appended AFTER every heuristic rerank. Disabled
  // (default) returns the pool unchanged (byte-identical); enabled but
  // unconfigured throws a typed config error; enabled + a request-time
  // endpoint error degrades to the heuristic ordering and records one
  // fail-open telemetry warning. Runs over the widened pool so a deep
  // candidate can be promoted into the final `limit` window below.
  let decisionExtras: DecisionRerankExtras | undefined;
  let decisionFallback = false;
  const regionsByPath = new Map<string, ReadonlyArray<string> | null>();
  const runRerank = (): Promise<ReadonlyArray<BrainSearchResult>> =>
    applyCrossEncoderRerank(reinforced, input.query, config.rerank, {
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      sunset: {
        nowMs: input.nowMs,
        onSkip: () => noteDegradation(degraded, RETRIEVAL_DEGRADATION.rerankModelSunset),
      },
      onTelemetry: (event) => {
        if (event.status !== "error") return;
        // The code is the answer's own record, not telemetry: it is
        // written outside the fail-open gate so it cannot be swallowed.
        noteDegradation(degraded, RETRIEVAL_DEGRADATION.rerankProviderUnavailable, {
          category: event.category,
        });
        emitGatedTelemetry(event, (failure) => {
          warnings.push(`rerank_degraded: ${failure.reason}`);
        });
      },
      // Decision-model kind only: a candidate leaves the machine only when
      // its page's visibility resolves and does not carry `private`.
      resolveVisibility: (path) => {
        const entry = readCachedFrontmatterEntry(frontmatterCache, config.vault, path);
        return entry.unreadable ? null : pageVisibility(entry.meta);
      },
      // The index keeps a page's text whole, and a long `<private>` region
      // can be split across chunks, so the page's own regions are read to
      // tell whether a chunk carries part of one. Unreadable: null, withheld.
      resolvePrivateRegions: (path) => {
        if (regionsByPath.has(path)) return regionsByPath.get(path)!;
        let regions: ReadonlyArray<string> | null;
        try {
          regions = privateRegionTexts(readFileSync(join(config.vault, path), "utf8"));
        } catch {
          regions = null;
        }
        regionsByPath.set(path, regions);
        return regions;
      },
      // Decision-model kind only: the declared `status` and `updated` of a
      // result's page travel beside its passage, so an archived or older
      // copy can be told from the current one. Nothing else is read.
      resolveMeta: (path) => {
        const entry = readCachedFrontmatterEntry(frontmatterCache, config.vault, path);
        return entry.unreadable ? null : decisionMetaFields(entry.meta);
      },
      skipDecisionModel: opts.skipDecisionModelRerank === true,
      onDecisionFallback: () => {
        decisionFallback = true;
      },
      onDecisionExtras: (extras) => {
        decisionExtras = extras;
      },
    });
  const reranked =
    input.raceRerank === undefined
      ? await runRerank()
      : await input.raceRerank(runRerank, () => reinforced);
  // Relational rerank pin (t_d9f863e9), `search_relational_rerank_pin`.
  // Off (default) the rerank order passes through untouched, byte-
  // identically. On, the rerank may promote relational-origin candidates
  // but never sinks one below its pre-rerank heuristic position - the
  // protect rule runs HERE, at the cross-encoder hand-off, over the pool
  // order `reinforced` carried in, so every rerank kind is covered and the
  // `minScore` relevance floor inside the stage still applies unchanged.
  const pinnedReranked =
    config.rerank.relationalRerankPin === true
      ? applyRelationalRerankPin(reinforced, reranked)
      : reranked;
  // Kernel 1 (t_5f61130a): the deterministic rank-adjustment sink between
  // ranking and result emission, mounted on BOTH the semantic and the
  // pure-lexical paths (both flow through this single pre-slice pool).
  // Registered adjusters return a per-candidate verdict; with none
  // registered the pool is returned unchanged, so the default path is
  // byte-identical. Runs BEFORE the slice so a gate exclusion lets a
  // deeper survivor backfill the window rather than shrinking it.
  const rankAdjusters: RankAdjuster[] = [];
  if (config.recall.retrievalTrustGateEnabled) {
    rankAdjusters.push(
      trustGateAdjuster((path) => readCachedFrontmatter(frontmatterCache, config.vault, path)),
    );
  }
  if (config.recall.supersedeFadeEnabled) {
    // Relation-only supersede fade (t_c4a9cef8): fetch the pool's typed
    // relations once and fade any candidate a `superseded_by` edge marks
    // superseded, the same source of truth `attachTrustMetadata` uses.
    const poolDocIds = Array.from(new Set(pinnedReranked.map((r) => r.documentId)));
    const relByPoolDoc = store.typedRelationsForDocuments(poolDocIds);
    rankAdjusters.push(supersedeFadeAdjuster((documentId) => relByPoolDoc.get(documentId) ?? []));
  }
  const adjusted = applyRankAdjusters(pinnedReranked, rankAdjusters);
  // Per-pack retrieval trust receipts (t_5f61130a): compact references
  // consistent with the context-receipt model. Built only when the gate
  // ran, so the outcome shape stays byte-identical on the default path.
  const trustReceipts = config.recall.retrievalTrustGateEnabled
    ? {
        retrievalDecisionTrace: buildRetrievalDecisionTrace({
          surfaced: adjusted.results.length,
          excluded: adjusted.excluded,
        }),
        memoryTrustAssessment: buildMemoryTrustAssessment({
          surfaced: adjusted.results.length,
          excluded: adjusted.excluded,
        }),
      }
    : null;

  return {
    results: adjusted.results,
    trustReceipts,
    warnings,
    degraded,
    ...(decisionExtras !== undefined ? { decisionModel: decisionExtras } : {}),
    ...(decisionFallback ? { decisionFallback: true } : {}),
  };
}
