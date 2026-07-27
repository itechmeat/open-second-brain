/**
 * Self-correcting second-pass recall: the two mutually exclusive retries
 * that rescue a first pass which was too strict. At most ONE fires per
 * query - a zero-candidate pool gets a broadened OR retry (t_ef92dfdc),
 * a partially-covered pool gets a targeted retry on the specifically
 * uncovered rare terms (t_8eb5ca32). Both are deterministic and LLM-free.
 */

import {
  COMPLETENESS_COMPLETE_THRESHOLD,
  planTargetedRetry,
  significantTerms,
} from "../coverage.ts";
import { coverageOverChunks } from "../evidence-verification.ts";
import { runFtsQueryDetailed } from "../fts.ts";
import { semanticPoolSize } from "../semantic-phase.ts";
import { eventTimeInRange, type ValidityWindow } from "../validity.ts";
import type { KeywordHit, Store } from "../store.ts";
import type { ResolvedTimeRange } from "../time-range.ts";
import type { SearchOutcome } from "../types.ts";

/** A broadened retry needs a base term plus at least one alternative. */
const MIN_BROADENING_TERMS = 2;

export interface SecondPassInput {
  readonly store: Store;
  /** Residual query text. */
  readonly query: string;
  readonly limit: number;
  readonly pathPrefix: string | undefined;
  readonly timeRange: ResolvedTimeRange | null;
  readonly validityWindowFor: (path: string) => ValidityWindow | null;
  readonly keywordHits: KeywordHit[];
  /** The candidate id set; a firing retry adds to it in place. */
  readonly chunkIds: Set<number>;
  readonly ids: number[];
}

export interface SecondPassOutcome {
  readonly secondPass: SearchOutcome["secondPass"];
  readonly keywordHits: KeywordHit[];
  readonly ids: number[];
  /**
   * Chunk ids the TARGETED retry recovered, so only those results (not
   * the first-pass hits they merge with) get the attribution reason.
   */
  readonly targetedChunkIds: ReadonlySet<number>;
  readonly warnings: string[];
}

export function noSecondPass(input: {
  readonly keywordHits: KeywordHit[];
  readonly ids: number[];
}): SecondPassOutcome {
  return {
    secondPass: undefined,
    keywordHits: input.keywordHits,
    ids: input.ids,
    targetedChunkIds: new Set(),
    warnings: [],
  };
}

export function runSecondPassRecall(input: SecondPassInput): SecondPassOutcome {
  if (input.ids.length === 0) return runBroadenedRetry(input);
  return runTargetedRetry(input);
}

/**
 * A zero-candidate first pass in evidence-pack mode means the implicit-AND
 * keyword match was too strict - the classic abstention dead end. Instead
 * of returning empty, run EXACTLY ONE broadened retry that keeps the first
 * significant term as the base group and ORs the rest in as alternatives,
 * then let the merged pool flow through the normal ranking, filters, and a
 * recomputed evidence pack.
 */
function runBroadenedRetry(input: SecondPassInput): SecondPassOutcome {
  const { store, query, limit, pathPrefix, chunkIds } = input;
  const terms = significantTerms(query);
  if (terms.length < MIN_BROADENING_TERMS) return noSecondPass(input);
  const broadened = runFtsQueryDetailed(store, terms[0]!, {
    expandedTerms: terms.slice(1),
    limit: semanticPoolSize(limit),
    pathPrefix: pathPrefix ?? null,
  });
  const warnings = [...broadened.warnings];
  if (broadened.hits.length === 0) {
    return { ...noSecondPass(input), warnings };
  }
  const keywordHits = broadened.hits;
  for (const h of keywordHits) chunkIds.add(h.chunkId);
  return {
    secondPass: Object.freeze({
      triggered: true,
      kind: "broadened",
      reason: "zero-candidate first pass; broadened OR retry",
      added: keywordHits.length,
    }),
    keywordHits,
    ids: Array.from(chunkIds),
    targetedChunkIds: new Set(),
    warnings,
  };
}

/**
 * Coverage-driven targeted follow-up: the first pass DID return
 * candidates, but their IDF-weighted coverage of the query is below the
 * completeness threshold with rare query terms still uncovered - a PARTIAL
 * miss, distinct from the zero-candidate dead end. Issue exactly ONE
 * targeted retry built from the specifically-uncovered rare terms (not a
 * generic broadening of the whole query) and merge the recovered
 * candidates into the pool. The recomputed pack still abstains on any term
 * left uncovered after the retry.
 */
function runTargetedRetry(input: SecondPassInput): SecondPassOutcome {
  const { store, query, limit, pathPrefix, timeRange, chunkIds, ids } = input;
  // Judge coverage over the pool that will actually survive ranking:
  // for a time-scoped query, exclude out-of-range candidates first, so
  // a rare term is not marked "covered" only because an out-of-range
  // chunk matched it (which would wrongly suppress the retry while the
  // final in-range result set still misses that term).
  let coverageIds = ids;
  if (timeRange !== null) {
    const hydratedForCoverage = store.hydrateChunks(ids);
    coverageIds = ids.filter((chunkId) => {
      const chunk = hydratedForCoverage.get(chunkId);
      if (chunk === undefined) return false;
      return eventTimeInRange(input.validityWindowFor(chunk.path), chunk.mtime, timeRange);
    });
  }
  const poolCoverage = coverageOverChunks(store, query, coverageIds);
  const retryPlan = planTargetedRetry(poolCoverage);
  if (!retryPlan.fire) return noSecondPass(input);
  const targeted = runFtsQueryDetailed(store, retryPlan.terms[0]!, {
    expandedTerms: retryPlan.terms.slice(1),
    limit: semanticPoolSize(limit),
    pathPrefix: pathPrefix ?? null,
  });
  const warnings = [...targeted.warnings];
  const newHits = targeted.hits.filter((h) => !chunkIds.has(h.chunkId));
  if (newHits.length === 0) {
    return { ...noSecondPass(input), warnings };
  }
  const targetedChunkIds = new Set<number>();
  for (const h of newHits) {
    chunkIds.add(h.chunkId);
    targetedChunkIds.add(h.chunkId);
  }
  return {
    secondPass: Object.freeze({
      triggered: true,
      kind: "targeted",
      reason: `partial coverage ${poolCoverage.idfWeightedCoverage.toFixed(2)} < ${COMPLETENESS_COMPLETE_THRESHOLD}; targeted retry on uncovered rare terms: ${retryPlan.terms.join(", ")}`,
      added: newHits.length,
      targetedTerms: retryPlan.terms,
    }),
    keywordHits: input.keywordHits.concat(newHits),
    ids: Array.from(chunkIds),
    targetedChunkIds,
    warnings,
  };
}
