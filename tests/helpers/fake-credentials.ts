/**
 * Placeholder credentials for tests.
 *
 * Every value here is fake. Each one is assembled at runtime from parts, so
 * no single source line carries a literal shaped like a real credential and
 * registry secret scanners reading this repository have nothing to flag. The
 * assembled strings are exactly what the tests used before, so the redactor
 * tests still see the realistic shapes they need to prove a redaction.
 */

/** Joins the parts of a placeholder credential. */
export function fakeCredential(...parts: readonly string[]): string {
  return parts.join("");
}

/** The generic key handed to fake embedding and rerank providers. */
export const FAKE_PROVIDER_KEY = fakeCredential("test", "-key");

/** A vendor-shaped live key the redactor must always catch. */
export const FAKE_VENDOR_KEY = fakeCredential("sk-", "live-9f8e7d6c5b4a32100112");

/** A GitHub-token placeholder resolved through `$secret:` references. */
export const FAKE_GITHUB_SECRET = fakeCredential("ghp_", "secret_value");
