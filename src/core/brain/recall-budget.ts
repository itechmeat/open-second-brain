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
 */

export interface CharBudgetOptions {
  /** Max code points per entry; <= 0 or undefined disables per-entry trimming. */
  readonly maxCharsPerEntry?: number;
  /** Max cumulative code points across kept entries; <= 0 or undefined disables. */
  readonly maxTotalChars?: number;
}

export interface BudgetedEntry<T> {
  readonly item: T;
  /** Entry text after any per-entry trim. */
  readonly text: string;
  /** True when `text` was truncated by `maxCharsPerEntry`. */
  readonly trimmed: boolean;
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
    if (perEntry > 0) {
      const cps = codePoints(text);
      if (cps.length > perEntry) {
        outText = cps.slice(0, perEntry).join("");
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
    kept.push({ item, text: outText, trimmed });
  }

  return Object.freeze({
    kept: Object.freeze(kept),
    dropped: Object.freeze(dropped),
    totalChars: used,
  });
}
