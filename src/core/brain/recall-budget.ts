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

/**
 * How a caller wants the correlated recall budget claimed, one claim
 * order per member (recall-lane-latency wave).
 *
 * The premise of one reading budget over which a packing order reorders
 * is false ACROSS surfaces - pages and the facts-side brief are
 * budgeted by two separate surfaces with separate caps - so this
 * vocabulary names the claim order over the populations that DO share
 * one budget. Neither member is the omitted default: the omitted pack
 * interleaves both populations by tier, while a named policy orders whole
 * lanes, reserves the attention charge up front instead of drawing it
 * last, and - through the pack-level application of the policy - refuses
 * a vault where one lane holds no candidate in reach, a call the omitted
 * pack succeeds on. `facts_first` claims for the distilled facts lane
 * first and the retired pages fill the exact remainder. `retired_first`
 * hands the first claim to the retired pages lane, so a retired page
 * keeps its budget share even when facts-side demand would have
 * exhausted the remainder.
 */
export const PACKING_POLICIES = Object.freeze(["facts_first", "retired_first"] as const);

export type PackingPolicy = (typeof PACKING_POLICIES)[number];

/** Narrow an untrusted string to a {@link PACKING_POLICIES} member. */
export function isPackingPolicy(value: unknown): value is PackingPolicy {
  return typeof value === "string" && (PACKING_POLICIES as ReadonlyArray<string>).includes(value);
}

/** One candidate in a budget lane, priced in the shared token currency. */
export interface RecallBudgetEntry<T> {
  readonly item: T;
  /** Estimated token cost of the entry AS THE LANE WOULD EMIT IT. */
  readonly tokens: number;
}

export type RecallBudgetLaneName = "pages" | "facts";

export interface RecallBudgetLaneResult<T> {
  /** Which lane this result describes. */
  readonly name: RecallBudgetLaneName;
  /**
   * The share of the total this lane ends up holding: the first
   * claimer's allocation is exactly what it claimed; the second lane's
   * is the exact remainder handed to it (which the lane may under-use).
   * The two allocations plus the reserved charge always sum to the
   * total.
   */
  readonly allocation: number;
  /** Entries whose cost fits the lane's window, in input order. */
  readonly kept: ReadonlyArray<T>;
  /** Entries that did not fit, in input order. */
  readonly dropped: ReadonlyArray<T>;
  /** Sum of kept entries' token costs. */
  readonly spent: number;
}

export interface RecallBudgetAllocation<TPage, TFacts> {
  /** The policy that decided the claim order. */
  readonly policy: PackingPolicy;
  /** The shared total the lanes claimed against. */
  readonly totalTokens: number;
  /** Tokens charged before either lane claimed (see the argument). */
  readonly reservedTokens: number;
  readonly pages: RecallBudgetLaneResult<TPage>;
  readonly facts: RecallBudgetLaneResult<TFacts>;
}

/**
 * Walk one lane's claim over a budget window: entries are kept whole,
 * in input order, while the running spend stays inside the window; the
 * first entry that would overflow is dropped and the walk CONTINUES, so
 * a smaller later entry still fits (the same policy the context-pack
 * token loop applies to `over-budget` candidates). An entry with a
 * non-finite or negative cost is dropped rather than charged. The
 * primitive never splits or trims an entry: per-lane native caps
 * (chars, note counts) stay lane-internal fit rules, exactly as today.
 * The returned `spent` never exceeds the window.
 */
function claimLane<T>(
  name: RecallBudgetLaneName,
  entries: ReadonlyArray<RecallBudgetEntry<T>>,
  window: number,
): RecallBudgetLaneResult<T> {
  const kept: T[] = [];
  const dropped: T[] = [];
  let spent = 0;
  for (const { item, tokens } of entries) {
    if (!Number.isFinite(tokens) || tokens < 0) {
      dropped.push(item);
      continue;
    }
    if (spent + tokens > window) {
      dropped.push(item);
      continue;
    }
    spent += tokens;
    kept.push(item);
  }
  return Object.freeze({
    name,
    allocation: spent,
    kept: Object.freeze(kept),
    dropped: Object.freeze(dropped),
    spent,
  });
}

/** A lane result with its allocation restated to the window it holds. */
function withHeldWindow<T>(
  walk: RecallBudgetLaneResult<T>,
  heldWindow: number,
): RecallBudgetLaneResult<T> {
  return walk.allocation === heldWindow ? walk : Object.freeze({ ...walk, allocation: heldWindow });
}

/**
 * Correlate two recall populations over ONE shared token budget
 * (recall-lane-latency wave), beside the shared trimming primitive
 * above: both lanes already denominate content with the same
 * `estimateTokens` currency, so tokens are the correlation currency and
 * each lane's native caps stay its own business.
 *
 * Pure and deterministic. Claiming is strictly sequential with no
 * minimum-page floor: the policy names the first claimer, that lane
 * claims greedily against everything left after the reserved charge,
 * and the second lane fills the exact remainder - so conservation holds
 * by construction: `pages.allocation + facts.allocation + reservedTokens`
 * equals `totalTokens` whenever the total is usable. The total never
 * grows. A non-finite or non-positive total is a fail-closed empty
 * allocation: no lane claims anything, and the reserved charge is
 * dropped with it. A reserved charge over the total is clamped to it,
 * leaving both lanes nothing.
 *
 * The reserved charge (default 0) is a fixed cost paid before either
 * lane claims - the pack's synthesized attention block, for instance -
 * reported back on the allocation so every consumer accounts it inside
 * the same total instead of letting a lane draw over it.
 */
export function allocateRecallBudget<TPage, TFacts>(
  totalTokens: number,
  pagesLane: ReadonlyArray<RecallBudgetEntry<TPage>>,
  factsLane: ReadonlyArray<RecallBudgetEntry<TFacts>>,
  policy: PackingPolicy,
  reservedTokens = 0,
): RecallBudgetAllocation<TPage, TFacts> {
  const usable = Number.isFinite(totalTokens) && totalTokens > 0;
  const reserved = usable ? Math.min(Math.max(reservedTokens, 0), totalTokens) : 0;
  const claimable = usable ? totalTokens - reserved : 0;
  // The first claimer's allocation is exactly what it claimed, so the
  // second lane is handed the precise remainder and the books always
  // balance against the total. The second lane holds its whole window
  // even when it under-uses it.
  if (policy === "retired_first") {
    const pages = claimLane("pages", pagesLane, claimable);
    const facts = withHeldWindow(
      claimLane("facts", factsLane, claimable - pages.spent),
      claimable - pages.spent,
    );
    return Object.freeze({
      policy,
      totalTokens: usable ? totalTokens : 0,
      reservedTokens: reserved,
      pages,
      facts,
    });
  }
  const facts = claimLane("facts", factsLane, claimable);
  const pages = withHeldWindow(
    claimLane("pages", pagesLane, claimable - facts.spent),
    claimable - facts.spent,
  );
  return Object.freeze({
    policy,
    totalTokens: usable ? totalTokens : 0,
    reservedTokens: reserved,
    pages,
    facts,
  });
}
