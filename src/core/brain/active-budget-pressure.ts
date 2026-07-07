/**
 * Proactive active-memory budget-pressure watermark
 * (context-pack-economics-observability, C4 / t_dfda8adb).
 *
 * `Brain/active.md` is enforced REACTIVELY: `active-budget.ts` drops
 * sections at render/inject time once the body overflows the byte
 * budget, and prints a one-line truncation notice. Nothing warns the
 * operator BEFORE the wall - content simply disappears from the
 * injection.
 *
 * This module adds the missing PROACTIVE signal. It measures how full
 * the active body is against its byte budget (a "water level" /
 * fill-rate), classifies it into a health status, and - only when
 * pressure crosses the warn threshold - names the specific sections an
 * operator could archive to relieve it. The eviction candidates reuse
 * the exact drop order the reactive truncation uses
 * (`SECTION_PRIORITIES` from `active-budget.ts`), so the advance
 * warning matches what would actually be dropped.
 *
 * Contract:
 *   - **Empty output = healthy.** At or below the warn threshold the
 *     status is `healthy` and `candidates` is empty; the doctor/hygiene
 *     surfaces stay quiet on healthy vaults.
 *   - **Keep-guard.** Priority-0 content (the document preamble and the
 *     Confirmed rules) is a live rule/config the probe never proposes
 *     for eviction - only pure stale history (retired, quarantine,
 *     most-applied, unknown future sections) is a candidate.
 *   - **Suggestions only.** Candidates are surfaced to the operator /
 *     dream; nothing here mutates the vault or auto-archives anything.
 *   - **Pure and deterministic.** Byte/section counting, no LLM, no
 *     clock, no I/O. Identical inputs produce identical output.
 *
 * NOTE: "active budget pressure" is deliberately distinct from the
 * unrelated last-processed-cursor state in `skill-proposals.ts` - same
 * English word ("watermark"), different concept. This module never
 * reuses that identifier.
 */

import { KEEP_GUARD_PRIORITY, priorityFor, splitSections } from "./active-budget.ts";

/**
 * Fill-rate at or below this is `healthy` (quiet). Between this and
 * {@link CRITICAL_THRESHOLD} is `elevated`; at or above the critical
 * threshold is `critical`. Owned here, not derived from any
 * pre-existing symbol.
 */
export const ELEVATED_THRESHOLD = 0.75;
export const CRITICAL_THRESHOLD = 0.9;

export type BudgetPressureStatus = "healthy" | "elevated" | "critical";

/**
 * One section an operator could archive to relieve pressure, ranked in
 * the order the reactive truncation would drop it (highest-priority-to-
 * drop first). `sectionKey` is the section's `## ` heading (or
 * `"preamble"` for the leading block, which never appears as a
 * candidate since it shares the keep-guard priority).
 */
export interface EvictionCandidate {
  readonly sectionKey: string;
  /** Byte length of the section text. */
  readonly bytes: number;
  /** Drop priority (higher drops first); always > {@link KEEP_GUARD_PRIORITY}. */
  readonly priority: number;
}

export interface ActiveBudgetPressure {
  /** `body.length / budgetChars`, clamped at 0 for a non-positive budget. */
  readonly fillRate: number;
  readonly status: BudgetPressureStatus;
  /** Byte length of the measured body. */
  readonly bytes: number;
  /** The budget the body was measured against. */
  readonly budgetChars: number;
  /**
   * Ranked eviction candidates, highest-priority-to-drop first. Empty
   * when the status is `healthy` (empty output = healthy) or when the
   * body has no droppable (non-keep-guard) sections.
   */
  readonly candidates: ReadonlyArray<EvictionCandidate>;
}

/** First `## ` heading of a section slice, or `"preamble"`. */
function sectionHeading(text: string): string {
  const firstLine = text.slice(0, text.indexOf("\n") === -1 ? undefined : text.indexOf("\n"));
  return firstLine.startsWith("## ") ? firstLine : "preamble";
}

function statusFor(fillRate: number): BudgetPressureStatus {
  if (fillRate >= CRITICAL_THRESHOLD) return "critical";
  if (fillRate > ELEVATED_THRESHOLD) return "elevated";
  return "healthy";
}

/**
 * Measure `body` against `budgetChars` and, when pressure crosses the
 * warn threshold, return the sections an operator could archive to
 * relieve it. See the module docblock for the full contract.
 *
 * A non-positive or non-finite budget is treated as fully saturated
 * (`fillRate` of `Infinity`, `critical`): a zero budget means every
 * byte overflows.
 */
export function computeActiveBudgetPressure(
  body: string,
  budgetChars: number,
): ActiveBudgetPressure {
  const bytes = body.length;
  const budget = Number.isFinite(budgetChars) ? budgetChars : 0;
  const fillRate = budget > 0 ? bytes / budget : bytes > 0 ? Infinity : 0;
  const status = statusFor(fillRate);

  // Empty output = healthy: no candidates unless pressure is real.
  if (status === "healthy") {
    return Object.freeze({
      fillRate,
      status,
      bytes,
      budgetChars: budget,
      candidates: Object.freeze([]),
    });
  }

  const sections = splitSections(body);
  const candidates: Array<EvictionCandidate & { readonly index: number }> = [];
  sections.forEach((section, index) => {
    const heading = sectionHeading(section.text);
    // `splitSections` assigns the preamble/first-heading slice priority
    // 0; re-derive from the heading so the classification is explicit
    // and robust to the merged-preamble slice.
    const priority = heading === "preamble" ? KEEP_GUARD_PRIORITY : priorityFor(heading);
    if (priority <= KEEP_GUARD_PRIORITY) return; // keep-guard: live rule/config
    candidates.push({ sectionKey: heading, bytes: section.text.length, priority, index });
  });

  // Rank in the exact reactive drop order: highest priority first,
  // ties broken by later render position first (matches
  // `leastImportantIndex` in text-budget.ts).
  candidates.sort((a, b) => b.priority - a.priority || b.index - a.index);

  return Object.freeze({
    fillRate,
    status,
    bytes,
    budgetChars: budget,
    candidates: Object.freeze(
      candidates.map(({ sectionKey, bytes: b, priority }) => ({ sectionKey, bytes: b, priority })),
    ),
  });
}
