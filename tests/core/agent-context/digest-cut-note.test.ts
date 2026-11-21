/**
 * The one truncation note of the session start digest, and the
 * notice-free budgeter behind it: each lane fits its budget with no byte
 * spent on a note, reports what it cut, and the reports fold into one
 * note that counts characters, rule lines, sections, pinned characters
 * and lessons, and names the call that returns the full set.
 */
import { describe, expect, test } from "bun:test";

import {
  DIGEST_CUT_NOTE_OPEN,
  DIGEST_CUT_NOTE_RESERVE,
  parseDigestCuts,
  renderDigestCutNote,
  type DigestCut,
} from "../../../src/core/agent-context/digest-cut-note.ts";
import { budgetActiveBodyContent } from "../../../src/core/brain/active-budget.ts";

function body(confirmed: number, quarantined: number): string {
  const line = (p: string, i: number): string =>
    `- \`pref-${p}-${i}\` (confidence: high (0.9)) — Rule ${p} ${i} keeps the claims sourced`;
  return [
    "# Active Brain Preferences",
    "",
    `## Confirmed (${confirmed})`,
    "",
    ...Array.from({ length: confirmed }, (_, i) => line("c", i)),
    "",
    `## Quarantine (${quarantined})`,
    "",
    ...Array.from({ length: quarantined }, (_, i) => line("q", i)),
  ].join("\n");
}

describe("budgetActiveBodyContent", () => {
  test("within budget the body passes through and nothing is reported", () => {
    const text = body(3, 2);
    expect(budgetActiveBodyContent(text, text.length)).toEqual({ content: text, cut: null });
  });

  test("over budget the content alone fits, with no notice, and the cut is counted", () => {
    const text = body(200, 40);
    const budgeted = budgetActiveBodyContent(text, 3000);
    expect(budgeted.content.length).toBeLessThanOrEqual(3000);
    expect(budgeted.content).not.toContain(DIGEST_CUT_NOTE_OPEN);
    const kept = budgeted.content.split("\n").filter((l) => l.startsWith("- ")).length;
    expect(budgeted.cut).toEqual({
      keptChars: budgeted.content.length,
      totalChars: text.length,
      itemsKept: kept,
      itemsTotal: 240,
      sectionsDropped: 1,
      sectionsTotal: 2,
    });
    expect(text.startsWith(budgeted.content)).toBe(true);
  });
});

describe("renderDigestCutNote", () => {
  const active: DigestCut = {
    source: "active-body",
    keptChars: 6458,
    totalChars: 82963,
    itemsKept: 29,
    itemsTotal: 310,
    sectionsDropped: 2,
    sectionsTotal: 3,
  };
  const pinned: DigestCut = {
    source: "pinned-context",
    keptChars: 1013,
    totalChars: 19687,
    itemsKept: 0,
    itemsTotal: 0,
    sectionsDropped: 0,
    sectionsTotal: 0,
  };

  test("nothing cut, no note", () => {
    expect(renderDigestCutNote([])).toBe("");
  });

  test("one note sums every lane and names the call that returns the full set", () => {
    expect(renderDigestCutNote([pinned, active])).toBe(
      "_Injection truncated to budget: kept 7471 of 102650 characters. " +
        "Not shown: 281 of 310 rule lines, 2 of 3 sections, 18674 of 19687 characters of pinned context. " +
        "Call `brain_context` for the full preference set and the pinned context._",
    );
  });

  test("lessons not shown are counted, and their full set is named", () => {
    const lessons: DigestCut = { ...active, source: "lessons-body", itemsKept: 0, itemsTotal: 1 };
    const note = renderDigestCutNote([lessons]);
    expect(note).toContain("Not shown: 1 of 1 lesson.");
    expect(note).toContain("`osb://lessons`");
  });

  test("the reserve holds the widest note a digest can carry", () => {
    const wide = 9_999_999;
    const cut = (source: DigestCut["source"]): DigestCut => ({
      source,
      keptChars: 0,
      totalChars: wide,
      itemsKept: 0,
      itemsTotal: wide,
      sectionsDropped: wide,
      sectionsTotal: wide,
    });
    const note = renderDigestCutNote([
      cut("active-body"),
      cut("pinned-context"),
      cut("lessons-body"),
    ]);
    expect(note.length).toBeLessThanOrEqual(DIGEST_CUT_NOTE_RESERVE);
  });

  test("the reserve allows a nonzero pinned omission with mixed retained counts", () => {
    const wide = 9_999_999;
    const note = renderDigestCutNote([
      {
        ...active,
        keptChars: 1_000,
        totalChars: wide,
        itemsKept: 1_000,
        itemsTotal: wide,
        sectionsDropped: wide,
        sectionsTotal: wide,
      },
      { ...pinned, keptChars: 0, totalChars: wide },
      {
        ...active,
        source: "lessons-body",
        keptChars: 1_000,
        totalChars: wide,
        itemsKept: 1_000,
        itemsTotal: wide,
      },
    ]);
    expect(note.length).toBeLessThanOrEqual(DIGEST_CUT_NOTE_RESERVE);
  });
});

describe("parseDigestCuts", () => {
  test("a serialized list round-trips; anything else reads as no cuts", () => {
    const cut: DigestCut = {
      source: "active-body",
      keptChars: 1,
      totalChars: 2,
      itemsKept: 1,
      itemsTotal: 2,
      sectionsDropped: 0,
      sectionsTotal: 1,
    };
    expect(parseDigestCuts(JSON.stringify([cut]))).toEqual([cut]);
    expect(parseDigestCuts(null)).toEqual([]);
    expect(parseDigestCuts("not json")).toEqual([]);
    expect(
      parseDigestCuts(JSON.stringify([{ ...cut, source: "other" }, { source: "pinned-context" }])),
    ).toEqual([]);
  });
});
