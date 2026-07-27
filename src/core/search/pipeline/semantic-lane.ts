/**
 * Semantic candidate lane as the pipeline sees it: the guarded vector
 * phase plus the two caller-visible signals that only make sense once the
 * lane has run or been skipped - embedding-ABI drift and hybrid degrade.
 */

import { detectHybridDegrade } from "../enrich.ts";
import { runSemanticPhase, semanticPoolSize } from "../semantic-phase.ts";
import { contradictedAbiFields, formatEmbeddingAbiDrift } from "../store.ts";
import type { SemanticPolicy } from "../semantic-phase.ts";
import type { Store } from "../store.ts";
import type { ResolvedSearchConfig } from "../types.ts";

export interface SemanticLaneInput {
  readonly store: Store;
  readonly config: ResolvedSearchConfig;
  readonly policy: SemanticPolicy;
  /** Residual query text, used when no structured vec lane was given. */
  readonly query: string;
  readonly semanticLaneQuery: string | null;
  readonly limit: number;
  readonly pathPrefix: string | undefined;
  /** Keyword pool size, the other half of the hybrid-degrade signal. */
  readonly keywordHitCount: number;
}

export interface SemanticLaneOutcome {
  readonly hits: ReturnType<Store["semanticTopK"]>;
  readonly attempted: boolean;
  readonly warnings: string[];
}

export async function runSemanticLane(input: SemanticLaneInput): Promise<SemanticLaneOutcome> {
  const { store, config, policy, query, semanticLaneQuery, limit, pathPrefix } = input;
  const warnings: string[] = [];
  let hits: ReturnType<Store["semanticTopK"]> = [];
  let attempted = false;

  if (semanticLaneQuery !== null && !policy.wantSemantic) {
    warnings.push("semantic structured lanes skipped: semantic search is disabled");
  }
  if (policy.wantSemantic) {
    const semOutcome = await runSemanticPhase(store, config, semanticLaneQuery ?? query, {
      limit: semanticPoolSize(limit),
      pathPrefix,
      explicit: policy.explicit,
    });
    attempted = semOutcome.attempted;
    hits = semOutcome.hits;
    for (const w of semOutcome.warnings) warnings.push(w);
    // Embedding-ABI drift on the QUERY path (context-integrity-gates,
    // Unit E). The read open already ran the gated comparison; until
    // now nothing on this path looked at the result, so under the
    // shipped `warn` default a caller was served neighbours out of a
    // vector table written by another build with nothing to observe.
    //
    // Attached to the queries it actually describes: only when the
    // semantic lane RAN, so a keyword-only query stays byte-identical,
    // and only for fields the index CONTRADICTS. An unrecorded token
    // is a store predating the stamp - true of every index built
    // before this release - and repeating it on every query would
    // make the warning worthless; it stays on `search status`,
    // `second_brain_status` and `search check`, which is where an
    // operator goes looking.
    if (attempted) {
      const contradicted = contradictedAbiFields(store.embeddingAbiMismatches());
      if (contradicted.length > 0) warnings.push(formatEmbeddingAbiDrift(contradicted));
    }
  }

  // Hybrid-degrade signal (Search & Recall Quality Suite): one
  // structural warning when the caller wanted the semantic lane but it
  // did not run, so the query was served keyword-only. The granular
  // runSemanticPhase warnings above explain WHY; this is the single
  // greppable flag a caller can test for.
  const degrade = detectHybridDegrade({
    wantSemantic: policy.wantSemantic,
    semanticAttempted: attempted,
    keywordHitCount: input.keywordHitCount,
  });
  if (degrade !== null) warnings.push(degrade);

  return { hits, attempted, warnings };
}
