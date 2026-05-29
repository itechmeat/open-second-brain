import { test, expect } from "bun:test";
import { applyCharBudget } from "../../../src/core/brain/recall-budget.ts";

const e = (item: string, text: string) => ({ item, text });

test("with no options every entry passes through untrimmed and nothing is dropped", () => {
  const r = applyCharBudget([e("a", "hello"), e("b", "world")], {});
  expect(r.kept.map((k) => k.text)).toEqual(["hello", "world"]);
  expect(r.kept.every((k) => !k.trimmed)).toBe(true);
  expect(r.dropped).toEqual([]);
  expect(r.totalChars).toBe(10);
});

test("maxCharsPerEntry truncates an oversized entry and flags it trimmed", () => {
  const r = applyCharBudget([e("a", "abcdefghij")], { maxCharsPerEntry: 4 });
  expect(r.kept[0]!.text).toBe("abcd");
  expect(r.kept[0]!.trimmed).toBe(true);
});

test("an entry at or under the per-entry cap is untouched", () => {
  const r = applyCharBudget([e("a", "abcd"), e("b", "ab")], { maxCharsPerEntry: 4 });
  expect(r.kept.map((k) => k.text)).toEqual(["abcd", "ab"]);
  expect(r.kept.every((k) => !k.trimmed)).toBe(true);
});

test("per-entry cap is measured in code points, not UTF-16 units", () => {
  // 5 astral code points; cap 3 keeps exactly 3 code points intact.
  const r = applyCharBudget([e("a", "😀😁😂😃😄")], { maxCharsPerEntry: 3 });
  expect([...r.kept[0]!.text].length).toBe(3);
  expect(r.kept[0]!.text).toBe("😀😁😂");
});

test("a non-positive per-entry cap disables trimming", () => {
  const r = applyCharBudget([e("a", "abcdef")], { maxCharsPerEntry: 0 });
  expect(r.kept[0]!.text).toBe("abcdef");
  expect(r.kept[0]!.trimmed).toBe(false);
});

test("entry order is preserved", () => {
  const r = applyCharBudget([e("a", "x"), e("b", "y"), e("c", "z")], { maxCharsPerEntry: 10 });
  expect(r.kept.map((k) => k.item)).toEqual(["a", "b", "c"]);
});

test("maxTotalChars keeps entries until the cap and drops lowest-priority overflow", () => {
  const r = applyCharBudget([e("a", "aaaa"), e("b", "bbbb"), e("c", "cccc")], { maxTotalChars: 8 });
  expect(r.kept.map((k) => k.item)).toEqual(["a", "b"]);
  expect(r.dropped).toEqual(["c"]);
  expect(r.totalChars).toBe(8);
});

test("total cap is measured in code points", () => {
  const r = applyCharBudget([e("a", "😀😀"), e("b", "😁😁")], { maxTotalChars: 3 });
  expect(r.kept.map((k) => k.item)).toEqual(["a"]);
  expect(r.dropped).toEqual(["b"]);
});

test("per-entry trim and total cap compose (trim first, then total)", () => {
  const r = applyCharBudget([e("a", "aaaaaa"), e("b", "bbbbbb")], {
    maxCharsPerEntry: 3,
    maxTotalChars: 5,
  });
  expect(r.kept.map((k) => k.text)).toEqual(["aaa"]);
  expect(r.dropped).toEqual(["b"]);
});

test("a smaller tail entry still fits after a larger overflow is dropped", () => {
  const r = applyCharBudget([e("a", "aaaa"), e("big", "bbbbbbbb"), e("c", "cc")], {
    maxTotalChars: 6,
  });
  expect(r.kept.map((k) => k.item)).toEqual(["a", "c"]);
  expect(r.dropped).toEqual(["big"]);
});

test("is deterministic for identical inputs", () => {
  const input = [e("a", "abcdef"), e("b", "ghijkl")];
  expect(applyCharBudget(input, { maxCharsPerEntry: 3 })).toEqual(
    applyCharBudget(input, { maxCharsPerEntry: 3 }),
  );
});
