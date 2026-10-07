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
  compareItemLines,
  firstTagGroup,
  joinedSectionsLength,
  type SectionBudgetOptions,
  type SectionTruncationReport,
  splitSectionBullets,
  topItemLines,
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

// ----- The reported total (original-size notice) -----------------------------

/**
 * `totalChars` on the options lets a caller that shrinks the sections
 * BEFORE this pass (the active-body budgeter tiers them first) report
 * the notice total against the body it started from, not the pre-shrunk
 * slices it hands in. Without the override such a caller has no way to
 * keep "kept X of Y" honest across its own pre-pass. The default - the
 * join of the sections as handed in - is what the standing-rules and
 * scoped-rules callers must keep receiving.
 */
describe("applySectionBudget: the reported total", () => {
  function reportFor(opts: SectionBudgetOptions, budget: number): SectionTruncationReport {
    let seen: SectionTruncationReport | null = null;
    applySectionBudget(sections(), budget, {
      ...opts,
      notice: (report) => {
        seen = report;
        return "";
      },
    });
    if (seen === null) throw new Error("the notice function was never called");
    return seen;
  }

  test("default: the total is the join of the sections as handed in", () => {
    const full = applySectionBudget(sections(), 10_000).body.length;
    expect(reportFor({}, full - 20).totalChars).toBe(full);
  });

  test("an explicit totalChars is reported instead of the join of the given sections", () => {
    const full = applySectionBudget(sections(), 10_000).body.length;
    const report = reportFor({ totalChars: 50_000 }, full - 20);
    expect(report.totalChars).toBe(50_000);
    // The override changes only what the notice is told: the body the
    // pass renders and the kept-chars figure are unaffected.
    expect(report.keptChars).toBeLessThan(full);
  });

  test("the override never surfaces when nothing was truncated", () => {
    const out = applySectionBudget(sections(), 10_000, { totalChars: 50_000, notice: NOTICE });
    expect(out.truncated).toBe(false);
    expect(out.body).not.toContain(NOTICE);
  });
});

// ----- Section bullet primitives (headline tier, context-injection-pipeline) --

/**
 * The bullet primitives parse the DISPLAY grammar the active.md and
 * lessons.md renderers emit at shrink time, when no structured metadata
 * is available: heading, non-bullet lead-in lines, then `- ` item lines
 * whose inline `(tag, tag)` group carries the ranking keys. The
 * renderer functions and these primitives point at each other in their
 * docblocks.
 */
describe("splitSectionBullets", () => {
  const SECTION_TEXT = [
    "## Quarantine (2)",
    "",
    "_Probationary rules — still active._",
    "",
    "- `q1` (applied: 0 / violated: 2) — one",
    "- `q2` (applied: 1 / violated: 0) — two",
  ].join("\n");

  test("isolates the heading, the lead-in lines and the item lines", () => {
    const split = splitSectionBullets(SECTION_TEXT);
    expect(split.heading).toBe("## Quarantine (2)");
    expect(split.leadInLines).toEqual(["", "_Probationary rules — still active._", ""]);
    expect(split.itemLines).toEqual([
      "- `q1` (applied: 0 / violated: 2) — one",
      "- `q2` (applied: 1 / violated: 0) — two",
    ]);
    expect(split.headLines).toEqual(["## Quarantine (2)", ...split.leadInLines]);
  });

  test("a slice without a heading: heading null, every non-bullet line is a head line", () => {
    const split = splitSectionBullets("plain lead-in prose\n- one");
    expect(split.heading).toBeNull();
    expect(split.leadInLines).toEqual([]);
    expect(split.headLines).toEqual(["plain lead-in prose"]);
    expect(split.itemLines).toEqual(["- one"]);
  });

  test("a slice without items: everything is head, items empty", () => {
    const split = splitSectionBullets("## Confirmed (0)\n\n_Nothing yet._");
    expect(split.itemLines).toEqual([]);
    expect(split.headLines).toEqual(["## Confirmed (0)", "", "_Nothing yet._"]);
  });

  test("pure and deterministic: identical inputs, untouched input text", () => {
    const before = SECTION_TEXT;
    expect(splitSectionBullets(SECTION_TEXT)).toEqual(splitSectionBullets(SECTION_TEXT));
    expect(SECTION_TEXT).toBe(before);
  });
});

describe("firstTagGroup", () => {
  test("reads the first parenthesized group after the id prefix", () => {
    expect(firstTagGroup("- `pref-a` (scope: web, pinned) — Rule A")).toBe("scope: web, pinned");
  });

  test("survives nested parentheses inside the group", () => {
    expect(firstTagGroup("- `pref-a` (confidence: high (0.95)) — Rule A")).toBe(
      "confidence: high (0.95)",
    );
  });

  test("the principle text after the group is never read", () => {
    expect(firstTagGroup("- `pref-a` (applied: 1 / violated: 0) — use (parens) here")).toBe(
      "applied: 1 / violated: 0",
    );
  });

  test("a line with an id but no tag group is null", () => {
    expect(firstTagGroup("- `pref-r` — low_confidence on 2026-05-01")).toBeNull();
  });

  test("a line without the id-backtick prefix is null", () => {
    expect(firstTagGroup("- plain bullet without an id")).toBeNull();
    expect(firstTagGroup("not a bullet at all")).toBeNull();
  });

  test("an unbalanced group is null (fail-open, never a misparse)", () => {
    expect(firstTagGroup("- `p` (unclosed group of text")).toBeNull();
  });
});

