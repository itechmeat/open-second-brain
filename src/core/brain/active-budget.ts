/**
 * Injection budget for the rendered `Brain/active.md` body
 * (token-diet, t_40eb1de7 part 2).
 *
 * The SessionStart hook injects the file verbatim; on a vault with a
 * large preference set that preamble grows without bound. This module
 * fits the body into a character budget through the shared
 * section-aware truncation core, in a deterministic ladder:
 *
 *   1. HEADLINE TIER - on an over-budget body, sections below the
 *      keep-guard priority holding more bullets than
 *      {@link HEADLINE_TIER_TOP_ITEMS} are compacted to their heading,
 *      their non-bullet lead-ins and the top-N ranked bullets, ranked by
 *      the inline tags. Compaction runs SEQUENTIALLY in the drop order,
 *      least important section first, stopping as soon as the body fits
 *      - a small overflow costs the least valuable section a few
 *      bullets instead of stripping every non-guard section at once.
 *   2. Whole-section drops, in fixed priority order - recently retired
 *      first, then quarantine, then most-applied, with the confirmed
 *      rules (and the document preamble) surviving longest.
 *   3. A one-line notice names what happened: the sections that went,
 *      the headlines kept when tiering fired, how many characters
 *      survived out of how many, and the pointer to `brain_context`
 *      for the full view. When tiering alone brought the body within
 *      budget, the tier notice rides alone - a reduction is never
 *      silent.
 *
 * Pure and deterministic; the hook stays a thin IO shell.
 */

import {
  applySectionBudget,
  type BudgetSection,
  joinSections,
  joinedSectionsLength,
  type SectionTruncationReport,
  SECTION_SEPARATOR,
  splitSectionBullets,
  topItemLines,
} from "./text/text-budget.ts";

/**
 * Separator between a section's ordinal and its heading inside a budget
 * key. The ordinal keeps keys unique when a vault renders two sections
 * with the same heading; the notice strips it back off, so the two sides
 * share the character rather than each spelling it.
 */
const SECTION_KEY_SEPARATOR = ":";

/** The Markdown level every active.md section heading is rendered at. */
const HEADING_PREFIX = "## ";

/** Key of the slice holding everything before the first heading. */
const PREAMBLE_KEY = "preamble";

/**
 * The shared tail of every truncation notice: the pointer from the
 * budgeted view back to the full preference set. Spelled out once so
 * the drop notice and the tier notice can never drift apart.
 */
const FULL_VIEW_POINTER =
  " Call `brain_context` (or read `Brain/active.md`) for the full preference set._";

/**
 * The truncation notice, built from the budgeter's own report.
 *
 * It used to be a fixed sentence. The budgeter has always returned the
 * list of keys it dropped, and the caller has always discarded it, so an
 * agent whose quarantine rules had just been evicted was told only that
 * "the injection was truncated" - the exact silence this release exists
 * to close. Naming the sections is safe because they are headings THIS
 * project renders, never operator or user text: no content crosses into
 * the notice, only keys and two integers.
 */
export function activeTruncationNotice(report: SectionTruncationReport): string {
  const dropped =
    report.droppedKeys.length > 0
      ? ` Dropped: ${report.droppedKeys.map(sectionLabel).join(", ")}.`
      : "";
  return (
    `_Injection truncated to budget: kept ${report.keptChars} of ${report.totalChars} ` +
    `characters.${dropped}${FULL_VIEW_POINTER}`
  );
}

/**
 * Human-readable name of a dropped section: the ordinal prefix and the
 * Markdown heading marker removed, leaving the heading as the operator
 * reads it in `Brain/active.md`.
 */
function sectionLabel(key: string): string {
  const at = key.indexOf(SECTION_KEY_SEPARATOR);
  const heading = at === -1 ? key : key.slice(at + SECTION_KEY_SEPARATOR.length);
  return heading.startsWith(HEADING_PREFIX) ? heading.slice(HEADING_PREFIX.length) : heading;
}

/**
 * Drop priority per known section heading; lower survives longer.
 * The preamble (everything before the first `## `) shares priority 0
 * with Confirmed. Unknown future sections sit between most-applied
 * and quarantine.
 *
 * Exported so the proactive budget-pressure probe
 * (`active-budget-pressure.ts`) ranks eviction candidates against the
 * exact same drop order this reactive truncation uses - the two
 * surfaces must never disagree about which section goes first.
 */
export const SECTION_PRIORITIES: ReadonlyArray<{
  readonly prefix: string;
  readonly priority: number;
}> = [
  { prefix: `${HEADING_PREFIX}Confirmed`, priority: 0 },
  { prefix: `${HEADING_PREFIX}Most-applied`, priority: 1 },
  { prefix: `${HEADING_PREFIX}Quarantine`, priority: 3 },
  { prefix: `${HEADING_PREFIX}Recently retired`, priority: 4 },
];

