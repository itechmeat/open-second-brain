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

test("is deterministic for identical inputs", () => {
  const input = [e("a", "abcdef"), e("b", "ghijkl")];
  expect(applyCharBudget(input, { maxCharsPerEntry: 3 })).toEqual(
    applyCharBudget(input, { maxCharsPerEntry: 3 }),
  );
});
