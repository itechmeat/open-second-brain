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
  buildMemoryTrustAssessment,
  buildRetrievalDecisionTrace,
} from "../../brain/trust/retrieval-receipts.ts";
import { trustGateAdjuster } from "../../brain/trust/retrieval-gate.ts";
import { applyRelationPolarityPhase } from "../graph-phases.ts";
import { resolvedTransportReach } from "../../graph/transport-reach.ts";
import { applyRankAdjusters, type RankAdjuster } from "../rank-adjust.ts";
import { applyReinforceBoost, loadReinforceStrengths } from "../reinforce.ts";
import { applyCrossEncoderRerank } from "../rerank/index.ts";
import { applyRelationalRerankPin } from "./relational-arm.ts";
import type { DecisionRerankExtras } from "../rerank/decision-model.ts";
import { RERANK_QUESTIONS } from "../../decision-model/questions.ts";
import type { FrontmatterMap } from "../../types.ts";
import { pageVisibility } from "../../graph/visibility.ts";
import {
  applyReachFilter,
  readCachedFrontmatter,
  readCachedFrontmatterEntry,
  supersedeFadeAdjuster,
  type FrontmatterCache,
} from "../result-filters.ts";
import { applyStructuredExclusions } from "../structured-lanes.ts";
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
  // Root A again, and it has to be: the polarity phase resolves typed
  // `superseded_by` edges to documents that were NEVER in the filtered
  // pool, fetches their representative chunks off the store and appends
  // them with full path, title and content. Nothing between that append
  // and the outcome re-asks any pool filter, so a public page naming a
  // reserved successor was a route to that successor's body at remote
  // reach - the pool filter never saw it, because it was not in the pool
  // to see. Re-asking over the whole pool rather than the pulled-in rows
  // alone is deliberate: the verdict is idempotent and every already-
  // filtered row answers off the shared frontmatter cache, so one
  // spelling of the rule costs less than a second one that tracked which
  // rows were new.
  //
  // RECORDED, not fixed here: the caller's `visibility` scope and its
  // `agentScope` have the same gap at this seam, and they predate this
  // boundary - a pulled-in successor bypasses `applyVisibilityScope` and
  // `applyAgentScope` exactly as it bypassed the reach rule. Closing
  // those means re-resolving the caller's whole filter set after a
  // post-rank phase, which is a change to the ownership boundary rather
  // than to this one.
  const reachable = applyReachFilter(
    polarized,
    resolvedTransportReach(opts.transportReach),
    config.vault,
    frontmatterCache,
    store,
  );
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
