/**
 * Concept-gap detector (F2).
 *
 * Counts how many distinct corpus entries (document frequency) each
 * *entity* appears in, then reports entities that recur at or above
 * `minFrequency` but are not covered by any preference topic. Entities
 * come from the shared language-agnostic extractor (proper-noun-ish
 * anchors: capitalized runs, CamelCase, ALLCAPS, wikilinks, quoted
 * spans) - so lowercase function words like "the" or "use" never reach
 * the result without needing a stopword list. An entity is "covered"
 * when every word of it appears in some preference topic slug.
 *
 * Frequency + structure only, no vocabulary list. Pure and deterministic.
 */

import { extractEntities } from "../../search/entities.ts";
import { tokenise } from "../similarity.ts";
import { parseIsoUtc } from "./iso-time.ts";

export interface ConceptGapFinding {
  readonly term: string;
  /** Number of distinct corpus entries the entity appears in. */
  readonly frequency: number;
}

export interface DetectConceptGapsOptions {
  /** Minimum document frequency for an entity to count as recurring. */
  readonly minFrequency: number;
}

/**
 * Detect recurring entities with no covering preference topic.
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
  // into whitespace first to match entity words like "kanban".
  const covered = new Set<string>();
  for (const topic of coveredTopics) {
    for (const t of tokenise(topic.replace(/[-_]+/gu, " "))) covered.add(t);
  }
  const isCovered = (term: string): boolean => term.split(/\s+/u).every((w) => covered.has(w));

  const docFreq = new Map<string, number>();
  for (const principle of principles) {
    // extractEntities dedupes within a single text, so each entity is
    // counted at most once per corpus entry (document frequency).
    for (const entity of extractEntities(principle)) {
      docFreq.set(entity, (docFreq.get(entity) ?? 0) + 1);
    }
  }

  const out: ConceptGapFinding[] = [];
  for (const [term, frequency] of docFreq) {
    if (frequency < opts.minFrequency) continue;
    if (isCovered(term)) continue;
    out.push({ term, frequency });
  }
  out.sort((a, b) => b.frequency - a.frequency || a.term.localeCompare(b.term));
  return out;
}

/**
 * For each entity, the newest authored date (in epoch ms) among the
 * corpus entries that mention it. Uses the same entity extraction as
 * {@link detectConceptGaps}, so the keys line up with finding terms.
 *
 * An entry whose date is `null`, missing (a shorter `dates` array), or
 * unparseable contributes `Infinity` - deliberately treating an undated
 * mention as newer than any watermark, so a gap can only ever be
 * suppressed when EVERY entry mentioning it is provably older. Used by
 * the reconcile baseline filter, never by detection itself.
 */
export function latestEntryMsByTerm(
  principles: ReadonlyArray<string>,
  dates: ReadonlyArray<string | null> | undefined,
): Map<string, number> {
  const out = new Map<string, number>();
  for (let index = 0; index < principles.length; index++) {
    const rawDate = dates?.[index] ?? null;
    const parsed = rawDate === null ? Number.NaN : parseIsoUtc(rawDate);
    const entryMs = Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
    for (const entity of extractEntities(principles[index]!)) {
      const prior = out.get(entity);
      if (prior === undefined || entryMs > prior) out.set(entity, entryMs);
    }
  }
  return out;
}
