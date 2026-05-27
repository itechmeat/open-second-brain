/**
 * Content-hash helper for confirmed preferences. The hash is written
 * into `_content_hash` on promotion and recomputed at read time; a
 * mismatch surfaces as a `drift_detected` event (Task 4).
 */

import { describe, expect, test } from "bun:test";

import { computeContentHash, verifyContentHash } from "../../../src/core/brain/content-hash.ts";

describe("computeContentHash", () => {
  test("returns a 64-char lowercase hex sha256 digest", () => {
    const hash = computeContentHash("do the right thing", "coding");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("is deterministic for the same (principle, scope)", () => {
    const a = computeContentHash("do the right thing", "coding");
    const b = computeContentHash("do the right thing", "coding");
    expect(a).toBe(b);
  });

  test("differs when principle differs", () => {
    const a = computeContentHash("do A", "coding");
    const b = computeContentHash("do B", "coding");
    expect(a).not.toBe(b);
  });

  test("differs when scope differs", () => {
    const a = computeContentHash("do A", "coding");
    const b = computeContentHash("do A", "writing");
    expect(a).not.toBe(b);
  });

  test("treats absent and empty scope the same way (both normalise to empty)", () => {
    // The frontmatter writer never emits an empty `scope`; absent means
    // "no scope". Hash must reflect this so a parser later reading the
    // file (which sees scope as undefined) recomputes the same digest.
    const a = computeContentHash("do A");
    const b = computeContentHash("do A", "");
    const c = computeContentHash("do A", undefined);
    expect(a).toBe(b);
    expect(a).toBe(c);
  });

  test("trims leading and trailing whitespace from principle and scope", () => {
    // Frontmatter round-trips can introduce whitespace; the hash must be
    // stable across "  text " and "text" so a no-op rewrite does not
    // appear as drift.
    const a = computeContentHash("the rule", "scope");
    const b = computeContentHash("  the rule  ", "  scope  ");
    expect(a).toBe(b);
  });
});

describe("verifyContentHash", () => {
  test("returns ok=true when the stored hash matches the recomputed hash", () => {
    const principle = "explain the why, not the what";
    const scope = "writing";
    const stored = computeContentHash(principle, scope);
    const result = verifyContentHash({ principle, scope, content_hash: stored });
    expect(result.ok).toBe(true);
    expect(result.expected).toBe(stored);
    expect(result.observed).toBe(stored);
  });

  test("returns ok=false when the stored hash diverges from the recomputed hash", () => {
    const result = verifyContentHash({
      principle: "altered principle after a hand edit",
      scope: "coding",
      content_hash: "0".repeat(64),
    });
    expect(result.ok).toBe(false);
    expect(result.expected).toBe(
      computeContentHash("altered principle after a hand edit", "coding"),
    );
    expect(result.observed).toBe("0".repeat(64));
  });

  test("returns ok=true with neutral output when content_hash is absent (legacy)", () => {
    const result = verifyContentHash({
      principle: "p",
      scope: "s",
      content_hash: undefined,
    });
    expect(result.ok).toBe(true);
    // No expected/observed when no hash to compare against - the caller
    // must not log a drift event in this case.
    expect(result.expected).toBeUndefined();
    expect(result.observed).toBeUndefined();
  });
});
