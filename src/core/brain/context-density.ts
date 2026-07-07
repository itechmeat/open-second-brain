/**
 * Value-per-token density scoring for context-pack candidates
 * (impact-per-token allocation, t_affa3bd9).
 *
 * As a vault grows, a tier + recency ordering fills a fixed token
 * budget with recent-but-low-value pages and skips denser high-signal
 * ones (`pagesSkipped` overflow of important content). This module
 * computes a deterministic, no-LLM "impact per estimated token" score
 * from structural signals ALREADY on a candidate - grounding evidence,
 * internal connectivity, and epistemic status - so the pack can rank
 * the densest signal first WITHIN a tier without a language-specific
 * wordlist or a model judgement.
 *
 * Language-agnostic by construction: every signal is a structural count
 * (wikilink markers, evidence-ref count) or a fixed epistemic token,
 * never natural-language vocabulary - the same approach as
 * `deriveEpistemicStatus`.
 *
 * Pure and deterministic: the same inputs always yield the same score,
 * so a density-ranked pack stays reproducible across runs.
 */

import { EPISTEMIC_STATUS, type EpistemicStatus } from "./provenance/epistemic.ts";

/** The structural signals a density score reads off a candidate. */
export interface DensitySignalSource {
  /** Surfaced body (post-safety), scanned for internal wikilink markers. */
  readonly body: string;
  /** `evidenced_by` wikilinks grounding the page; each is a grounding signal. */
  readonly evidenceRefs: ReadonlyArray<string>;
  /** Epistemic grounding of the page (observed → unknown). */
  readonly epistemic: EpistemicStatus;
}

/**
 * Epistemic grounding weight, most-grounded first. A source-backed fact
 * carries more signal per token than an unconfirmed conjecture; a
 * contested/unknown page carries none. A fixed structural token set,
 * never natural-language vocabulary.
 */
const EPISTEMIC_WEIGHT: Readonly<Record<EpistemicStatus, number>> = Object.freeze({
  [EPISTEMIC_STATUS.observed]: 3,
  [EPISTEMIC_STATUS.derived]: 2,
  [EPISTEMIC_STATUS.hypothesis]: 1,
  [EPISTEMIC_STATUS.plan]: 1,
  [EPISTEMIC_STATUS.unknown]: 0,
});

/** Signal weight per cited evidence link (grounding). */
const EVIDENCE_WEIGHT = 2;
/** Signal weight per internal `[[wikilink]]` in the body (connectivity). */
const LINK_WEIGHT = 1;

const WIKILINK = /\[\[[^\]]+\]\]/g;

/**
 * Count `[[...]]` wikilink markers in a body. Structural marker match
 * only - no vocabulary, so it counts links in any script.
 */
export function countWikilinks(body: string): number {
  const matches = body.match(WIKILINK);
  return matches ? matches.length : 0;
}

/**
 * Aggregate structural signal for a candidate: grounding evidence,
 * internal connectivity, and epistemic weight. Never negative; a bare,
 * link-less, contested page scores 0.
 */
export function signalWeight(source: DensitySignalSource): number {
  const evidence = source.evidenceRefs.length * EVIDENCE_WEIGHT;
  const links = countWikilinks(source.body) * LINK_WEIGHT;
  const epistemic = EPISTEMIC_WEIGHT[source.epistemic] ?? 0;
  return evidence + links + epistemic;
}

/**
 * Value-per-token density: structural signal divided by the estimated
 * token cost of the body. Higher means more useful signal packed into
 * fewer tokens. `tokens <= 0` (or non-finite) yields 0 - a body that
 * costs nothing to emit cannot displace a real one on density grounds.
 */
export function densityScore(source: DensitySignalSource, tokens: number): number {
  if (!Number.isFinite(tokens) || tokens <= 0) return 0;
  return signalWeight(source) / tokens;
}