/**
 * Priority shared by the preamble and any priority-0 section (Confirmed).
 * A section at this priority is a live rule/config the pressure probe
 * treats as a keep-guard: it is never proposed as an eviction candidate.
 */
export const KEEP_GUARD_PRIORITY = 0;

export const UNKNOWN_SECTION_PRIORITY = 2;

export function priorityFor(heading: string): number {
  for (const { prefix, priority } of SECTION_PRIORITIES) {
    if (heading.startsWith(prefix)) return priority;
  }
  return UNKNOWN_SECTION_PRIORITY;
}

/**
 * Split a rendered active.md body into `## `-delimited sections,
 * keeping the preamble attached to the front of the first slice.
 *
 * Exported for reuse by the budget-pressure probe so both surfaces
 * split identically.
 */
export function splitSections(body: string): BudgetSection[] {
  const lines = body.split("\n");
  const sections: BudgetSection[] = [];
  let currentKey = PREAMBLE_KEY;
  let currentPriority = 0;
  let buffer: string[] = [];

  const flush = (): void => {
    // Trim the trailing blank separator off each slice; the budget
    // core re-joins sections with a blank line.
    while (buffer.length > 0 && buffer[buffer.length - 1] === "") buffer.pop();
    if (buffer.length === 0) return;
    sections.push({
      key: `${sections.length}${SECTION_KEY_SEPARATOR}${currentKey}`,
      priority: currentPriority,
      text: buffer.join("\n"),
    });
    buffer = [];
  };

  for (const line of lines) {
    if (line.startsWith(HEADING_PREFIX)) {
      // The preamble merges into the first heading's section so the
      // document title can never be dropped ahead of its content.
      if (currentKey !== PREAMBLE_KEY || priorityFor(line) !== 0) flush();
      if (currentKey === PREAMBLE_KEY && priorityFor(line) === 0) {
        currentKey = line;
        currentPriority = 0;
        buffer.push(line);
        continue;
      }
      currentKey = line;
      currentPriority = priorityFor(line);
    }
    buffer.push(line);
  }
  flush();
  return sections;
}

/**
 * Fit `body` into `budgetChars`. Within budget the input passes
 * through byte-identical (the idempotent-write comparison upstream
 * stays valid); over budget the headline tier runs first - sections
 * below the keep-guard priority compacted sequentially in the drop
 * order, least important first, only until the body fits - then the
 * section drop order is deterministic.
 *
 * When tiering fired, the reduction is never silent: the tier notice
 * rides alone when tiering alone brought the body within budget, and a
 * "headlines kept" clause joins the drop notice otherwise. The drop
 * notice's character pair quantifies the cut against the ORIGINAL
 * body, not the tiered remainder the drop pass receives.
 */
export function budgetActiveBody(body: string, budgetChars: number): string {
  if (body.length <= budgetChars) return body;
  const sections = splitSections(body);
  // The drop pass below sees the TIERED sections; the notice must
  // quantify the cut against the body the vault holds, so the original
  // join is captured before the ladder runs and overrides the report.
  const originalTotal = joinedSectionsLength(sections);
  const ladder = applyHeadlineTiers(sections, budgetChars);
  const tieredLabels = ladder.tieredKeys.map(sectionLabel);
  if (tieredLabels.length > 0 && joinedSectionsLength(ladder.sections) <= budgetChars) {
    // Tiering alone brought the body within budget: nothing was
    // dropped, but the body the consumer sees is no longer the body the
    // vault holds. Say so through the tier notice, mirroring the drop
    // notice's shape so a reduction is never silent.
    return joinSections(ladder.sections) + SECTION_SEPARATOR + activeTierNotice(tieredLabels);
  }
  const result = applySectionBudget(ladder.sections, budgetChars, {
    totalChars: originalTotal,
    notice:
      tieredLabels.length > 0
        ? (report) => {
            // Survivors only: a section tiered and THEN dropped whole is
            // already named in the Dropped list, and naming it in the
            // kept-headlines clause too made the notice contradict
            // itself. No tiered section survived - the clause stays out.
            const keptTiered = ladder.tieredKeys.filter((k) => !report.droppedKeys.includes(k));
            const clause =
              keptTiered.length > 0 ? tierNoticeClause(keptTiered.map(sectionLabel)) : "";
            return `${activeTruncationNotice(report)}${clause}`;
          }
        : activeTruncationNotice,
  });
  return result.body;
}

/**
 * Bullets a tiered section keeps: the headline tier between
 * section-intact and section-dropped. A named constant, not a config
 * key - the ladder is deterministic machinery shared with the proactive
 * pressure probe, and a second tunable surface would let the two drift
 * apart.
 */
export const HEADLINE_TIER_TOP_ITEMS = 3;

/**
 * Wording of the notice emitted when the headline tier fired and the
 * tiered body fits the budget on its own (no section dropped). Mirrors
 * the drop notice's shape - what happened, then the pointer to the full
 * view - so a reduction is never silent.
 */
