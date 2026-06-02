/**
 * Section-aware character budget (token-diet).
 *
 * Generalizes the head-budget idea from `pre-compress-pack.ts` /
 * `recall-budget.ts` to whole document sections: the caller hands an
 * ordered list of sections (render order) with a drop priority, and
 * the budget pass returns a body that fits the character budget by
 *
 *   1. dropping whole sections, least important first;
 *   2. when the remainder still overflows, trimming the least
 *      important kept section from its tail at LINE boundaries -
 *      never mid-line, so the output is always well-formed Markdown;
 *   3. appending an optional one-line truncation notice that rides
 *      on top of the budget (it is the pointer to the full view, so
 *      it must survive even a zero budget).
 *
 * Pure and deterministic: no I/O, clock, or randomness. Identical
 * inputs produce identical outputs - the property the active.md
 * idempotent-write check depends on.
 */

export interface BudgetSection {
  /** Stable identifier reported in `droppedKeys`. */
  readonly key: string;
  /**
   * Drop priority: LOWER value = more important. Sections with the
   * highest value drop first; ties drop the later section first.
   */
  readonly priority: number;
  /** Rendered section text, headers included. */
  readonly text: string;
}

export interface SectionBudgetOptions {
  /**
   * One-line notice appended (after a blank-line separator when any
   * content is kept) whenever truncation occurred. Not counted
   * against the budget.
   */
  readonly notice?: string;
}

export interface SectionBudgetResult {
  /** Budgeted body: kept sections in render order, plus the notice when truncated. */
  readonly body: string;
  /** True when any section was dropped or trimmed. */
  readonly truncated: boolean;
  /** Keys of fully dropped sections, in drop order. */
  readonly droppedKeys: ReadonlyArray<string>;
}

const SEPARATOR = "\n\n";

interface KeptSection extends BudgetSection {
  /** Position in the caller's render order. */
  readonly index: number;
}

function joinedLength(parts: ReadonlyArray<{ readonly text: string }>): number {
  if (parts.length === 0) return 0;
  let total = SEPARATOR.length * (parts.length - 1);
  for (const p of parts) total += p.text.length;
  return total;
}

/** Index of the least important kept section: max priority, ties -> later index. */
function leastImportantIndex(kept: ReadonlyArray<KeptSection>): number {
  let at = -1;
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i]!;
    if (at === -1) {
      at = i;
      continue;
    }
    const cur = kept[at]!;
    if (s.priority > cur.priority || (s.priority === cur.priority && s.index > cur.index)) {
      at = i;
    }
  }
  return at;
}

/**
 * Trim `text` from the tail at line boundaries so the result fits
 * `maxChars`. Trailing blank lines left behind by the cut are removed.
 * Returns null when not even the first line fits.
 */
function trimToLines(text: string, maxChars: number): string | null {
  if (text.length <= maxChars) return text;
  const lines = text.split("\n");
  while (lines.length > 0) {
    lines.pop();
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    const candidate = lines.join("\n");
    if (candidate.length === 0) return null;
    if (candidate.length <= maxChars) return candidate;
  }
  return null;
}

/**
 * Fit ordered sections into `budgetChars`. See the module docblock for
 * the drop/trim policy. A non-positive budget keeps nothing - the
 * result is the notice alone (or an empty body without one).
 */
export function applySectionBudget(
  sections: ReadonlyArray<BudgetSection>,
  budgetChars: number,
  opts: SectionBudgetOptions = {},
): SectionBudgetResult {
  const budget = Number.isFinite(budgetChars) ? Math.max(0, Math.floor(budgetChars)) : 0;
  const kept: KeptSection[] = sections.map((s, index) => ({ ...s, index }));
  const droppedKeys: string[] = [];
  let trimmedAny = false;

  // 1. Whole-section drops, least important first. Intermediate
  // sections are never partially kept - a half section with its header
  // reads as complete and would mislead the consumer.
  while (kept.length > 1 && joinedLength(kept) > budget) {
    const at = leastImportantIndex(kept);
    droppedKeys.push(kept[at]!.key);
    kept.splice(at, 1);
  }

  // 2. Last resort: only the single most important section remains and
  // still overflows - trim its tail at line boundaries; drop it when
  // not even its first line fits.
  if (kept.length === 1 && joinedLength(kept) > budget) {
    const last = kept[0]!;
    const trimmed = trimToLines(last.text, budget);
    if (trimmed === null) {
      droppedKeys.push(last.key);
      kept.splice(0, 1);
    } else {
      kept[0] = { ...last, text: trimmed };
      trimmedAny = true;
    }
  }

  const truncated = trimmedAny || droppedKeys.length > 0;
  const content = kept
    .toSorted((a, b) => a.index - b.index)
    .map((s) => s.text)
    .join(SEPARATOR);

  let body = content;
  if (truncated && opts.notice !== undefined && opts.notice.length > 0) {
    body = content.length > 0 ? content + SEPARATOR + opts.notice : opts.notice;
  }

  return Object.freeze({
    body,
    truncated,
    droppedKeys: Object.freeze(droppedKeys),
  });
}
