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
 *      it must survive even a zero budget). The notice may be a fixed
 *      sentence or a function of the truncation report, so a caller can
 *      say WHICH sections went instead of only that something did.
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

/**
 * What a notice function is told about the truncation it is announcing.
 *
 * Keys and integers ONLY, deliberately. A caller that wants to name what
 * went can do so from `droppedKeys`, which are the caller's own stable
 * identifiers, and can quantify it from the character pair - without this
 * module ever handing back a slice of section TEXT. That matters because
 * one consumer of this budgeter caps operator-authored bytes in an
 * unknown language, and a notice assembled from integers reads the same
 * whatever those bytes are.
 */
export interface SectionTruncationReport {
  /** Keys of fully dropped sections, in drop order. */
  readonly droppedKeys: ReadonlyArray<string>;
  /** Characters of section content in the budgeted body, notice excluded. */
  readonly keptChars: number;
  /** Characters the untruncated join of every section would have had. */
  readonly totalChars: number;
  /** True when the last kept section was tail-trimmed at a line boundary. */
  readonly trimmed: boolean;
}

/**
 * A fixed sentence, or a sentence built from the truncation report.
 *
 * The fixed form is right when there is only one thing the notice can
 * say. The function form exists because "something was dropped" and
 * "these three sections were dropped, keeping 7,980 of 30,412
 * characters" are different messages, and the second one was already
 * computed here and then thrown away by every caller.
 */
export type SectionBudgetNotice = string | ((report: SectionTruncationReport) => string);

export interface SectionBudgetOptions {
  /**
   * One-line notice appended (after a blank-line separator when any
   * content is kept) whenever truncation occurred. Not counted
   * against the budget. Resolved once, only when truncation actually
   * happened, so the function form is never called on the common path.
   */
  readonly notice?: SectionBudgetNotice;
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
  const totalChars = joinedLength(sections);
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

  const frozenDroppedKeys = Object.freeze(droppedKeys);

  let body = content;
  if (truncated && opts.notice !== undefined) {
    // The single place a notice is appended, and therefore the single
    // place the report is materialized. `keptChars` describes the
    // content alone: the notice rides on top of the budget, so counting
    // it would make the pair the notice reports disagree with itself.
    const notice = resolveNotice(opts.notice, {
      droppedKeys: frozenDroppedKeys,
      keptChars: content.length,
      totalChars,
      trimmed: trimmedAny,
    });
    if (notice.length > 0) {
      body = content.length > 0 ? content + SEPARATOR + notice : notice;
    }
  }

  return Object.freeze({
    body,
    truncated,
    droppedKeys: frozenDroppedKeys,
  });
}

function resolveNotice(notice: SectionBudgetNotice, report: SectionTruncationReport): string {
  return typeof notice === "string" ? notice : notice(report);
}
