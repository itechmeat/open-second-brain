import { describe, expect, test } from "bun:test";

import {
  PRIVATE_REGION_PLACEHOLDER,
  normaliseTextField,
  redactRawOutput,
  sanitiseTextField,
  stripPrivateRegions,
} from "../../src/core/redactor.ts";

describe("stripPrivateRegions", () => {
  test("strips balanced private regions across lines", () => {
    const input = "before <private>secret\nbody token=abc</private> after";
    expect(stripPrivateRegions(input)).toBe(`before ${PRIVATE_REGION_PLACEHOLDER} after`);
  });

  test("matches private tags case-insensitively", () => {
    const input = "A <PRIVATE>hidden</PrIvAtE> B";
    expect(stripPrivateRegions(input)).toBe(`A ${PRIVATE_REGION_PLACEHOLDER} B`);
  });

  test("strips from an unclosed private tag to the end", () => {
    const input = "keep <private>hide forever";
    expect(stripPrivateRegions(input)).toBe(`keep ${PRIVATE_REGION_PLACEHOLDER}`);
  });

  test("runs before assignment redaction in redactRawOutput", () => {
    const input = "visible api_key=keep <private>api_key=secret</private>";
    const out = redactRawOutput(input);
    expect(out).toContain("api_key=***REDACTED***");
    expect(out).toContain(PRIVATE_REGION_PLACEHOLDER);
    expect(out).not.toContain("secret");
  });
});

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