describe("item line ranking", () => {
  test("applied_in_window ranks descending", () => {
    const m1 = "- `m1` (applied_in_window: 2)";
    const m2 = "- `m2` (applied_in_window: 5)";
    const m3 = "- `m3` (applied_in_window: 9)";
    expect(compareItemLines(m3, m1)).toBeLessThan(0);
    expect(compareItemLines(m1, m3)).toBeGreaterThan(0);
    expect(compareItemLines(m2, m1)).toBeLessThan(0);
    expect(topItemLines([m1, m3, m2], 2)).toEqual([m3, m2]);
  });

  test("confidence values rank descending, the nested value parsed", () => {
    const c1 = "- `c1` (confidence: high (0.95)) — A";
    const c2 = "- `c2` (confidence: medium (0.50)) — B";
    const c3 = "- `c3` (confidence: high (0.80)) — C";
    expect(compareItemLines(c1, c2)).toBeLessThan(0);
    expect(compareItemLines(c3, c2)).toBeLessThan(0);
    expect(compareItemLines(c1, c3)).toBeLessThan(0);
    expect(topItemLines([c2, c1, c3], 2)).toEqual([c1, c3]);
  });

  test("applied ranks descending, then violated ascending", () => {
    const q1 = "- `q1` (applied: 2 / violated: 5) — one";
    const q2 = "- `q2` (applied: 2 / violated: 1) — two";
    const q3 = "- `q3` (applied: 4 / violated: 9) — three";
    expect(compareItemLines(q3, q1)).toBeLessThan(0);
    expect(compareItemLines(q2, q1)).toBeLessThan(0);
    // Same applied count: fewer violations first.
    expect(compareItemLines(q2, q3)).toBeGreaterThan(0);
    // Same applied count: fewer violations first. Top two are q3, q2;
    // survivors come back in render order.
    expect(topItemLines([q1, q2, q3], 2)).toEqual([q2, q3]);
  });

  test("lines without a recognizable id-tag group rank last, in original order", () => {
    const lines = [
      "- trailing plain note",
      "- `m1` (applied_in_window: 1)",
      "- `r1` — retired prose without tags",
      "- `m2` (applied_in_window: 2)",
    ];
    // Both recognized lines survive the cut; the unrecognizable band keeps
    // its original order and loses its tail (`r1`). Survivors come back in
    // render order, so the leading unrankable note rides along.
    expect(topItemLines(lines, 3)).toEqual([
      "- trailing plain note",
      "- `m1` (applied_in_window: 1)",
      "- `m2` (applied_in_window: 2)",
    ]);
  });

  test("a group with none of the known keys ranks in the recognized band, original order", () => {
    const lines = ["- `d2` (score: -0.50) — later", "- `d1` (score: -0.95) — earlier"];
    expect(topItemLines(lines, 2)).toEqual(lines);
  });

  test("ties keep original render order", () => {
    const lines = [
      "- `m1` (applied_in_window: 4)",
      "- `m2` (applied_in_window: 4)",
      "- `m3` (applied_in_window: 4)",
    ];
    expect(topItemLines(lines, 2)).toEqual(lines.slice(0, 2));
  });

  test("top-N selection keeps the survivors in render order", () => {
    const lines = [
      "- `m1` (applied_in_window: 3)",
      "- `m2` (applied_in_window: 9)",
      "- `m3` (applied_in_window: 6)",
      "- `m4` (applied_in_window: 1)",
    ];
    // Top three by count are m2, m3, m1; rendered in their original order.
    expect(topItemLines(lines, 3)).toEqual([
      "- `m1` (applied_in_window: 3)",
      "- `m2` (applied_in_window: 9)",
      "- `m3` (applied_in_window: 6)",
    ]);
  });

  test("a limit at or below zero keeps nothing; a limit past the end keeps everything", () => {
    const lines = ["- `m1` (applied_in_window: 3)", "- `m2` (applied_in_window: 9)"];
    expect(topItemLines(lines, 0)).toEqual([]);
    expect(topItemLines(lines, 10)).toEqual(lines);
  });

  test("deterministic and pure: identical calls agree, inputs untouched", () => {
    const lines = [
      "- `m1` (applied_in_window: 3)",
      "- `q1` (applied: 1 / violated: 1) — x",
      "- `c1` (confidence: high (0.95)) — y",
      "stray tail",
    ];
    const snapshot = [...lines];
    expect(topItemLines(lines, 4)).toEqual(topItemLines(lines, 4));
    expect(compareItemLines(lines[0]!, lines[1]!)).toBe(compareItemLines(lines[0]!, lines[1]!));
    expect(lines).toEqual(snapshot);
  });
});

describe("joinedSectionsLength", () => {
  test("is the character length of the separator-joined sections", () => {
    expect(joinedSectionsLength([{ text: "aaa" }, { text: "bb" }])).toBe("aaa\n\nbb".length);
    expect(joinedSectionsLength([{ text: "only" }])).toBe(4);
    expect(joinedSectionsLength([])).toBe(0);
  });
});
