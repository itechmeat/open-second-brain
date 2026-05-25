/**
 * Tests for `normalizeForDedup` — the NFKC + casefold helper that
 * dedup-hash and other key-construction sites call before hashing or
 * comparing inputs. Behaviour invariants below pin the cases that
 * the previous `normalize("NFC")` call missed.
 */

import { describe, expect, test } from "bun:test";

import { normalizeForDedup } from "../../../../src/core/brain/text/normalize.ts";

describe("normalizeForDedup", () => {
  test("collapses fullwidth and halfwidth Latin to the same form", () => {
    const halfwidth = normalizeForDedup("Hello");
    const fullwidth = normalizeForDedup("Ｈｅｌｌｏ");
    expect(fullwidth).toBe(halfwidth);
  });

  test("collapses uppercase and lowercase to the same form", () => {
    expect(normalizeForDedup("Hello")).toBe(normalizeForDedup("hello"));
    expect(normalizeForDedup("HELLO")).toBe(normalizeForDedup("hello"));
  });

  test("collapses NFD (decomposed) and NFC (precomposed) accents", () => {
    // é can be written as U+00E9 (NFC) or U+0065 U+0301 (NFD).
    const precomposed = normalizeForDedup("café");
    const decomposed = normalizeForDedup("café");
    expect(precomposed).toBe(decomposed);
  });

  test("preserves CJK content without collapsing to empty string", () => {
    const out = normalizeForDedup("テスト");
    expect(out.length).toBeGreaterThan(0);
    expect(out).toContain("テスト");
  });

  test("preserves Cyrillic content with case folding", () => {
    expect(normalizeForDedup("Тест")).toBe(normalizeForDedup("тест"));
    expect(normalizeForDedup("ТЕСТ")).toBe(normalizeForDedup("тест"));
  });

  test("idempotent — applying twice equals once", () => {
    const inputs = ["Hello", "テスト", "café", "Тест", "Ｈ"];
    for (const s of inputs) {
      const once = normalizeForDedup(s);
      const twice = normalizeForDedup(once);
      expect(twice).toBe(once);
    }
  });

  test("does not strip whitespace or punctuation", () => {
    const out = normalizeForDedup("a b; c");
    expect(out).toBe("a b; c");
  });

  test("handles empty string", () => {
    expect(normalizeForDedup("")).toBe("");
  });
});
