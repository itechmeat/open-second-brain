/**
 * Concept-gap detector (F2).
 *
 * Counts how many distinct corpus entries (document frequency) each
 * token appears in, then reports tokens that recur at or above
 * `minFrequency` but are not covered by any preference topic. A token
 * is "covered" when it appears in the tokenised form of some preference
 * topic slug - i.e. a dedicated preference already owns that concept.
 *
 * Frequency-only and language-agnostic: recurrence is the entire
 * signal, the tokeniser is the shared codepoint-shape splitter, and
 * there is no stopword or vocabulary list. Pure and deterministic.
 */

import { tokenise } from "../similarity.ts";

export interface ConceptGapFinding {
  readonly term: string;
  /** Number of distinct corpus entries the term appears in. */
  readonly frequency: number;
}

export interface DetectConceptGapsOptions {
  /** Minimum document frequency for a term to count as recurring. */
  readonly minFrequency: number;
}

/**
 * Detect recurring tokens with no covering preference topic.
 *
 * @param principles corpus entries (signal + preference principle text)
 * @param coveredTopics preference topic slugs that already own a concept
 */
export function detectConceptGaps(
  principles: ReadonlyArray<string>,
  coveredTopics: ReadonlyArray<string>,
  opts: DetectConceptGapsOptions,
): ConceptGapFinding[] {
  // Topic slugs are kebab/snake-cased ("kanban-grooming"); the shared
  // tokeniser keeps `-`/`_` inside tokens, so split slug separators
  // into whitespace first to match prose tokens like "kanban".
  const covered = new Set<string>();
  for (const topic of coveredTopics) {
    for (const t of tokenise(topic.replace(/[-_]+/gu, " "))) covered.add(t);
  }

  const docFreq = new Map<string, number>();
  for (const principle of principles) {
    // tokenise already returns a unique set, so each token is counted
    // at most once per corpus entry (document frequency, not raw count).
    for (const token of tokenise(principle)) {
      docFreq.set(token, (docFreq.get(token) ?? 0) + 1);
    }
  }

  const out: ConceptGapFinding[] = [];
  for (const [term, frequency] of docFreq) {
    if (frequency < opts.minFrequency) continue;
    if (covered.has(term)) continue;
    out.push({ term, frequency });
  }
  out.sort((a, b) => b.frequency - a.frequency || a.term.localeCompare(b.term));
  return out;
}
