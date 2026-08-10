/**
 * Section-aware character budget (token-diet, plan Task 1): pure
 * deterministic truncation shared by the active.md injection budget
 * and any future hook-side body budgeting. Sections drop whole
 * (lowest priority first); the most important remaining section is
 * trimmed at line boundaries, never mid-line.
 */

import { describe, expect, test } from "bun:test";

import {
  applySectionBudget,
  type BudgetSection,
  type SectionTruncationReport,
} from "../../../src/core/brain/text/text-budget.ts";

const NOTICE = "_Truncated to fit the injection budget. Call `brain_context` for the full view._";

function sections(): BudgetSection[] {
  return [
    { key: "confirmed", priority: 0, text: "## Confirmed\n\n- a one\n- a two\n- a three" },
    { key: "most-applied", priority: 1, text: "## Most-applied\n\n- m one\n- m two" },
    { key: "quarantine", priority: 2, text: "## Quarantine\n\n- q one" },
    { key: "retired", priority: 3, text: "## Retired\n\n- r one" },
  ];
}

describe("applySectionBudget", () => {
  test("everything fits: identity join, no truncation", () => {
    const out = applySectionBudget(sections(), 10_000, { notice: NOTICE });
    expect(out.truncated).toBe(false);
    expect(out.droppedKeys).toEqual([]);
    expect(out.body).toBe(
      [
        "## Confirmed\n\n- a one\n- a two\n- a three",
        "## Most-applied\n\n- m one\n- m two",
        "## Quarantine\n\n- q one",
        "## Retired\n\n- r one",
      ].join("\n\n"),
    );
  });

  test("over budget: drops the lowest-priority sections first, keeps render order", () => {
    const full = applySectionBudget(sections(), 10_000, { notice: NOTICE }).body.length;
    // Budget one section short of the full body: only `retired` drops.
    const out = applySectionBudget(sections(), full - 20, { notice: NOTICE });
    expect(out.truncated).toBe(true);
    expect(out.droppedKeys).toEqual(["retired"]);
    expect(out.body).toContain("## Confirmed");
    expect(out.body).not.toContain("## Retired");
    expect(out.body.endsWith(NOTICE)).toBe(true);
  });

  test("still over budget after drops: trims the least important kept section at line boundaries", () => {
    const out = applySectionBudget(sections(), 30, { notice: NOTICE });
    expect(out.truncated).toBe(true);
    expect(out.droppedKeys).toEqual(["retired", "quarantine", "most-applied"]);
    // The confirmed section is line-trimmed from the tail: every kept
    // line must be a complete line from the original text.
    const kept = out.body.slice(0, out.body.length - NOTICE.length).trimEnd();
    for (const line of kept.split("\n")) {
      expect("## Confirmed\n\n- a one\n- a two\n- a three".split("\n")).toContain(line);
    }
    expect(kept).toContain("## Confirmed");
    expect(kept).not.toContain("- a three");
  });

  test("zero budget returns the notice only", () => {
    const out = applySectionBudget(sections(), 0, { notice: NOTICE });
    expect(out.truncated).toBe(true);
    expect(out.body).toBe(NOTICE);
    expect(out.droppedKeys).toEqual(["retired", "quarantine", "most-applied", "confirmed"]);
  });

  test("deterministic: identical inputs produce identical outputs", () => {
    const a = applySectionBudget(sections(), 90, { notice: NOTICE });
    const b = applySectionBudget(sections(), 90, { notice: NOTICE });
    expect(a).toEqual(b);
  });

  test("priority ties drop the later section first", () => {
    const tied: BudgetSection[] = [
      { key: "first", priority: 1, text: "first body" },
      { key: "second", priority: 1, text: "second body" },
    ];
    const out = applySectionBudget(tied, "first body".length + 2, { notice: NOTICE });
    expect(out.droppedKeys).toEqual(["second"]);
    expect(out.body.startsWith("first body")).toBe(true);
  });

  test("budget respected across a fixture sweep (content within budget, notice rides on top)", () => {
    const secs = sections();
    const overhead = NOTICE.length + 2; // separator + notice when truncated
    for (let budget = 0; budget <= 400; budget += 7) {
      const out = applySectionBudget(secs, budget, { notice: NOTICE });
      expect(out.body.length).toBeLessThanOrEqual(budget + overhead);
    }
  });

  test("no notice configured: truncation still works, body stays within budget", () => {
    const out = applySectionBudget(sections(), 50, {});
    expect(out.truncated).toBe(true);
    expect(out.body.length).toBeLessThanOrEqual(50);
    expect(out.body).toContain("## Confirmed");
  });
});

/**
 * The notice may be a function of the truncation report, which is what
 * lets a caller say WHICH sections went and by how much rather than
 * emitting a fixed sentence that names nothing. The report carries
 * integers and section keys only - no text of the sections themselves -
 * so a notice built from it is safe to show whatever the sections hold.
 */
describe("applySectionBudget: the notice as a function of the truncation report", () => {
  function reportFor(budget: number): SectionTruncationReport {
    let seen: SectionTruncationReport | null = null;
    applySectionBudget(sections(), budget, {
      notice: (report) => {
        seen = report;
        return "";
      },
    });
    if (seen === null) throw new Error("the notice function was never called");
    return seen;
  }

  test("the function receives droppedKeys in drop order", () => {
    const full = applySectionBudget(sections(), 10_000).body.length;
    expect(reportFor(full - 20).droppedKeys).toEqual(["retired"]);
    expect(reportFor(30).droppedKeys).toEqual(["retired", "quarantine", "most-applied"]);
  });

  test("the function receives kept and total characters and the trimmed flag", () => {
    const full = applySectionBudget(sections(), 10_000).body.length;
    // A whole-section drop with no tail trim.
    const dropped = reportFor(full - 20);
    expect(dropped.totalChars).toBe(full);
    expect(dropped.keptChars).toBeLessThan(full);
    expect(dropped.trimmed).toBe(false);
    // A budget tight enough that the last kept section is tail-trimmed.
    expect(reportFor(30).trimmed).toBe(true);
  });

  test("the returned string is appended verbatim", () => {
    const out = applySectionBudget(sections(), 30, {
      notice: (report) => `dropped ${report.droppedKeys.length}`,
    });
    expect(out.body.endsWith("\n\ndropped 3")).toBe(true);
  });

  test("a function returning the empty string appends nothing", () => {
    const out = applySectionBudget(sections(), 30, { notice: () => "" });
    expect(out.truncated).toBe(true);
    expect(out.body.length).toBeLessThanOrEqual(30);
  });

  test("the function is not called when nothing was truncated", () => {
    let calls = 0;
    const out = applySectionBudget(sections(), 10_000, {
      notice: () => {
        calls++;
        return NOTICE;
      },
    });
    expect(calls).toBe(0);
    expect(out.body).not.toContain(NOTICE);
  });

  test("the string form still behaves identically to a function returning it", () => {
    for (const budget of [0, 30, 90, 200, 10_000]) {
      const asString = applySectionBudget(sections(), budget, { notice: NOTICE });
      const asFunction = applySectionBudget(sections(), budget, { notice: () => NOTICE });
      expect(asFunction).toEqual(asString);
    }
  });
});
