/**
 * Human edits of a view page as records: a line emptied to its list
 * marker retires the rule, text typed over the id comment is kept, an
 * edit that deletes most of a page or cannot be aligned yields no record,
 * an addition counts only with human authority and once, and a byte order
 * mark is dropped whatever the source spelling.
 */
import { describe, expect, test } from "bun:test";

import type { StoreRecord } from "../../../src/core/store/envelope.ts";
import {
  editRecords,
  foldCorrections,
  pageLines,
  reviewedEdits,
} from "../../../src/core/view/corrections.ts";

const BASE = [
  "<!-- open-second-brain-view store=s page=about-me.md -->",
  "",
  "# About me",
  "",
  "- Rule A.",
  "- Rule B.",
  "- Rule C.",
  "- Rule D.",
];
const KEYS = [
  "#id",
  null,
  "h:title",
  null,
  "pref:pref-a",
  "pref:pref-b",
  "pref:pref-c",
  "pref:pref-d",
];

describe("editRecords", () => {
  test("a rule line cleared down to its list marker retires the rule", () => {
    const edited = [...BASE];
    edited[5] = "- ";
    expect(editRecords("about-me.md", BASE, KEYS, edited).map((r) => r.body)).toEqual([
      { authority: "human", preference: "pref-b", fields: { status: "retired" } },
    ]);
  });

  test("text typed over the id comment is kept as an addition", () => {
    const edited = ["Call the bank on Monday.", ...BASE.slice(1)];
    expect(editRecords("about-me.md", BASE, KEYS, edited).map((r) => r.body)).toEqual([
      { authority: "human", page: "about-me.md", after: null, text: "Call the bank on Monday." },
    ]);
  });
});

describe("reviewedEdits", () => {
  test("a page truncated to its heading yields no record", () => {
    const truncated = BASE.slice(0, 3);
    const out = reviewedEdits("about-me.md", BASE, KEYS, truncated);
    expect(out).toEqual({ records: [], refusal: "mass-deletion" });
  });

  test("one deleted rule is an ordinary edit", () => {
    const edited = BASE.filter((l) => l !== "- Rule C.");
    expect(reviewedEdits("about-me.md", BASE, KEYS, edited).refusal).toBeNull();
  });
});

function record(id: string, authority: string, text: string): StoreRecord {
  return {
    v: 1,
    id,
    hlc: `${id.length}.0`,
    device: "dev-a",
    agent: "t",
    kind: "view-addition",
    body: { authority, page: "about-me.md", after: "pref:pref-a", text },
  } as unknown as StoreRecord;
}

describe("foldCorrections", () => {
  test("an addition counts only with human authority, and the same addition once", () => {
    const folded = foldCorrections([
      record("r1", "human", "- Milk."),
      record("r22", "human", "- Milk."),
      record("r333", "agent", "- Agent line."),
    ]);
    expect(folded.get("about-me.md")?.additions.map((a) => a.text)).toEqual(["- Milk."]);
  });
});

test("pageLines drops a byte order mark", () => {
  expect(pageLines("\uFEFF# A\r\nb\n")).toEqual(["# A", "b"]);
});
