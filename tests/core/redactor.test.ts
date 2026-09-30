import { describe, expect, test } from "bun:test";

import {
  PRIVATE_REGION_PLACEHOLDER,
  REDACTION_PLACEHOLDER,
  SCAN_TRUNCATED_MARKER,
  normaliseTextField,
  redactRawOutput,
  sanitiseTextField,
  stripPrivateRegions,
  wasScanTruncated,
} from "../../src/core/redactor.ts";
import { EGRESS_OUTCOME, redactForEgress } from "../../src/core/egress/guard.ts";
import { fakeCredential } from "../helpers/fake-credentials.ts";

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
    // Quoted: the placeholder opens with `*`, which YAML reads as an alias
    // node, so the bare form left a redacted mapping unparseable. See
    // tests/core/redactor-yaml-structure.test.ts.
    expect(redactRawOutput("token: abcdef")).toContain(
      `token: ${JSON.stringify(REDACTION_PLACEHOLDER)}`,
    );
  });

  test("preserves `Bearer ` prefix while masking the token", () => {
    const out = redactRawOutput("Authorization: Bearer eyJhbGci...");
    expect(out).toContain("Bearer ***REDACTED***");
  });
});

describe("redactRawOutput env-style assignment under a PREFIXED key name", () => {
  // `\b` used to stand at the front of this pattern, and `_` is a word
  // character, so the boundary never fired after one: the two most common
  // spellings a credential takes in a shell line or an agent transcript
  // went through untouched while the unprefixed one was caught. What did
  // come out redacted in the common cases came out through the
  // vendor-prefix rule on the VALUE, not through this key-name pass.
  test("a vendor-neutral value under a prefixed key name is redacted", () => {
    expect(redactRawOutput("export ANTHROPIC_API_KEY=hunter2secretvalue")).toBe(
      "export ANTHROPIC_API_KEY=***REDACTED***",
    );
    expect(redactRawOutput("MY_DB_PASSWORD=letmein12345")).toBe("MY_DB_PASSWORD=***REDACTED***");
    expect(redactRawOutput("SERVICE-ACCESS-TOKEN=plainish9value")).toBe(
      "SERVICE-ACCESS-TOKEN=***REDACTED***",
    );
  });

  test("the unprefixed spelling is still redacted", () => {
    expect(redactRawOutput("export API_KEY=hunter2secretvalue")).toBe(
      "export API_KEY=***REDACTED***",
    );
  });

  test("the prefix is kept, so the line still says which variable it was", () => {
    expect(redactRawOutput("export ANTHROPIC_API_KEY=hunter2secretvalue")).toContain("ANTHROPIC_");
  });

  test("a near miss keeps its value: the key must END at the assignment", () => {
    // `token` here is followed by `s`, not by `=`. A widened boundary that
    // fired anyway would eat the value of an ordinary CLI flag - and the
    // point of the boundary is that it separates a credential's NAME from
    // a word that merely contains one.
    expect(redactRawOutput("claude --max-tokens=4096")).toBe("claude --max-tokens=4096");
    expect(redactRawOutput("TOKENS_PER_MINUTE=90000")).toBe("TOKENS_PER_MINUTE=90000");
  });

  test("a near miss keeps its value: the key must START at a separator", () => {
    // Mid-identifier with no `_` or `-` in front of it is the same
    // under-match `\b` already had, left in place deliberately rather than
    // widened into every word ending in a secret name.
    expect(redactRawOutput("MYTOKEN=plainish9value")).toBe("MYTOKEN=plainish9value");
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

describe("URL credentials whose password carries a slash", () => {
  // The password class was `[^\s/@]+`, which excluded the one character a
  // generated database password most often carries. The regex then failed
  // the match ENTIRELY, so both the user and the password left verbatim -
  // a wider leak than if the pass had never run.
  const SLASH_PASSWORD_URL = "postgres://admin:s3cr3t/Tr4p@db.internal:5432/prod";

  test("the export-boundary default options redact user and password, keeping scheme and host", () => {
    const verdict = redactForEgress("brain-bank-export", { dsn: SLASH_PASSWORD_URL });
    expect(verdict.outcome).toBe(EGRESS_OUTCOME.released);
    if (verdict.outcome !== EGRESS_OUTCOME.released) throw new Error("unreachable");
    expect(verdict.payload.dsn).toBe("postgres://***REDACTED***@db.internal:5432/prod");
    expect(verdict.redacted).toBe(true);
  });

  test("redactUrlCredentials alone redacts user and password, keeping scheme and host", () => {
    const out = redactRawOutput(`connect ${SLASH_PASSWORD_URL} now`, {
      redactUrlCredentials: true,
    });
    expect(out).toBe("connect postgres://***REDACTED***@db.internal:5432/prod now");
  });

  test("the slash-free control URL redacts as before", () => {
    const out = redactRawOutput("git clone https://alice:hunter2@github.com/x.git", {
      redactUrlCredentials: true,
    });
    expect(out).toBe("git clone https://***REDACTED***@github.com/x.git");
  });
});

describe("URL credentials with an empty username", () => {
  // The `user:pass@` spelling requires a username, so the sibling spelling
  // connection strings actually use for password-only authorities -
  // `scheme://:pass@host` - matched nothing: the password rode past the
  // pass verbatim. The user half is optional; the colon and `@` anchors
  // stay, so a URL whose path carries an `@` but no userinfo colon is
  // still untouched.
  const EMPTY_USER_URL = "postgres://:s3cr3t@db.internal:5432/prod";
  const EMPTY_USER_SLASH_PASSWORD_URL = "redis://:s3cr3t/Tr4p@cache.internal:6379/0";

  test("the export-boundary default options redact a password-only userinfo section", () => {
    const verdict = redactForEgress("brain-bank-export", { dsn: EMPTY_USER_URL });
    expect(verdict.outcome).toBe(EGRESS_OUTCOME.released);
    if (verdict.outcome !== EGRESS_OUTCOME.released) throw new Error("unreachable");
    expect(verdict.payload.dsn).toBe("postgres://***REDACTED***@db.internal:5432/prod");
    expect(verdict.redacted).toBe(true);
  });

  test("redactUrlCredentials alone redacts an empty username with a slash password", () => {
    const out = redactRawOutput(`connect ${EMPTY_USER_SLASH_PASSWORD_URL} now`, {
      redactUrlCredentials: true,
    });
    expect(out).toBe("connect redis://***REDACTED***@cache.internal:6379/0 now");
  });

  test("a path-only `@` without a userinfo colon is not rewritten", () => {
    const out = redactRawOutput("see https://mastodon.social/@someone for the thread", {
      redactUrlCredentials: true,
    });
    expect(out).toBe("see https://mastodon.social/@someone for the thread");
  });
});

describe("URL credentials never swallow a port and a path", () => {
  // The password class crosses `/`, so without a guard the `host:port`
  // colon read as the userinfo colon and a later `@` in the path closed
  // the match: the host, the port and half the path became "credentials".
  const UNTOUCHED = [
    "https://example.com:443/a@b",
    "http://localhost:5173/@vite/client",
    "https://registry.npmjs.org:443/@types/node",
    "https://example.com:8443/users/alice@example.org",
    "see https://example.com:8080/users/@alice now",
  ];

  for (const url of UNTOUCHED) {
    test(`${url} stays byte-identical`, () => {
      expect(redactRawOutput(url, { redactUrlCredentials: true })).toBe(url);
    });
  }

  const REDACTED: Array<[string, string]> = [
    ["https://user:pa/ss@h/x", "https://***REDACTED***@h/x"],
    ["https://:secret@h", "https://***REDACTED***@h"],
    ["https://u:p?q@h", "https://***REDACTED***@h"],
    ["https://user:8080@h/x", "https://***REDACTED***@h/x"],
    ["https://alice:123?secret@host.example", "https://***REDACTED***@host.example"],
    ["https://u:123#x@h", "https://***REDACTED***@h"],
  ];

  test("a slash password that begins with digits is the documented miss, as on main", () => {
    const url = "https://bob:8080/x@host";
    expect(redactRawOutput(url, { redactUrlCredentials: true })).toBe(url);
  });

  for (const [input, expected] of REDACTED) {
    test(`${input} still redacts its userinfo`, () => {
      expect(redactRawOutput(input, { redactUrlCredentials: true })).toBe(expected);
    });
  }
});

describe("bare JWT (three base64url segments)", () => {
  // A JWT's header is compact JSON, so it always base64s to the `eyJ`
  // prefix; the 20-character canonical header slips the 24-character
  // high-entropy gate, and a bare token carries no key=value shape for the
  // assignment passes. Nothing below default options saw it at all.
  const JWT = fakeCredential(
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
    ".eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0",
    ".SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
  );

  test("a bare three-segment JWT is redacted under default options", () => {
    const out = redactRawOutput(`token ${JWT} end`);
    expect(out).toBe(`token ${REDACTION_PLACEHOLDER} end`);
  });

  test("a JWT leaf is redacted at the export boundary by default", () => {
    const verdict = redactForEgress("brain-bank-export", { pasted: JWT });
    expect(verdict.outcome).toBe(EGRESS_OUTCOME.released);
    if (verdict.outcome !== EGRESS_OUTCOME.released) throw new Error("unreachable");
    expect(verdict.payload.pasted).toBe(REDACTION_PLACEHOLDER);
    expect(verdict.redacted).toBe(true);
  });

  test("a JWT is redacted whole under the token pass too, not left half-standing", () => {
    // The high-entropy pass alone ate the payload and signature segments
    // and left the header: `eyJ…J9.***REDACTED***.***REDACTED***` still
    // announces a credential and hands over its algorithm.
    const out = redactRawOutput(`token ${JWT}`, { redactTokens: true });
    expect(out).toBe(`token ${REDACTION_PLACEHOLDER}`);
  });

  test("a Bearer-prefixed JWT keeps the prefix and one placeholder (regression guard)", () => {
    const out = redactRawOutput(`Authorization: Bearer ${JWT}`);
    expect(out).toBe("Authorization: Bearer ***REDACTED***");
  });

  test("a JWT with a payload longer than 4096 characters is redacted whole", () => {
    const payload = Buffer.from(JSON.stringify({ sub: "x".repeat(3300) })).toString("base64url");
    expect(payload.length).toBeGreaterThan(4096);
    const token = fakeCredential(
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
      `.${payload}`,
      ".c2lnbmF0dXJlLXNlZ21lbnQ",
    );
    expect(redactRawOutput(`token ${token} end`)).toBe(`token ${REDACTION_PLACEHOLDER} end`);
  });

  test("a JWT whose header JSON is whitespace-formatted is redacted", () => {
    for (const header of [
      '{ "alg": "HS256", "typ": "JWT" }',
      '{\n  "alg": "HS256"\n}',
      '{\t"alg":"HS256"}',
      '{\r\n"alg":"HS256"}',
    ]) {
      const encoded = Buffer.from(header).toString("base64url");
      const token = fakeCredential(
        encoded,
        ".eyJzdWIiOiIxMjM0NTY3ODkwIn0",
        ".c2lnbmF0dXJlLXNlZ21lbnQ",
      );
      expect(redactRawOutput(`token ${token} end`)).toBe(`token ${REDACTION_PLACEHOLDER} end`);
    }
  });

  test("short dotted words that merely start like a header stay prose", () => {
    const text = "see ewok.item.list and eyAb.cdef.ghij here";
    expect(redactRawOutput(text)).toBe(text);
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
