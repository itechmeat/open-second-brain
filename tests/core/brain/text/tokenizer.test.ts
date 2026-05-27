import { describe, expect, test } from "bun:test";

import { estimateTokens } from "../../../../src/core/brain/text/tokenizer.ts";

// The heuristic is `ceil(utf8_bytes / 4)`, so tests assert language-
// agnostic invariants (determinism, monotonicity, non-zero on
// non-empty input) plus a handful of computed byte-based ground
// truths. No script-specific magic numbers - the implementation
// must not special-case any human language.

const utf8Len = (s: string) => new TextEncoder().encode(s).length;

describe("estimateTokens", () => {
  test("empty input returns 0", () => {
    expect(estimateTokens("")).toBe(0);
  });

  test("matches ceil(utf8_bytes / 4) for ASCII", () => {
    const s = "Use imperative voice";
    expect(estimateTokens(s)).toBe(Math.ceil(utf8Len(s) / 4));
  });

  test("matches ceil(utf8_bytes / 4) for arbitrary multibyte scripts", () => {
    // No script is special-cased: the formula must hold for every
    // input, regardless of which scripts it mixes.
    const samples = [
      "Hello", // Latin ASCII
      "café au lait", // Latin extended (NFC)
      "Тест", // Cyrillic
      "テスト", // Hiragana / Katakana
      "안녕하세요", // Hangul
      "مرحبا", // Arabic
      "สวัสดี", // Thai (with combining marks)
      "नमस्ते", // Devanagari (Hindi)
      "ｱｲｳ", // Halfwidth katakana
      "🦊🚀", // Emoji
      "Hello テスト مرحبا 🦊", // Mixed
    ];
    for (const s of samples) {
      expect(estimateTokens(s)).toBe(Math.ceil(utf8Len(s) / 4));
    }
  });

  test("non-empty input always yields at least one token", () => {
    const samples = ["a", "テ", "🦊", " ", "."];
    for (const s of samples) {
      expect(estimateTokens(s)).toBeGreaterThanOrEqual(1);
    }
  });

  test("monotonic - concatenating strings can only grow the count", () => {
    const a = "alpha beta gamma";
    const b = " delta epsilon";
    expect(estimateTokens(a + b)).toBeGreaterThanOrEqual(estimateTokens(a));
  });

  test("deterministic across runs", () => {
    const sample = "The quick brown fox jumps over the lazy dog 123 #tag テスト";
    expect(estimateTokens(sample)).toBe(estimateTokens(sample));
  });

  test("scales linearly with repetition", () => {
    const single = "word ";
    const x100 = single.repeat(100);
    // 100 repetitions of the same byte sequence yields exactly 100
    // times the byte count, so the heuristic is linear.
    expect(estimateTokens(x100)).toBe(Math.ceil(utf8Len(x100) / 4));
  });

  test("no special-case for any script - equal byte length yields equal count", () => {
    // Construct two inputs in different scripts that share a byte
    // length, then assert the heuristic ignores which script they
    // come from.
    const cyrillic = "тестт";
    const len = utf8Len(cyrillic);
    const ascii = "x".repeat(len);
    expect(utf8Len(ascii)).toBe(len);
    expect(estimateTokens(cyrillic)).toBe(estimateTokens(ascii));
  });
});
