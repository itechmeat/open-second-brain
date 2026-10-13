/**
 * Skill auto-attach (Agent Surface Suite, t_10b86707).
 *
 * Deterministic per-turn skill relevance: score discovered skills
 * against the current turn text with the shared lexical scorer and
 * render a small Markdown block of the top matches. No LLM in the
 * loop; the same query, skill set and usage input always produce the
 * same block. The char budget drops whole trailing entries - a
 * half-rendered skill line would read as a different skill.
 *
 * Ranking is the scorer's by default. When the caller supplies a usage
 * weight map (t_5d1ec8a8), candidates near the top are reordered by a
 * bounded composite of lexical score and observed invocation weight
 * (see {@link SKILL_USAGE_ORDERING_MAX_BOOST}); with the input absent
 * the output is byte-identical to the scorer's order, so existing
 * callers are untouched.
 *
 * Two properties were added in t_ccb05134:
 *
 *   - A discriminating-term floor. BM25 already down-weights a term the
 *     whole corpus carries, but down-weighted is not dropped: a candidate
 *     whose ENTIRE match is such terms still outscores nothing and still
 *     gets offered. It should not be. See
 *     {@link DISCRIMINATING_TERM_CORPUS_SHARE}.
 *   - An offer identity. The block cites the id of the offer it renders, so
 *     an agent invoking one of these skills can quote it back and the
 *     invocation becomes joinable to the offer. See `./skill-offer.ts`.
 */

import { isRareTerm } from "../search/coverage.ts";
import { skillDescriptors } from "./descriptor.ts";
import { scoreDescriptors, type ScoredDescriptor } from "./lexical-score.ts";
import { computeSkillOfferId, SKILL_OFFER_ID_KEY, SKILL_OFFER_ID_LENGTH } from "./skill-offer.ts";
import type { SkillEntry } from "./skills.ts";

export interface SkillAttachItem {
  readonly name: string;
  readonly description: string;
  readonly path: string;
  readonly score: number;
}

export interface SkillAttachment {
  /** Markdown block ("## Relevant skills" + bullets), "" when empty. */
  readonly block: string;
  readonly items: ReadonlyArray<SkillAttachItem>;
  /**
   * Content-addressed id of this offer, or null when nothing was offered.
   * Null is not a failure: an offer that was never made has no identity,
   * and inventing one would put an unbacked id into the join.
   */
  readonly offerId: string | null;
}

export interface BuildSkillAttachmentOptions {
  /** Current turn text to score against. */
  readonly query: string;
  readonly skills: ReadonlyArray<SkillEntry>;
  /** Maximum skills to attach. Default 3. */
  readonly maxSkills?: number;
  /** Char budget for the rendered block. Default 1200. */
  readonly maxChars?: number;
  /**
   * When set, the `triggers` field from each skill's frontmatter is
   * included in the lexical scorer as a 2x-BM25 tag signal. Default
   * false (name 3x + description 1x only).
   */
  readonly includeTriggers?: boolean;
  /**
   * Observed usage weight per discovered skill name, from
   * `skillUsageRankingWeights` (`../brain/skill-usage.ts`) - the ranking
   * weight, which normalises frequency against the largest joined count
   * and so does not saturate the way the decay weight `deriveSkillUsage`
   * reports does. When set and
   * non-empty, candidates near the top are reordered by
   * {@link SKILL_USAGE_ORDERING_MAX_BOOST}-bounded composite instead of
   * raw lexical score. Absent or empty keeps the scorer's order
   * (default off); the `score` field of every item stays the lexical
   * score either way, and the floor is never crossable by weight.
   */
  readonly usageWeight?: ReadonlyMap<string, number>;
}

export const DEFAULT_MAX_SKILLS = 3;
export const DEFAULT_MAX_CHARS = 1200;
const BLOCK_HEADER = "## Relevant skills";
const OFFER_LINE_PREFIX = "Offer ";
const OFFER_LINE_SUFFIX = ` - cite it as ${SKILL_OFFER_ID_KEY} when calling get_skill.`;
/**
 * Chars the offer line costs: a fixed-width id between two literals, plus
 * the blank line separating it from the bullets. Fixed width is why the
 * budget can reserve it before the id exists, without a second pass.
 */
const OFFER_LINE_BUDGET =
  OFFER_LINE_PREFIX.length + SKILL_OFFER_ID_LENGTH + OFFER_LINE_SUFFIX.length + 2;

/**
 * Share of the descriptor corpus a query term may appear in and still
 * discriminate between its members.
 *
 * A term more than half the descriptors carry cannot separate them: nearly
 * every candidate matches it, so it is evidence for none of them in
 * particular. A candidate whose entire match rests on such terms has not
 * been shown to be relevant to this turn and is dropped rather than offered.
 *
 * The only input is corpus document frequency, so the rule holds in any
 * language and there is no vocabulary list anywhere in its derivation - the
 * standing project position, and the reason the vault-side coverage engine
 * this shares {@link isRareTerm} with carries no stopword list either.
 *
 * The one-document floor inside `isRareTerm` matters here: a single-skill
 * corpus has df = the whole corpus for every term, so the floor makes the
 * rule abstain rather than drop the only candidate on no evidence.
 */
