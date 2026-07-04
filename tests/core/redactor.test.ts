import { describe, expect, test } from "bun:test";

import {
  PRIVATE_REGION_PLACEHOLDER,
  SCAN_TRUNCATED_MARKER,
  normaliseTextField,
  redactRawOutput,
  sanitiseTextField,
  stripPrivateRegions,
  wasScanTruncated,
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

  test("strips nested private regions atomically", () => {
    const input = "before <private>a<private>b</private>c</private> after";
    expect(stripPrivateRegions(input)).toBe(`before ${PRIVATE_REGION_PLACEHOLDER} after`);
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

describe("redactRawOutput fail-closed truncation", () => {
  test("appends the scan-truncated marker when input exceeds maxInput", () => {
    const out = redactRawOutput("x".repeat(100), { maxInput: 10 });
    expect(out).toContain(SCAN_TRUNCATED_MARKER.trim());
    expect(wasScanTruncated(out)).toBe(true);
  });

  test("does not flag input that fits within the window", () => {
    const out = redactRawOutput("small payload", { maxInput: 1024 });
    expect(wasScanTruncated(out)).toBe(false);
    expect(out).toBe("small payload");
  });

  test("still scrubs secrets within the kept prefix on truncated input", () => {
    const head = "api_key=topsecret\n";
    const out = redactRawOutput(head + "y".repeat(100), { maxInput: head.length + 5 });
    expect(out).toContain("api_key=***REDACTED***");
    expect(out).not.toContain("topsecret");
    expect(wasScanTruncated(out)).toBe(true);
  });

  test("wasScanTruncated tolerates non-string input", () => {
    expect(wasScanTruncated(undefined as unknown as string)).toBe(false);
  });

  test("Infinity maxInput never truncates (artifact-store contract)", () => {
    const big = "z".repeat(2 * 1024 * 1024);
    const out = redactRawOutput(big, { maxInput: Number.POSITIVE_INFINITY });
    expect(wasScanTruncated(out)).toBe(false);
    expect(out.length).toBe(big.length);
  });
});

describe("redactRawOutput infra-topology pass (redactInfra)", () => {
  test("is off by default — bare coordinates pass through", () => {
    const input = "reach 8.8.8.8 and db.example.com:5432";
    expect(redactRawOutput(input)).toBe(input);
  });

  test("redacts public IPv4 but leaves private/reserved ranges", () => {
    const out = redactRawOutput("pub 8.8.8.8 priv 10.0.0.5 lo 127.0.0.1 lan 192.168.1.1", {
      redactInfra: true,
    });
    expect(out).toContain("pub ***REDACTED***");
    expect(out).toContain("priv 10.0.0.5");
    expect(out).toContain("lo 127.0.0.1");
    expect(out).toContain("lan 192.168.1.1");
  });

  test("does not mistake a version string for an IPv4", () => {
    const out = redactRawOutput("v1.2.3.4 and 1.2.3.4.5", { redactInfra: true });
    expect(out).toBe("v1.2.3.4 and 1.2.3.4.5");
  });

  test("redacts ipv4:port endpoints regardless of range", () => {
    const out = redactRawOutput("db at 10.0.0.5:5432 cache 8.8.8.8:6379", { redactInfra: true });
    expect(out).toContain("db at ***REDACTED***");
    expect(out).toContain("cache ***REDACTED***");
    expect(out).not.toContain("5432");
    expect(out).not.toContain("6379");
  });

  test("redacts fqdn:port endpoints", () => {
    const out = redactRawOutput("connect db.example.com:5432", { redactInfra: true });
    expect(out).toContain("connect ***REDACTED***");
    expect(out).not.toContain("db.example.com");
  });

  test("leaves file:line references untouched (no false-positive fqdn:port)", () => {
    // Diagnostics and stack frames (`index.js:42`, `app.ts:128`) must not be
    // mistaken for service endpoints when redactInfra runs over tool output.
    const input = "error at src/app.ts:128 see lib/index.js:42 and tests/main.py:10";
    const out = redactRawOutput(input, { redactInfra: true });
    expect(out).toContain("src/app.ts:128");
    expect(out).toContain("lib/index.js:42");
    expect(out).toContain("tests/main.py:10");
    expect(out).not.toContain("REDACTED");
  });

  test("strips basic-auth credentials from URLs but keeps scheme and host", () => {
    const out = redactRawOutput("git clone https://alice:hunter2@github.com/x.git", {
      redactInfra: true,
    });
    expect(out).toContain("https://***REDACTED***@github.com/x.git");
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("alice");
  });

  test("redacts internal hostnames", () => {
    const out = redactRawOutput("ping db.internal and app.svc.cluster.local", {
      redactInfra: true,
    });
    expect(out).not.toContain("db.internal");
    expect(out).not.toContain("svc.cluster.local");
  });

  test("redacts public IPv6 but leaves loopback and link-local", () => {
    const out = redactRawOutput("pub 2001:db8:0:0:0:0:0:1 lo ::1 ll fe80::1", {
      redactInfra: true,
    });
    expect(out).toContain("pub ***REDACTED***");
    expect(out).toContain("lo ::1");
    expect(out).toContain("ll fe80::1");
  });

  test("does not mistake HH:MM:SS timestamps for IPv6", () => {
    const input = "event at 12:34:56 done";
    expect(redactRawOutput(input, { redactInfra: true })).toBe(input);
  });

  test("stays linear on a large adversarial infra-shaped input (no ReDoS)", () => {
    const evil = `${"1234:".repeat(5000)}z`;
    // Should return promptly; a catastrophic-backtracking regex would hang.
    const out = redactRawOutput(evil, { redactInfra: true });
    expect(typeof out).toBe("string");
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
