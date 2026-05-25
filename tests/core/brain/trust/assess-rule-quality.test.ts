/**
 * Language-agnostic structural quality gate for taste signals.
 *
 * The detector reads only bytes / codepoints; it must NOT carry any
 * language-specific vocabulary list, stopword list, or unit dictionary.
 * Tests use shape placeholders (`<TOK>`, digits, operator chars) so the
 * fixture set has no specific-language bias.
 */

import { describe, expect, test } from "bun:test";

import { assessRuleQuality } from "../../../../src/core/brain/trust/assess-rule-quality.ts";

describe("assessRuleQuality - reject conditions", () => {
  test("empty principle", () => {
    const r = assessRuleQuality("");
    expect(r.severity).toBe("reject");
    expect(r.reasons).toContain("empty");
  });

  test("whitespace-only principle", () => {
    const r = assessRuleQuality("   \t\n  ");
    expect(r.severity).toBe("reject");
    expect(r.reasons).toContain("empty");
  });

  test("single token", () => {
    const r = assessRuleQuality("foo");
    expect(r.severity).toBe("reject");
    expect(r.reasons).toContain("single-token");
  });
});

describe("assessRuleQuality - warn conditions", () => {
  test("very long (more than 500 chars)", () => {
    const long = "a b c d e f g h i j".repeat(70);
    const r = assessRuleQuality(long);
    expect(r.severity).toBe("warn");
    expect(r.reasons).toContain("too-long");
  });

  test("very long by token count (more than 80 tokens)", () => {
    const tokens = Array(100).fill("xyz123").join(" ");
    const r = assessRuleQuality(tokens);
    // Has digits so signal-present, but too many tokens triggers warn
    expect(r.severity).toBe("warn");
    expect(r.reasons).toContain("too-long");
  });

  test("no digit, no operator-shape char (no measurable signal)", () => {
    const r = assessRuleQuality("alpha beta gamma delta epsilon");
    expect(r.severity).toBe("warn");
    expect(r.reasons).toContain("no-measurable-signal");
  });

  test("high single-character filler ratio (above 0.4)", () => {
    const r = assessRuleQuality("a b c d e f g h i j 10");
    expect(r.severity).toBe("warn");
    expect(r.reasons).toContain("filler-ratio-high");
  });
});

describe("assessRuleQuality - ok conditions", () => {
  test("imperative-shaped with numeric outcome (digit present)", () => {
    const r = assessRuleQuality("limit retries to 10 per hour");
    expect(r.severity).toBe("ok");
    expect(r.reasons).toEqual([]);
  });

  test("operator-shape char (no digit, but operator present)", () => {
    const r = assessRuleQuality("each block must terminate with > marker");
    expect(r.severity).toBe("ok");
  });

  test("non-ASCII codepoints with embedded digit (multi-codepoint tokens)", () => {
    // Using BMP non-Latin codepoints by their code-point value, not
    // by any language-specific phrase. The detector is shape-blind:
    // multi-codepoint tokens here exercise the same path as
    // multi-character Latin tokens.
    const r = assessRuleQuality(
      "\u{4E00}\u{4E01}\u{4E02}\u{4E03} 7 \u{4E04}\u{4E05}\u{4E06}\u{4E07}",
    );
    expect(r.severity).toBe("ok");
  });

  test("structured rule with operator and digit", () => {
    const r = assessRuleQuality("response time must stay < 100 ms in production");
    expect(r.severity).toBe("ok");
  });
});

describe("assessRuleQuality - structural invariants", () => {
  test("score is finite and in [0, 1]", () => {
    for (const input of ["", "a", "x y z", "limit foo to 10"]) {
      const r = assessRuleQuality(input);
      expect(Number.isFinite(r.score)).toBe(true);
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1);
    }
  });

  test("reasons array always defined (possibly empty)", () => {
    const r = assessRuleQuality("limit retries to 10 per hour");
    expect(Array.isArray(r.reasons)).toBe(true);
  });

  test("returned object is frozen", () => {
    const r = assessRuleQuality("test 1");
    expect(Object.isFrozen(r)).toBe(true);
  });
});
