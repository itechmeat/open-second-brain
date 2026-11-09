/**
 * Line diffs and the three-way merge of the render protocol: hunks name
 * exactly the changed lines, and the merge keeps one-sided changes and lets
 * the user win a conflict.
 */
import { describe, expect, test } from "bun:test";

import { diffLines, mergeLines } from "../../../src/core/view/line-diff.ts";

describe("diffLines", () => {
  test("no change, no hunk", () => {
    expect(diffLines(["a", "b"], ["a", "b"])).toEqual([]);
  });

  test("a replaced, a removed and an added line", () => {
    expect(diffLines(["a", "b", "c", "d"], ["a", "B", "d", "e"])).toEqual([
      { baseStart: 1, baseEnd: 3, otherStart: 1, otherEnd: 2 },
      { baseStart: 4, baseEnd: 4, otherStart: 3, otherEnd: 4 },
    ]);
  });

  test("everything replaced", () => {
    expect(diffLines(["a"], ["x", "y"])).toEqual([
      { baseStart: 0, baseEnd: 1, otherStart: 0, otherEnd: 2 },
    ]);
  });
});

describe("mergeLines", () => {
  const base = ["# t", "", "- a", "- b", "- c"];

  test("changes on different lines of both sides are all kept", () => {
    const ours = ["# t", "", "- A", "- b", "- c"];
    const theirs = ["# t", "", "- a", "- b", "- c", "- d"];
    expect(mergeLines(base, ours, theirs)).toEqual(["# t", "", "- A", "- b", "- c", "- d"]);
  });

  test("neighbouring line edits on both sides do not conflict", () => {
    const ours = ["# t", "", "- A", "- b", "- c"];
    const theirs = ["# t", "", "- a", "- B", "- c"];
    expect(mergeLines(base, ours, theirs)).toEqual(["# t", "", "- A", "- B", "- c"]);
  });

  test("the user wins a conflict", () => {
    const ours = ["# t", "", "- mine", "- b", "- c"];
    const theirs = ["# t", "", "- theirs", "- extra", "- b", "- c"];
    expect(mergeLines(base, ours, theirs)).toEqual(["# t", "", "- mine", "- b", "- c"]);
  });

  test("a line the user deleted stays deleted when the render did not touch it", () => {
    const ours = ["# t", "", "- a", "- c"];
    expect(mergeLines(base, ours, base)).toEqual(ours);
  });
});
