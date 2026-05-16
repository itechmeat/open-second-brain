/**
 * Tests for `computeDedupHash` — the normalised payload hash shared
 * between §9 inline `scan-inline` and §16 `import-session` for
 * idempotency. A marker in a Daily note and the same payload replayed
 * from a session tool_use must hash identically.
 */

import { describe, expect, test } from "bun:test";

import { computeDedupHash } from "../../src/core/brain/dedup-hash.ts";

describe("computeDedupHash", () => {
  test("returns a 64-char hex sha256 digest", () => {
    const h = computeDedupHash({ topic: "x", signal: "negative", principle: "p" });
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  test("is stable across NFC variants of the same character", () => {
    // "naïve" — first form is NFC (single ï), second is NFD (i + combining ¨).
    const nfc = "naïve";
    const nfd = "naïve";
    expect(nfc).not.toBe(nfd); // sanity: they really are different code units
    const a = computeDedupHash({ topic: "x", signal: "negative", principle: nfc });
    const b = computeDedupHash({ topic: "x", signal: "negative", principle: nfd });
    expect(a).toBe(b);
  });

  test("collapses runs of internal whitespace in principle", () => {
    const a = computeDedupHash({ topic: "x", signal: "negative", principle: "a   b   c" });
    const b = computeDedupHash({ topic: "x", signal: "negative", principle: "a b c" });
    expect(a).toBe(b);
  });

  test("trims leading/trailing whitespace in principle", () => {
    const a = computeDedupHash({ topic: "x", signal: "negative", principle: "  p  " });
    const b = computeDedupHash({ topic: "x", signal: "negative", principle: "p" });
    expect(a).toBe(b);
  });

  test("treats undefined and empty-string scope identically", () => {
    const a = computeDedupHash({ topic: "x", signal: "negative", principle: "p" });
    const b = computeDedupHash({ topic: "x", signal: "negative", principle: "p", scope: "" });
    expect(a).toBe(b);
  });

  test("differs when topic differs", () => {
    const a = computeDedupHash({ topic: "x", signal: "negative", principle: "p" });
    const b = computeDedupHash({ topic: "y", signal: "negative", principle: "p" });
    expect(a).not.toBe(b);
  });

  test("differs when signal flips sign", () => {
    const a = computeDedupHash({ topic: "x", signal: "negative", principle: "p" });
    const b = computeDedupHash({ topic: "x", signal: "positive", principle: "p" });
    expect(a).not.toBe(b);
  });

  test("differs when principle differs after normalisation", () => {
    const a = computeDedupHash({ topic: "x", signal: "negative", principle: "p1" });
    const b = computeDedupHash({ topic: "x", signal: "negative", principle: "p2" });
    expect(a).not.toBe(b);
  });

  test("differs when scope differs", () => {
    const a = computeDedupHash({ topic: "x", signal: "negative", principle: "p", scope: "ru" });
    const b = computeDedupHash({ topic: "x", signal: "negative", principle: "p", scope: "en" });
    expect(a).not.toBe(b);
  });
});
