/**
 * Staged degradation ladder for over-budget recall entries
 * (continuity-hygiene-freshness suite, Task 5; kanban t_05f5dc12).
 *
 * Default behavior stays the hard code-point cut (pinned by
 * recall-budget.test.ts). Opting into `degradation: "staged"` walks a
 * deterministic ladder instead of cutting mid-sentence:
 *   1. trim at the last sentence terminator inside the budget;
 *   2. keep whole leading lines that fit;
 *   3. hard cut as the last resort.
 * Boundaries are structural (terminator punctuation across scripts,
 * line breaks) - never language-specific wordlists.
 */

import { describe, expect, test } from "bun:test";

import { applyCharBudget } from "../../../src/core/brain/recall-budget.ts";

describe("applyCharBudget — staged degradation", () => {
  test("default mode stays a hard cut with no degradation report", () => {
    const result = applyCharBudget([{ item: "a", text: "one two. three four" }], {
      maxCharsPerEntry: 10,
    });
    expect(result.kept[0]?.text).toBe("one two. t");
    expect(result.kept[0]?.trimmed).toBe(true);
    expect("degradation" in (result.kept[0] ?? {})).toBe(false);
  });

  test("stage 1: trims at the last sentence terminator inside the budget", () => {
    const result = applyCharBudget(
      [{ item: "a", text: "First sentence. Second sentence! Third sentence is long." }],
      { maxCharsPerEntry: 40, degradation: "staged" },
    );
    expect(result.kept[0]?.text).toBe("First sentence. Second sentence!");
    expect(result.kept[0]?.trimmed).toBe(true);
    expect(result.kept[0]?.degradation).toBe("sentence");
  });

  test("stage 1 works with CJK terminators", () => {
    const result = applyCharBudget(
      [{ item: "a", text: "第一句话。第二句话。第三句话很长很长很长" }],
      {
        maxCharsPerEntry: 10,
        degradation: "staged",
      },
    );
    expect(result.kept[0]?.text).toBe("第一句话。第二句话。");
    expect(result.kept[0]?.degradation).toBe("sentence");
  });

  test("stage 2: keeps whole leading lines when no sentence boundary fits", () => {
    const text = "- bullet one\n- bullet two\n- bullet three is much longer than the budget";
    const result = applyCharBudget([{ item: "a", text }], {
      maxCharsPerEntry: 30,
      degradation: "staged",
    });
    expect(result.kept[0]?.text).toBe("- bullet one\n- bullet two");
    expect(result.kept[0]?.degradation).toBe("lines");
  });

  test("stage 3: hard cut when no structural boundary exists in the window", () => {
    const result = applyCharBudget([{ item: "a", text: "x".repeat(100) }], {
      maxCharsPerEntry: 10,
      degradation: "staged",
    });
    expect(result.kept[0]?.text).toBe("x".repeat(10));
    expect(result.kept[0]?.degradation).toBe("hard");
  });

  test("entries inside the budget stay untouched and unreported", () => {
    const result = applyCharBudget([{ item: "a", text: "short. text" }], {
      maxCharsPerEntry: 100,
      degradation: "staged",
    });
    expect(result.kept[0]?.text).toBe("short. text");
    expect(result.kept[0]?.trimmed).toBe(false);
    expect("degradation" in (result.kept[0] ?? {})).toBe(false);
  });

  test("total-chars accounting charges the degraded text, not the original", () => {
    const result = applyCharBudget(
      [
        { item: "a", text: "First sentence. Tail that will be dropped" },
        { item: "b", text: "Second entry" },
      ],
      { maxCharsPerEntry: 20, maxTotalChars: 30, degradation: "staged" },
    );
    expect(result.kept[0]?.text).toBe("First sentence.");
    expect(result.kept[1]?.text).toBe("Second entry");
    expect(result.totalChars).toBe("First sentence.".length + "Second entry".length);
  });
});
