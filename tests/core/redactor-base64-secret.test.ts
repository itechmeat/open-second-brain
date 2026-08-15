/**
 * A base64 credential split into sub-runs under the length gate.
 *
 * ## The defect
 *
 * `HIGH_ENTROPY_TOKEN_RE`'s character class is `[A-Za-z0-9_-]`, which
 * excludes `+` and `/`. An AWS secret access key -
 * `wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY` - therefore breaks into
 * runs of 13, 21 and 5 characters, every one of them under the 24-gate,
 * and passes verbatim. Its paired `AKIA…` access key id IS caught by the
 * vendor pass, so a note pasting the usual pair leaked the half that
 * matters while looking like it had been redacted.
 *
 * The new detector is deliberately narrow. It fires only on a MAXIMAL
 * base64 run of 32 to 64 characters that mixes upper, lower and digit and
 * carries at least one `+`, `/` or `=` - a pure-alphanumeric run is
 * already the high-entropy pass's job, and an embedded image blob runs to
 * thousands of characters and is left alone rather than mangled.
 *
 * Not a defect, and asserted as such: an all-letters passphrase is
 * invisible to any shape-based scanner, and a hexadecimal digest is an
 * identifier this export has to carry unchanged.
 */

import { describe, expect, test } from "bun:test";

import { EGRESS_OUTCOME, redactForEgress } from "../../src/core/egress/guard.ts";
import { redactRawOutput, REDACTION_PLACEHOLDER } from "../../src/core/redactor.ts";

const AWS_ID = "AKIAIOSFODNN7EXAMPLE";
const AWS_SECRET = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";
const DIGEST = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
const TOKENS = { redactTokens: true } as const;

describe("both halves of an AWS key pair leave redacted", () => {
  test("through the export guard", () => {
    const verdict = redactForEgress("brain-bank-export", {
      body: `id ${AWS_ID}\nsecret ${AWS_SECRET}\n`,
    });
    expect(verdict.outcome).toBe(EGRESS_OUTCOME.released);
    if (verdict.outcome !== EGRESS_OUTCOME.released) throw new Error("unreachable");
    expect(verdict.payload.body).not.toContain(AWS_SECRET);
    expect(verdict.payload.body).not.toContain(AWS_ID);
    expect(verdict.payload.body).toContain(REDACTION_PLACEHOLDER);
  });

  test("the secret half alone, with the token pass on", () => {
    expect(redactRawOutput(`secret=${AWS_SECRET}`, TOKENS)).not.toContain(AWS_SECRET);
  });
});

describe("the detector stays off the shapes it must not touch", () => {
  test("a hexadecimal digest is an identifier, not a credential", () => {
    expect(redactRawOutput(`digest ${DIGEST}`, TOKENS)).toContain(DIGEST);
  });

  test("a base64 run longer than a credential is out of scope", () => {
    // 128 characters: an embedded blob, not a key. Its alphanumeric
    // sub-runs are all short, so nothing else claims it either - which is
    // what makes this a clean read on the new rule's upper bound.
    const blob = "aB3+cD4/".repeat(16);
    expect(blob.length).toBeGreaterThan(64);
    expect(redactRawOutput(`data ${blob}`, TOKENS)).toContain(blob);
  });

  test("an all-letters passphrase is out of reach by construction", () => {
    const passphrase = "correcthorsebatterystaplecorrecthorse";
    expect(redactRawOutput(`phrase ${passphrase}`, TOKENS)).toContain(passphrase);
  });

  test("the default posture is unchanged - no token pass, no change", () => {
    const source = `secret ${AWS_SECRET}`;
    expect(redactRawOutput(source)).toBe(source);
  });
});
