/**
 * Injection budget for the rendered `Brain/active.md` body
 * (token-diet, t_40eb1de7 part 2).
 *
 * The SessionStart hook injects the file verbatim; on a vault with a
 * large preference set that preamble grows without bound. This module
 * fits the body into a character budget through the shared
 * section-aware truncation core, in a deterministic ladder:
 *
 *   1. HEADLINE TIER - sections below the keep-guard priority holding
 *      more bullets than {@link HEADLINE_TIER_TOP_ITEMS} are compacted
 *      to their heading, their non-bullet lead-ins and the top-N ranked
 *      bullets, ranked by the inline tags. Applied only on an
 *      over-budget body, before the budget pass, so a within-budget
 *      body passes through byte-identical.
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
    `characters.${dropped} Call \`brain_context\` (or read \`Brain/active.md\`) ` +
    "for the full preference set._"
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
 * stays valid); over budget the headline tier runs first (sections
 * below the keep-guard priority compact to their top
 * {@link HEADLINE_TIER_TOP_ITEMS} ranked bullets), then the section
 * drop order is deterministic.
 *
 * When tiering fired, the reduction is never silent: the tier notice
 * rides alone when tiering alone brought the body within budget, and a
 * "headlines kept" clause joins the drop notice otherwise.
 */
export function budgetActiveBody(body: string, budgetChars: number): string {
  if (body.length <= budgetChars) return body;
  const ladder = applyHeadlineTiers(splitSections(body), budgetChars);
  const tieredLabels = ladder.tieredKeys.map(sectionLabel);
  if (tieredLabels.length > 0 && joinedSectionsLength(ladder.sections) <= budgetChars) {
    // Tiering alone brought the body within budget: nothing was
    // dropped, but the body the consumer sees is no longer the body the
    // vault holds. Say so through the tier notice, mirroring the drop
    // notice's shape so a reduction is never silent.
    return joinSections(ladder.sections) + SECTION_SEPARATOR + activeTierNotice(tieredLabels);
  }
  const result = applySectionBudget(ladder.sections, budgetChars, {
    notice:
      tieredLabels.length > 0
        ? (report) => `${activeTruncationNotice(report)} ${tierNoticeClause(tieredLabels)}`
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
const TIER_NOTICE_POINTER =
  ". Call `brain_context` (or read `Brain/active.md`) for the full preference set._";

/**
 * Wording of the "headlines kept" clause appended to the drop notice
 * when tiering fired AND sections still dropped: the consumer must be
 * able to tell a tiered, partially-kept section from an intact one.
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
 * byte-identity is the caller's contract); otherwise every non-guard
 * section holding more than `topItems` bullets is compacted by
 * {@link tierSection}.
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
  const out: BudgetSection[] = [];
  const tieredKeys: string[] = [];
  for (const section of sections) {
    const step = tierSection(section, topItems);
    if (step.tiered) tieredKeys.push(section.key);
    out.push(step.section);
  }
  return { sections: out, tieredKeys };
}
