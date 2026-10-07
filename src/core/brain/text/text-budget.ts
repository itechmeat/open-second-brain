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
  /**
   * Leading lines (a heading) that never stand alone: a tail trim that
   * would keep no more than these lines drops the section instead, so a
   * heading never claims a section with nothing under it. Default 0.
   */
  readonly headLines?: number;
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
  /**
   * Total reported to the notice INSTEAD of the join of the sections
   * as handed in. A caller that shrinks the sections BEFORE this pass
   * (the active-body budgeter tiers them first) hands on smaller
   * slices but must quantify the cut against the body it started
   * from; the override keeps its "kept X of Y" honest. Absent - the
   * standing-rules and scoped-rules callers - the join of the given
   * sections is reported, exactly as before.
   */
  readonly totalChars?: number;
}

export interface SectionBudgetResult {
  /** Budgeted body: kept sections in render order, plus the notice when truncated. */
  readonly body: string;
  /** True when any section was dropped or trimmed. */
  readonly truncated: boolean;
  /** Keys of fully dropped sections, in drop order. */
  readonly droppedKeys: ReadonlyArray<string>;
}

/** Blank line between joined sections; also the notice's lead-in separator. */
export const SECTION_SEPARATOR = "\n\n";

/**
 * Render sections the way {@link applySectionBudget} renders them: the
 * section texts in the given order, one blank line between neighbours.
 * Exported so the active-body budgeter can assemble its pre-budget tier
 * output from the exact same join the budget pass uses.
 */
export function joinSections(sections: ReadonlyArray<{ readonly text: string }>): string {
  return sections.map((s) => s.text).join(SECTION_SEPARATOR);
}

/**
 * Character length of the sections joined the way {@link applySectionBudget}
 * joins them: one blank line between neighbours, nothing for zero or one
 * section. Exported so the active-body budgeter can decide - before the
 * budget pass runs - whether its pre-pass over the same sections already
 * brought the body within budget.
 */
export function joinedSectionsLength(sections: ReadonlyArray<{ readonly text: string }>): number {
  return joinedLength(sections);
}

interface KeptSection extends BudgetSection {
  /** Position in the caller's render order. */
  readonly index: number;
}