const TIER_NOTICE_OPEN = "_Headlines kept to fit the injection budget: ";
const TIER_NOTICE_POINTER = `.${FULL_VIEW_POINTER}`;

/**
 * Wording of the "headlines kept" clause appended to the drop notice
 * when tiering fired AND tiered sections SURVIVED the drop pass: the
 * consumer must be able to tell a tiered, partially-kept section from
 * an intact one. A tiered section that then dropped whole is named in
 * the Dropped list alone - the clause never names it too.
 */
const TIER_CLAUSE_OPEN = " _Headlines kept in: ";
const TIER_CLAUSE_CLOSE = "._";

/**
 * The tier-alone notice: names the sections the ladder compacted, in
 * render order, and points at the full view. Labels are headings this
 * project renders, never operator text - the same safety the drop
 * notice's naming relies on.
 */
export function activeTierNotice(tieredLabels: ReadonlyArray<string>): string {
  return `${TIER_NOTICE_OPEN}${tieredLabels.join(", ")}${TIER_NOTICE_POINTER}`;
}

function tierNoticeClause(tieredLabels: ReadonlyArray<string>): string {
  return `${TIER_CLAUSE_OPEN}${tieredLabels.join(", ")}${TIER_CLAUSE_CLOSE}`;
}

/**
 * One headline-tier step: compact a section below the keep-guard
 * priority to its heading, its non-bullet lead-ins and the top
 * `topItems` ranked bullets. Sections at or below
 * {@link KEEP_GUARD_PRIORITY} (the preamble and the confirmed rules)
 * are live config and are never compacted; a section already holding at
 * most `topItems` bullets is returned untouched.
 *
 * The tiered text is a byte-prefix of the original: head lines verbatim,
 * then the surviving bullets in render order. `headLines` is set to the
 * kept non-bullet line count so a headlines-only remnant that still
 * overflows drops whole through the budgeter's existing guard instead
 * of standing there looking complete.
 *
 * Pure and deterministic. Exported for the pressure probe, which must
 * model this exact step.
 */
export function tierSection(
  section: BudgetSection,
  topItems: number = HEADLINE_TIER_TOP_ITEMS,
): { section: BudgetSection; tiered: boolean } {
  if (section.priority <= KEEP_GUARD_PRIORITY) return { section, tiered: false };
  const split = splitSectionBullets(section.text);
  if (split.itemLines.length <= topItems) return { section, tiered: false };
  const kept = topItemLines(split.itemLines, topItems);
  return {
    tiered: true,
    section: {
      ...section,
      headLines: split.headLines.length,
      text: [...split.headLines, ...kept].join("\n"),
    },
  };
}

export interface HeadlineTierResult {
  /** Sections after the ladder: tiered where applicable, order preserved. */
  readonly sections: ReadonlyArray<BudgetSection>;
  /** Keys of the sections the ladder actually compacted, in render order. */
  readonly tieredKeys: ReadonlyArray<string>;
}

/**
 * The headline tier ladder over a split body: when the sections fit
 * `budgetChars` untouched, nothing is compacted (within-budget
 * byte-identity is the caller's contract). Otherwise the ladder tiers
 * SEQUENTIALLY in the drop order - least important section first
 * (highest drop-priority number, ties to the later render position, the
 * same selection the budget pass makes) - recomputing the joined total
 * after each compaction and stopping as soon as the body fits, so a
 * five-character overflow costs the low-value section a few bullets
 * instead of stripping every non-guard section at once. Sections the
 * tier cannot compact (keep-guard, at or below the top-N) are passed
 * over; when the ladder runs out of them and the body still overflows,
 * the caller hands the tiered body to the drop pass.
 *
 * Pure and deterministic. Exported for the pressure probe, which must
 * model this exact step with the same exemptions and the same top-N.
 */
export function applyHeadlineTiers(
  sections: ReadonlyArray<BudgetSection>,
  budgetChars: number,
  topItems: number = HEADLINE_TIER_TOP_ITEMS,
): HeadlineTierResult {
  if (joinedSectionsLength(sections) <= budgetChars) return { sections, tieredKeys: [] };
  const out: BudgetSection[] = [...sections];
  const tieredAt = new Set<number>();
  const order = sections
    .map((_, index) => index)
    .toSorted((a, b) => sections[b]!.priority - sections[a]!.priority || b - a);
  for (const index of order) {
    const step = tierSection(out[index]!, topItems);
    if (!step.tiered) continue;
    out[index] = step.section;
    tieredAt.add(index);
    if (joinedSectionsLength(out) <= budgetChars) break;
  }
  // Keys in render order: the notice names the compacted sections the
  // way the body renders them, whichever order the ladder visited them.
  const tieredKeys = sections.filter((_, i) => tieredAt.has(i)).map((s) => s.key);
  return { sections: out, tieredKeys };
}
