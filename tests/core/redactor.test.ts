import { describe, expect, test } from "bun:test";

import { normaliseTextField, redactRawOutput, sanitiseTextField } from "../../src/core/redactor.ts";

describe("redactRawOutput (cross-module backward compat)", () => {
  test("masks api_key in env-style assignment", () => {
    expect(redactRawOutput("api_key=abcd1234")).toContain("api_key=***REDACTED***");
  });

  test("masks token in YAML-style colon assignment", () => {
    expect(redactRawOutput("token: abcdef")).toContain("token: ***REDACTED***");
  });

  test("preserves `Bearer ` prefix while masking the token", () => {
    const out = redactRawOutput("Authorization: Bearer eyJhbGci...");
    expect(out).toContain("Bearer ***REDACTED***");
  });
});

describe("normaliseTextField", () => {
  test("returns empty string for non-string input", () => {
    expect(normaliseTextField(123 as unknown, { maxLen: 10 })).toBe("");
    expect(normaliseTextField(null, { maxLen: 10 })).toBe("");
    expect(normaliseTextField(undefined, { maxLen: 10 })).toBe("");
  });

  test("strips forbidden C0 control characters but keeps tab and newline", () => {
    const input = "ok\x00\x01\x07\x08\x0B\x0C\x0E\x1F\x7Fbye";
    expect(normaliseTextField(input, { maxLen: 100 })).toBe("okbye");

    const multi = "a\tb\nc";
    expect(normaliseTextField(multi, { maxLen: 100 })).toBe("a\tb\nc");
  });

  test("folds U+2028 / U+2029 to \\n", () => {
    // U+2028 line separator, U+2029 paragraph separator.
    const input = "line1 line2 line3";
    expect(normaliseTextField(input, { maxLen: 100 })).toBe("line1\nline2\nline3");
  });

  test("singleLine collapses \\n / \\r / \\t runs to single space", () => {
    const input = "a\n\nb\tc\r\nd";
    expect(normaliseTextField(input, { maxLen: 100, singleLine: true })).toBe("a b c d");
  });

  test("non-singleLine normalises CRLF/CR to LF", () => {
    expect(normaliseTextField("a\r\nb\rc", { maxLen: 100 })).toBe("a\nb\nc");
  });

  test("caps length to maxLen", () => {
    expect(normaliseTextField("a".repeat(20), { maxLen: 5 })).toBe("aaaaa");
  });

  test("NFC-normalises combining characters", () => {
    // "é" composed (1 code unit) vs decomposed (2 code units).
    const decomposed = "é"; // e + combining acute
    expect(normaliseTextField(decomposed, { maxLen: 100 })).toBe("é");
  });

  test("never throws on garbled UTF-16 surrogates", () => {
    const lonely = "ok\uD800bad";
    expect(() => normaliseTextField(lonely, { maxLen: 100 })).not.toThrow();
  });
});

describe("sanitiseTextField", () => {
  test("composes redact + normalise + cap", () => {
    const input = "principle with api_key=secret123 and U+2028 here";
    const out = sanitiseTextField(input, { maxLen: 100, singleLine: true });
    expect(out).toContain("***REDACTED***");
    expect(out).not.toContain("secret123");
    expect(out).not.toContain(" ");
  });

  test("returns empty for non-string input", () => {
    expect(sanitiseTextField(undefined, { maxLen: 10 })).toBe("");
  });
});