function joinedLength(parts: ReadonlyArray<{ readonly text: string }>): number {
  if (parts.length === 0) return 0;
  let total = SECTION_SEPARATOR.length * (parts.length - 1);
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
 * Returns null when not even the first line fits, or when all that would
 * be left is the first `headLines` lines.
 */
function trimToLines(text: string, maxChars: number, headLines = 0): string | null {
  if (text.length <= maxChars) return text;
  const lines = text.split("\n");
  while (lines.length > 0) {
    lines.pop();
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    const candidate = lines.join("\n");
    if (candidate.length === 0 || lines.length <= headLines) return null;
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
  const totalChars = opts.totalChars ?? joinedLength(sections);
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
    const trimmed = trimToLines(last.text, budget, last.headLines);
    if (trimmed === null) {
      droppedKeys.push(last.key);
      kept.splice(0, 1);
    } else {
      kept[0] = { ...last, text: trimmed };
      trimmedAny = true;
    }
  }

  const truncated = trimmedAny || droppedKeys.length > 0;
  const content = joinSections(kept.toSorted((a, b) => a.index - b.index));

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
      body = content.length > 0 ? content + SECTION_SEPARATOR + notice : notice;
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

// ----- Section bullet primitives (headline tier) -----------------------------
//
// A whole-section budget has a gap between "intact" and "gone": an
// oversized section could keep its heading, its lead-in prose and its
// few most important items instead of vanishing. These primitives give
// a caller the pieces for that intermediate tier. They parse the
// DISPLAY grammar the section renderers emit at shrink time - when no
// structured metadata exists, only the rendered string:
//
//     ## Heading
//     (blank lines and non-bullet lead-in prose)
//     - `id` (tag: value, tag) — principle text
//
// This grammar is a render convention, not a storage contract. The
// renderers (`renderBody` / `renderConfirmedLine` / `renderMostAppliedLine`
// / `renderQuarantineLine` in `active.ts`, and the lessons renderer) and
// these primitives point at each other in their docblocks: if the render
// model changes shape, a line that no longer parses ranks last in
// original order - deterministic and never wrong, just unranked.

const ITEM_LINE_PREFIX = "- ";

/** First character of an ATX Markdown heading line. */
const HEADING_MARKER = "#";

const ID_DELIMITER = "`";
const GROUP_OPEN = "(";
const GROUP_CLOSE = ")";

const NUMBER_SOURCE = String.raw`(\d+(?:\.\d+)?)`;

/** Ranking keys, matched against the FIRST tag group of an item line only. */
const APPLIED_IN_WINDOW_PATTERN = new RegExp(
  String.raw`(?:^|,)\s*applied_in_window:\s*` + NUMBER_SOURCE,
);
const CONFIDENCE_VALUE_PATTERN = new RegExp(
  String.raw`(?:^|,)\s*confidence:\s*[^(,]*\(` + NUMBER_SOURCE + String.raw`\)`,
);
const APPLIED_PATTERN = new RegExp(String.raw`(?:^|,)\s*applied:\s*` + NUMBER_SOURCE);
// `violated` follows `applied` across a ` / ` separator in the rendered
// quarantine tag, so the slash counts as a key boundary too.
const VIOLATED_PATTERN = new RegExp(String.raw`(?:^|[,/])\s*violated:\s*` + NUMBER_SOURCE);

/** A section slice split at its first item line. */
export interface SectionBulletSplit {
  /**
   * The ATX heading line when the slice opens with one, else null (a
   * preamble slice or an unheaded fragment).
   */
  readonly heading: string | null;
  /** Every line before the first item line: the heading, blank separators, lead-ins. */
  readonly headLines: ReadonlyArray<string>;
  /** The head lines after the heading. Empty when there is no heading. */
  readonly leadInLines: ReadonlyArray<string>;
  /** Item (bullet) lines, in render order. Empty when the slice has none. */
  readonly itemLines: ReadonlyArray<string>;
}

/**
 * Split a section's rendered text into its head (heading and non-bullet
 * lead-in lines) and its item lines. Everything from the first item line
 * on counts as the item region, so the split is always total: head +
 * items rejoin to the original text.
 *
 * Pure: the input is never touched and identical inputs split identically.
 */
export function splitSectionBullets(text: string): SectionBulletSplit {
  const lines = text.split("\n");
  const firstItemAt = lines.findIndex((line) => line.startsWith(ITEM_LINE_PREFIX));
  const headLines = firstItemAt === -1 ? lines : lines.slice(0, firstItemAt);
  const itemLines = firstItemAt === -1 ? [] : lines.slice(firstItemAt);
  const first = headLines[0];
  const heading = first !== undefined && first.startsWith(HEADING_MARKER) ? first : null;
  const leadInLines = heading === null ? [] : headLines.slice(1);
  return { heading, headLines, leadInLines, itemLines };
}

/**
 * Read the FIRST parenthesized group that follows the `` - `id` `` prefix
 * of an item line, honoring nested parentheses: `(confidence: high (0.95))`
 * yields `confidence: high (0.95)`, and the principle text after the group
 * is never read. Returns null when the line is not a bullet, has no
 * backticked id, opens no group, or never closes the one it opens - the
 * caller fails open by ranking such lines last.
 */
export function firstTagGroup(line: string): string | null {
  if (!line.startsWith(ITEM_LINE_PREFIX)) return null;
  if (line[ITEM_LINE_PREFIX.length] !== ID_DELIMITER) return null;
  const idEnd = line.indexOf(ID_DELIMITER, ITEM_LINE_PREFIX.length + 1);
  if (idEnd === -1) return null;
  let at = idEnd + 1;
  while (at < line.length && line[at] === " ") at++;
  if (line[at] !== GROUP_OPEN) return null;
  let depth = 0;
  for (let i = at; i < line.length; i++) {
    const ch = line[i];
    if (ch === GROUP_OPEN) depth++;
    else if (ch === GROUP_CLOSE) {
      depth--;
      if (depth === 0) return line.slice(at + 1, i);
    }
  }
  return null;
}

/** Ranking keys of one item line, parsed from its first tag group. */
interface ItemRankKeys {
  readonly appliedInWindow: number | null;
  readonly confidenceValue: number | null;
  readonly applied: number | null;
  readonly violated: number | null;
}

function firstNumber(group: string, pattern: RegExp): number | null {
  const match = pattern.exec(group);
  if (match === null) return null;
  const value = Number.parseFloat(match[1]!);
  return Number.isFinite(value) ? value : null;
}

/**
 * Keys of an item line, or null when the line has no recognizable
 * id-tag group at all (the rank-last band). A line WITH a group but none
 * of the known keys gets all-null keys: it still ranks in the recognized
 * band, tied, in original order.
 */
function itemRankKeys(line: string): ItemRankKeys | null {
  const group = firstTagGroup(line);
  if (group === null) return null;
  return {
    appliedInWindow: firstNumber(group, APPLIED_IN_WINDOW_PATTERN),
    confidenceValue: firstNumber(group, CONFIDENCE_VALUE_PATTERN),
    applied: firstNumber(group, APPLIED_PATTERN),
    violated: firstNumber(group, VIOLATED_PATTERN),
  };
}

/**
 * The one "null ranks last" hole, written once: a missing key NEVER
 * ranks ahead of a present one, whichever direction the rest of the
 * comparison runs. Both sides null tie (0); exactly one null ranks
 * last; otherwise the caller's `cmp` decides.
 */
function nullLast<T>(a: T | null, b: T | null, cmp: (x: T, y: T) => number): number {
  if (a === null || b === null) {
    if (a === null && b === null) return 0;
    return a === null ? 1 : -1;
  }
  return cmp(a, b);
}

/** Descending, through the shared null-last hole. */
function compareDesc(a: number | null, b: number | null): number {
  return nullLast(a, b, (x, y) => y - x);
}

/** Ascending, through the shared null-last hole. */
function compareAsc(a: number | null, b: number | null): number {
  return nullLast(a, b, (x, y) => x - y);
}

/**
 * Deterministic ranking order of two item lines, the keys the section
 * renderers emit: `applied_in_window` descending (Most-applied),
 * confidence value descending (Confirmed), then `applied` descending and
 * `violated` ascending (Quarantine). Lines without a recognizable
 * id-tag group rank last; every tie falls through to the caller's
 * original render order. Pure.
 */
export function compareItemLines(a: string, b: string): number {
  const ka = itemRankKeys(a);
  const kb = itemRankKeys(b);
  if (ka === null || kb === null) return nullLast(ka, kb, () => 0);
  return (
    compareDesc(ka.appliedInWindow, kb.appliedInWindow) ||
    compareDesc(ka.confidenceValue, kb.confidenceValue) ||
    compareDesc(ka.applied, kb.applied) ||
    compareAsc(ka.violated, kb.violated)
  );
}

/**
 * The `limit` highest-ranked item lines, survivors kept in their
 * original render order (a tiered section must read like the original
 * minus the dropped lines, not like a re-ranking). Ties and
 * unrankable lines resolve by position, so the selection is stable
 * without relying on sort stability. Pure.
 */
export function topItemLines(items: ReadonlyArray<string>, limit: number): ReadonlyArray<string> {
  const keep = Math.max(0, Math.floor(limit));
  if (keep >= items.length) return items;
  return items
    .map((line, index) => ({ line, index }))
    .toSorted((a, b) => compareItemLines(a.line, b.line) || a.index - b.index)
    .slice(0, keep)
    .toSorted((a, b) => a.index - b.index)
    .map((entry) => entry.line);
}
