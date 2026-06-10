/**
 * Shared, pure recall-budget primitive (v0.20.0).
 *
 * A single place to enforce character budgets on an ordered list of
 * recall entries, reused by `context-pack.ts` and
 * `brain_pre_compress_pack` so neither reimplements trimming. Two
 * independent dimensions:
 *
 *   - `maxCharsPerEntry` trims any single oversized entry's text (so one
 *     huge memory cannot crowd out the rest);
 *   - `maxTotalChars` caps the cumulative characters across the kept
 *     entries, discarding the lowest-priority overflow.
 *
 * Entries MUST arrive pre-sorted by priority (highest first); the
 * primitive preserves that order and trims/drops from the tail. Lengths
 * are measured in Unicode code points, so multi-byte scripts and astral
 * characters are counted and truncated without splitting a surrogate
 * pair. Pure and deterministic: no I/O, clock, or randomness.
 *
 * Per-entry trimming supports two strategies
 * (continuity-hygiene-freshness suite): the historical hard cut
 * (default, byte-identical) and an opt-in staged degradation ladder
 * that prefers structural boundaries - sentence terminators, then
 * whole leading lines - over cutting mid-sentence.
 */

export type CharBudgetDegradationMode = "hard-cut" | "staged";
export type CharBudgetDegradationStage = "sentence" | "lines" | "hard";

export interface CharBudgetOptions {
  /** Max code points per entry; <= 0 or undefined disables per-entry trimming. */
  readonly maxCharsPerEntry?: number;
  /** Max cumulative code points across kept entries; <= 0 or undefined disables. */
  readonly maxTotalChars?: number;
  /**
   * Per-entry trim strategy. `hard-cut` (default) keeps the historical
   * mid-sentence cut byte-identical; `staged` walks the deterministic
   * degradation ladder: sentence-boundary trim, then whole leading
   * lines, then hard cut.
   */
  readonly degradation?: CharBudgetDegradationMode;
}

export interface BudgetedEntry<T> {
  readonly item: T;
  /** Entry text after any per-entry trim. */
  readonly text: string;
  /** True when `text` was truncated by `maxCharsPerEntry`. */
  readonly trimmed: boolean;
  /** Ladder stage that produced the trim (staged mode only). */
  readonly degradation?: CharBudgetDegradationStage;
}

export interface CharBudgetResult<T> {
  readonly kept: ReadonlyArray<BudgetedEntry<T>>;
  /** Items dropped because the total-character cap was reached. */
  readonly dropped: ReadonlyArray<T>;
  /** Total code points across kept entries. */
  readonly totalChars: number;
}

function codePoints(s: string): string[] {
  return [...s];
}

/**
 * Sentence-terminator code points across scripts. Structural
 * punctuation only - Latin/Cyrillic terminators, ellipsis, CJK full
 * stops, Arabic question mark and full stop, Devanagari danda - never
 * language-specific wordlists.
 */
const SENTENCE_TERMINATORS = new Set([
  ".",
  "!",
  "?",
  "…", // horizontal ellipsis
  "。", // CJK full stop
  "！", // fullwidth exclamation
  "？", // fullwidth question
  "؟", // Arabic question mark
  "۔", // Arabic full stop
  "।", // Devanagari danda
  "॥", // Devanagari double danda
]);

interface DegradedText {
  readonly text: string;
  readonly stage: CharBudgetDegradationStage;
}

/**
 * Walk the degradation ladder for one over-budget entry: cut after the
 * last sentence terminator inside the window, else keep whole leading
 * lines that fit, else hard-cut. Pure and deterministic.
 */
function degradeEntry(cps: ReadonlyArray<string>, budget: number): DegradedText {
  const window = cps.slice(0, budget);

  // Stage 1: last sentence terminator inside the window.
  for (let i = window.length - 1; i >= 0; i--) {
    if (!SENTENCE_TERMINATORS.has(window[i]!)) continue;
    const candidate = window
      .slice(0, i + 1)
      .join("")
      .trimEnd();
    if (candidate.length > 0) return { text: candidate, stage: "sentence" };
    break;
  }

  // Stage 2: whole leading lines that fit the window.
  const windowText = window.join("");
  const lastBreak = windowText.lastIndexOf("\n");
  if (lastBreak > 0) {
    const candidate = windowText.slice(0, lastBreak).trimEnd();
    if (candidate.length > 0) return { text: candidate, stage: "lines" };
  }

  // Stage 3: the historical hard cut.
  return { text: windowText, stage: "hard" };
}

/**
 * Apply per-entry and total character caps to an ordered entry list.
 * With no caps set this is an identity pass (every entry kept, untrimmed,
 * nothing dropped).
 */
export function applyCharBudget<T>(
  entries: ReadonlyArray<{ readonly item: T; readonly text: string }>,
  opts: CharBudgetOptions,
): CharBudgetResult<T> {
  const perEntry = opts.maxCharsPerEntry && opts.maxCharsPerEntry > 0 ? opts.maxCharsPerEntry : 0;
  const total = opts.maxTotalChars && opts.maxTotalChars > 0 ? opts.maxTotalChars : 0;

  const kept: BudgetedEntry<T>[] = [];
  const dropped: T[] = [];
  let used = 0;

  for (const { item, text } of entries) {
    let outText = text;
    let trimmed = false;
    let stage: CharBudgetDegradationStage | undefined;
    if (perEntry > 0) {
      const cps = codePoints(text);
      if (cps.length > perEntry) {
        if (opts.degradation === "staged") {
          const degraded = degradeEntry(cps, perEntry);
          outText = degraded.text;
          stage = degraded.stage;
        } else {
          outText = cps.slice(0, perEntry).join("");
        }
        trimmed = true;
      }
    }
    const len = codePoints(outText).length;
    if (total > 0 && used + len > total) {
      // Lowest-priority overflow: drop and keep trying smaller tail
      // entries (matches the existing context-pack token-budget policy).
      dropped.push(item);
      continue;
    }
    used += len;
    kept.push({
      item,
      text: outText,
      trimmed,
      ...(stage !== undefined ? { degradation: stage } : {}),
    });
  }

  return Object.freeze({
    kept: Object.freeze(kept),
    dropped: Object.freeze(dropped),
    totalChars: used,
  });
}
