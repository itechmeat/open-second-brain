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
