import { describe, expect, test } from "bun:test";

import { redactRawOutput, SECRET_KEYS } from "../../src/core/pay-memory/redactor.ts";

describe("redactRawOutput", () => {
  test("redacts env-style key=value", () => {
    expect(redactRawOutput("API_KEY=sk_live_abc123 other=visible")).toBe(
      "API_KEY=***REDACTED*** other=visible",
    );
    expect(redactRawOutput("token=eyJhbGciOi.LongString")).toBe("token=***REDACTED***");
  });

  test("redacts YAML / log-style key: value", () => {
    expect(redactRawOutput("api_key: sk_test_xyz")).toBe("api_key: ***REDACTED***");
    expect(redactRawOutput("Authorization: super-secret-value")).toBe(
      "Authorization: ***REDACTED***",
    );
  });

  test("redacts JSON entries", () => {
    expect(redactRawOutput('{"api_key": "abc", "name": "ok"}')).toBe(
      '{"api_key": "***REDACTED***", "name": "ok"}',
    );
    expect(redactRawOutput('{"token":"long.signed.value"}')).toBe(
      '{"token":"***REDACTED***"}',
    );
  });

  test("redacts Authorization: Bearer headers and preserves the `Bearer` prefix", () => {
    expect(redactRawOutput("Authorization: Bearer abc.def.ghi")).toBe(
      "Authorization: Bearer ***REDACTED***",
    );
    // When the key is absent but the bearer token is, fall back to the bearer rule.
    expect(redactRawOutput("Sent header: Bearer abc.def")).toBe(
      "Sent header: Bearer ***REDACTED***",
    );
  });

  test("does not match unrelated phrases that contain secret-key words", () => {
    // No `=`, `:`, or quoted-key shape — the word "secret" stays.
    expect(redactRawOutput("My favourite secret recipe is curry.")).toBe(
      "My favourite secret recipe is curry.",
    );
  });

  test("multi-line input", () => {
    const input = [
      "request:",
      "  api_key: abc123",
      "  endpoint: https://example/v1/foo",
      "response:",
      '  {"token": "xyz"}',
    ].join("\n");
    const out = redactRawOutput(input);
    expect(out).toContain("api_key: ***REDACTED***");
    expect(out).toContain('"token": "***REDACTED***"');
    expect(out).toContain("https://example/v1/foo");
  });

  test("handles empty input", () => {
    expect(redactRawOutput("")).toBe("");
  });

  test("SECRET_KEYS is non-empty and includes the documented set", () => {
    for (const key of ["api_key", "token", "secret", "bearer", "authorization", "private_key"]) {
      expect(SECRET_KEYS).toContain(key);
    }
  });

  test("redacts password / credential / session_token assignments", () => {
    expect(redactRawOutput("password: hunter2")).toBe("password: ***REDACTED***");
    expect(redactRawOutput("PASSWD=somepw123")).toBe("PASSWD=***REDACTED***");
    expect(redactRawOutput('{"credential": "abc"}')).toBe(
      '{"credential": "***REDACTED***"}',
    );
    expect(redactRawOutput("session_token: eyJ.session.value")).toBe(
      "session_token: ***REDACTED***",
    );
  });
});
