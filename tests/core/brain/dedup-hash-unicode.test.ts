/**
 * Regression coverage for the Unicode-aware dedup-hash path (F7).
 * These cases existed prior to the NFKC + casefold switch but were
 * not pinned; today the hash for `Hello` and `Ｈｅｌｌｏ` differs.
 */

import { describe, expect, test } from "bun:test";

import { computeDedupHash } from "../../../src/core/brain/dedup-hash.ts";

describe("computeDedupHash (unicode-aware)", () => {
  test("fullwidth vs halfwidth principle hashes identically", () => {
    const a = computeDedupHash({
      topic: "rule",
      signal: "positive",
      principle: "Hello world",
    });
    const b = computeDedupHash({
      topic: "rule",
      signal: "positive",
      principle: "Ｈｅｌｌｏ world",
    });
    expect(a).toBe(b);
  });

  test("uppercase vs lowercase principle hashes identically", () => {
    const a = computeDedupHash({
      topic: "rule",
      signal: "positive",
      principle: "Use imperative voice",
    });
    const b = computeDedupHash({
      topic: "rule",
      signal: "positive",
      principle: "USE IMPERATIVE VOICE",
    });
    expect(a).toBe(b);
  });

  test("NFC vs NFD decomposed accent hashes identically", () => {
    const a = computeDedupHash({
      topic: "ru",
      signal: "positive",
      principle: "café au lait",
    });
    const b = computeDedupHash({
      topic: "ru",
      signal: "positive",
      principle: "café au lait",
    });
    expect(a).toBe(b);
  });

  test("CJK principle does not collapse to empty string", () => {
    const a = computeDedupHash({
      topic: "ja",
      signal: "positive",
      principle: "テスト ルール",
    });
    const b = computeDedupHash({
      topic: "ja",
      signal: "positive",
      principle: "別のテスト",
    });
    expect(a).not.toBe(b);
    expect(a.length).toBe(64);
    expect(b.length).toBe(64);
  });

  test("Cyrillic principle hashes case-insensitively", () => {
    const a = computeDedupHash({
      topic: "ru-rule",
      signal: "positive",
      principle: "Используй императив",
    });
    const b = computeDedupHash({
      topic: "ru-rule",
      signal: "positive",
      principle: "ИСПОЛЬЗУЙ ИМПЕРАТИВ",
    });
    expect(a).toBe(b);
  });

  test("topic and scope are also normalised", () => {
    const a = computeDedupHash({
      topic: "Writing",
      signal: "positive",
      principle: "Keep it short",
      scope: "Docs",
    });
    const b = computeDedupHash({
      topic: "writing",
      signal: "positive",
      principle: "Keep it short",
      scope: "docs",
    });
    expect(a).toBe(b);
  });

  test("signal sign is NOT normalised (positive ≠ Positive collision impossible)", () => {
    // The signal field is a discriminated union of exactly two
    // literals; type system already protects against it. This
    // assertion just documents that we don't touch it.
    const a = computeDedupHash({
      topic: "rule",
      signal: "positive",
      principle: "x",
    });
    const b = computeDedupHash({
      topic: "rule",
      signal: "negative",
      principle: "x",
    });
    expect(a).not.toBe(b);
  });
});
