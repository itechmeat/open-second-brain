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

import type { BrainSearchResult, ScoreBreakdown, TrustMetadata } from "./types.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Typed relations that mark a hit superseded by a successor. */
const SUPERSEDED_RELATION = "superseded_by";
/** Typed relations that mark a hit as declaring a contradiction. */
const CONFLICT_RELATION = "contradicts";

/**
 * True when a page's surfaced typed relations mark it superseded (it
 * declares a `superseded_by` edge). This is the single source of truth
 * `deriveTrust` uses for the inline `trust.superseded` flag; the
 * relation-only supersede fade (t_c4a9cef8) reuses it so display and
 * ranking agree on what "superseded" means.
 */
export function hasSupersededRelation(
  relations: ReadonlyArray<{ readonly relation: string }>,
): boolean {
  return relations.some((r) => r.relation === SUPERSEDED_RELATION);
}

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
    reuse: 0,
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

export interface DeriveTrustInput {
  /** Document modification time in unix-ms. */
  readonly mtimeMs: number;
  /** Reference time in unix-ms (injected for deterministic tests). */
  readonly nowMs: number;
  /**
   * Typed relations the hit's page declares (the same array surfaced on
   * the result). `superseded_by` marks the hit superseded; `contradicts`
   * marks it conflicted. Absent = neither.
   */
  readonly relations?: ReadonlyArray<{ readonly relation: string; readonly target: string }>;
}

/**
 * Inline per-hit trust metadata (Search & Recall Quality Suite): the
 * validity signals recall already computes, projected onto a hit so the
 * agent weights stale or contested memories without a second audit pass.
 *
 * Scope: this is note-level validity, derived from the typed relation
 * edges the search pipeline surfaces (`superseded_by`, `contradicts`) and
 * the document mtime - NOT the entity/aspect claim-ledger truth fold,
 * which is a different granularity (facts, not notes) and is not
 * well-defined per recall hit. Read-time and never stored, like the
 * recall hint. Language-agnostic: a whole-day count plus two booleans.
 */
export function deriveTrust(input: DeriveTrustInput): TrustMetadata {
  const ageDays = Math.max(0, Math.floor((input.nowMs - input.mtimeMs) / DAY_MS));
  const relations = input.relations ?? [];
  const supersededEdge = relations.find((r) => r.relation === SUPERSEDED_RELATION);
  // Belief lifecycle suite (A4): carry a pointer to the replacement so a
  // superseded recall hit tells the agent what replaced it.
  const replacement = supersededEdge && supersededEdge.target !== "" ? supersededEdge.target : null;
  return Object.freeze({
    age_days: ageDays,
    superseded: hasSupersededRelation(relations),
    conflict: relations.some((r) => r.relation === CONFLICT_RELATION),
    replacement,
  });
}

/**
 * Opt-in relevance rerank (Search & Recall Quality Suite): re-order an
 * already-ranked, threshold-qualified set by core textual relevance - the
 * keyword + semantic lane contributions only, ignoring the recency /
 * usage / link boosts that shaped the primary `score`. This surfaces the
 * genuinely-most-relevant hit among qualifying results, the
 * deeper-relevance ordering a threshold query expects. Deterministic and
 * stable (equal relevance preserves input order); does not mutate the
 * input array.
 */
export function rerankByRelevance(
  results: ReadonlyArray<BrainSearchResult>,
): ReadonlyArray<BrainSearchResult> {
  return results
    .map((r, i) => ({ r, i }))
    .toSorted((a, b) => coreRelevance(b.r) - coreRelevance(a.r) || a.i - b.i)
    .map((x) => x.r);
}

/** Core textual relevance: the keyword + semantic lane contributions. */
function coreRelevance(r: BrainSearchResult): number {
  return r.keywordScore + r.semanticScore;
}
