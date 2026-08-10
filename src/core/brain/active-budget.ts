/**
 * Injection budget for the rendered `Brain/active.md` body
 * (token-diet, t_40eb1de7 part 2).
 *
 * The SessionStart hook injects the file verbatim; on a vault with a
 * large preference set that preamble grows without bound. This module
 * fits the body into a character budget through the shared
 * section-aware truncation core: sections drop in fixed priority
 * order - recently retired first, then quarantine, then most-applied,
 * with the confirmed rules (and the document preamble) surviving
 * longest - and a one-line notice names the sections that went, says
 * how many characters survived out of how many, and points the agent at
 * `brain_context` for the full view.
 *
 * Pure and deterministic; the hook stays a thin IO shell.
 */

import {
  applySectionBudget,
  type BudgetSection,
  type SectionTruncationReport,
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
 * stays valid); over budget the section drop order is deterministic.
 */
export function budgetActiveBody(body: string, budgetChars: number): string {
  if (body.length <= budgetChars) return body;
  const result = applySectionBudget(splitSections(body), budgetChars, {
    notice: activeTruncationNotice,
  });
  return result.body;
}
