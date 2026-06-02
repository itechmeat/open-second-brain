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
 * longest - and a one-line notice points the agent at `brain_context`
 * for the full view.
 *
 * Pure and deterministic; the hook stays a thin IO shell.
 */

import { applySectionBudget, type BudgetSection } from "./text/text-budget.ts";

export const ACTIVE_TRUNCATION_NOTICE =
  "_Injection truncated to budget. Call `brain_context` (or read `Brain/active.md`) for the full preference set._";

/**
 * Drop priority per known section heading; lower survives longer.
 * The preamble (everything before the first `## `) shares priority 0
 * with Confirmed. Unknown future sections sit between most-applied
 * and quarantine.
 */
const SECTION_PRIORITIES: ReadonlyArray<{ readonly prefix: string; readonly priority: number }> = [
  { prefix: "## Confirmed", priority: 0 },
  { prefix: "## Most-applied", priority: 1 },
  { prefix: "## Quarantine", priority: 3 },
  { prefix: "## Recently retired", priority: 4 },
];

const UNKNOWN_SECTION_PRIORITY = 2;

function priorityFor(heading: string): number {
  for (const { prefix, priority } of SECTION_PRIORITIES) {
    if (heading.startsWith(prefix)) return priority;
  }
  return UNKNOWN_SECTION_PRIORITY;
}

/**
 * Split a rendered active.md body into `## `-delimited sections,
 * keeping the preamble attached to the front of the first slice.
 */
function splitSections(body: string): BudgetSection[] {
  const lines = body.split("\n");
  const sections: BudgetSection[] = [];
  let currentKey = "preamble";
  let currentPriority = 0;
  let buffer: string[] = [];

  const flush = (): void => {
    // Trim the trailing blank separator off each slice; the budget
    // core re-joins sections with a blank line.
    while (buffer.length > 0 && buffer[buffer.length - 1] === "") buffer.pop();
    if (buffer.length === 0) return;
    sections.push({
      key: `${sections.length}:${currentKey}`,
      priority: currentPriority,
      text: buffer.join("\n"),
    });
    buffer = [];
  };

  for (const line of lines) {
    if (line.startsWith("## ")) {
      // The preamble merges into the first heading's section so the
      // document title can never be dropped ahead of its content.
      if (currentKey !== "preamble" || priorityFor(line) !== 0) flush();
      if (currentKey === "preamble" && priorityFor(line) === 0) {
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
    notice: ACTIVE_TRUNCATION_NOTICE,
  });
  return result.body;
}
