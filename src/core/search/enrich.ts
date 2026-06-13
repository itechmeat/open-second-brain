/**
 * Read-time enrichment for brain_search results (Search & Recall Quality
 * Suite). The sibling of `recall-hint.ts`: every projection here is
 * computed at read time over an already-ranked result and is NEVER
 * stored. Pure - no I/O, no clock unless injected.
 *
 * Three projections live here as the suite lands:
 *   - `projectScoreBreakdown` - the structured per-layer score components
 *     surfaced under the MCP `explain` flag;
 *   - inline trust metadata (age / superseded / conflict);
 *   - hybrid-degrade detection.
 *
 * Language-agnostic by construction: every output is a number, a boolean,
 * or an identifier already present in the data - no per-locale phrase
 * table, consistent with the project's single-authoring-language stance.
 */

import type { BrainSearchResult, ScoreBreakdown } from "./types.ts";

/**
 * Project a result's structured score breakdown. A primary ranked result
 * carries `breakdown` verbatim; a synthetic result (link-traversal
 * expansion, relation-polarity successor pull-in) carries none, so the
 * breakdown is derived from the first-class lane/boost fields it does
 * expose. The non-derivable layers are honestly zero / neutral rather
 * than guessed - a synthetic hop result genuinely has no entity,
 * activation, or co-access contribution.
 */
export function projectScoreBreakdown(result: BrainSearchResult): ScoreBreakdown {
  if (result.breakdown !== undefined) return result.breakdown;
  return Object.freeze({
    keyword: result.keywordScore,
    semantic: result.semanticScore,
    rrf: 0,
    entity: 0,
    activation: 0,
    coAccess: 0,
    link: result.linkBoost,
    recency: result.recencyBoost,
    tier: 1,
    trend: 1,
    sessionFocus: 0,
  });
}

export interface HybridDegradeInput {
  /** Did the caller's resolved policy want the semantic lane at all? */
  readonly wantSemantic: boolean;
  /** Did the semantic lane actually run and return (vs degrade out)? */
  readonly semanticAttempted: boolean;
  /** Number of keyword (FTS5) candidates the query produced. */
  readonly keywordHitCount: number;
}

/**
 * Detect the genuine silent single-lane fallback: the caller wanted
 * hybrid (semantic + keyword) but the semantic lane did not run, so the
 * query was served keyword-only without the caller being told. Returns a
 * single greppable `hybrid_degraded:` warning, or null when retrieval
 * matched the caller's hybrid intent.
 *
 * Scope note: in this engine the keyword (FTS5) lane is always available,
 * so the realistic silent degrade is the loss of the semantic lane
 * (missing embeddings, unloaded vec extension, unconfigured key). A query
 * with simply no keyword match is NOT flagged - that is an empty lexical
 * result, not a configuration fallback, and flagging it would be
 * misleading noise. The granular `runSemanticPhase` warnings still
 * explain WHY the lane dropped; this is the one structural signal a
 * caller can test for.
 */
export function detectHybridDegrade(input: HybridDegradeInput): string | null {
  if (input.wantSemantic && !input.semanticAttempted && input.keywordHitCount > 0) {
    return "hybrid_degraded: semantic lane unavailable, served keyword-only";
  }
  return null;
}