export const DISCRIMINATING_TERM_CORPUS_SHARE = 0.5;

/**
 * Largest multiplicative gain a usage weight may add to a candidate's
 * lexical score when the attach ordering runs with a usage map
 * (t_5d1ec8a8): the composite is
 * `score * (1 + SKILL_USAGE_ORDERING_MAX_BOOST * weight)` with weights in
 * (0, 1], so a candidate rises by at most half again its own lexical
 * score. Relevance stays primary - a wide lexical gap is never closed by
 * usage, only the near-ties the scorer cannot see break toward the skill
 * an agent actually invokes. The floor applies before the composite, so
 * no weight resurrects a non-discriminating candidate; the reported
 * `score` stays the untouched lexical score.
 */
export const SKILL_USAGE_ORDERING_MAX_BOOST = 0.5;

/**
 * Whether at least one term this candidate matched separates it from the
 * rest of the corpus.
 */
function hasDiscriminatingMatch(scored: ScoredDescriptor, corpusSize: number): boolean {
  return scored.matched.some((m) => isRareTerm(m.df, corpusSize, DISCRIMINATING_TERM_CORPUS_SHARE));
}

function renderLine(item: SkillAttachItem): string {
  return `- ${item.name} - ${item.description} (load with get_skill: ${item.name})`;
}

function emptyAttachment(): SkillAttachment {
  return Object.freeze({ block: "", items: Object.freeze([]), offerId: null });
}

/**
 * The BM25 ranking with the discriminating-term floor, cut at `limit`.
 * `buildSkillAttachment` offers the first `maxSkills` of it; the optional
 * decision-model selection (`./skill-attach-decision.ts`) reads a longer
 * shortlist from the same ranking and never adds anything outside it.
 */
export function rankSkillCandidates(
  opts: Pick<BuildSkillAttachmentOptions, "query" | "skills" | "includeTriggers" | "usageWeight">,
  limit: number,
): SkillAttachItem[] {
  const byName = new Map(opts.skills.map((s) => [s.name, s]));
  const descriptors = skillDescriptors(opts.skills, opts.includeTriggers);
  const surviving = scoreDescriptors(opts.query, descriptors)
    // The floor filters, it never reorders, and no usage weight crosses it:
    // a candidate dropped here stays dropped. Without a usage map ranking
    // stays the scorer's; with one, the bounded composite below reorders
    // the survivors.
    .filter((scored) => hasDiscriminatingMatch(scored, descriptors.length));
  const usageWeight = opts.usageWeight;
  const ranked =
    usageWeight === undefined
      ? surviving.slice(0, limit)
      : surviving
          .map((scored) => ({
            scored,
            // Missing name means no observed invocation: weight 0, which
            // leaves the composite at the lexical score.
            composite:
              scored.score *
              (1 + SKILL_USAGE_ORDERING_MAX_BOOST * (usageWeight.get(scored.descriptor.name) ?? 0)),
          }))
          .toSorted(
            (a, b) =>
              b.composite - a.composite ||
              (a.scored.descriptor.name < b.scored.descriptor.name
                ? -1
                : a.scored.descriptor.name > b.scored.descriptor.name
                  ? 1
                  : 0),
          )
          .slice(0, limit)
          .map((entry) => entry.scored);
  const items: SkillAttachItem[] = [];
  for (const { descriptor, score } of ranked) {
    const skill = byName.get(descriptor.name);
    if (skill === undefined) continue;
    items.push(
      Object.freeze({
        name: skill.name,
        description: skill.description,
        path: skill.path,
        score,
      }),
    );
  }
  return items;
}

/**
 * Render ranked items into the attach block within the char budget, and
 * compute the offer id over exactly the items that fit.
 */
export function renderSkillAttachment(
  query: string,
  ranked: ReadonlyArray<SkillAttachItem>,
  maxChars: number = DEFAULT_MAX_CHARS,
): SkillAttachment {
  const items: SkillAttachItem[] = [];
  const lines: string[] = [];
  let used = BLOCK_HEADER.length + 2 + OFFER_LINE_BUDGET; // header + blank line + offer line
  for (const item of ranked) {
    const line = renderLine(item);
    if (used + line.length + 1 > maxChars) break;
    used += line.length + 1;
    items.push(item);
    lines.push(line);
  }

  if (items.length === 0) return emptyAttachment();
  const offerId = computeSkillOfferId(
    query,
    items.map((item) => ({ name: item.name, path: item.path })),
  );
  return Object.freeze({
    block: `${BLOCK_HEADER}\n\n${lines.join("\n")}\n\n${OFFER_LINE_PREFIX}${offerId}${OFFER_LINE_SUFFIX}`,
    items: Object.freeze(items),
    offerId,
  });
}

export function buildSkillAttachment(opts: BuildSkillAttachmentOptions): SkillAttachment {
  const maxSkills = opts.maxSkills ?? DEFAULT_MAX_SKILLS;
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  return renderSkillAttachment(opts.query, rankSkillCandidates(opts, maxSkills), maxChars);
}
