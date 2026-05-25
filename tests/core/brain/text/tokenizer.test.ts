import { describe, expect, test } from "bun:test";

import { estimateTokens } from "../../../../src/core/brain/text/tokenizer.ts";

describe("estimateTokens", () => {
  test("empty input returns 0", () => {
    expect(estimateTokens("")).toBe(0);
  });

  test("English prose counts roughly 1.3 tokens per word", () => {
    // "Use imperative voice" - 3 words → ceil(3 * 1.3) = 4
    expect(estimateTokens("Use imperative voice")).toBe(4);
  });

  test("punctuation clusters round up", () => {
    const t = estimateTokens("hello, world!");
    expect(t).toBeGreaterThanOrEqual(3);
  });

  test("CJK characters count one token per character", () => {
    // "テスト" = 3 katakana characters → 3 CJK tokens, 0 words
    expect(estimateTokens("テスト")).toBe(3);
  });

  test("mixed CJK + Latin sums both buckets", () => {
    // "hello テスト" = 1 word (hello) + 3 CJK chars = ceil(1 * 1.3) + 3 = 5
    expect(estimateTokens("hello テスト")).toBe(5);
  });

  test("deterministic across runs", () => {
    const sample = "The quick brown fox jumps over the lazy dog 123 #tag";
    expect(estimateTokens(sample)).toBe(estimateTokens(sample));
  });

  test("hangul counts per character", () => {
    // "안녕하세요" 5 hangul chars
    expect(estimateTokens("안녕하세요")).toBe(5);
  });

  test("whitespace runs do not inflate count", () => {
    expect(estimateTokens("a   b   c")).toBe(estimateTokens("a b c"));
  });

  test("very long English prose scales linearly", () => {
    const phrase = "word ".repeat(100).trim();
    expect(estimateTokens(phrase)).toBe(Math.ceil(100 * 1.3));
  });
});
