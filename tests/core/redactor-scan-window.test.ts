/**
 * The truncation refusal is decided by the SCAN, not by the output text.
 *
 * ## The defect
 *
 * `redactStructured` set `truncated` only when the OUTPUT carried the
 * fail-closed marker and the INPUT did not
 * (`wasScanTruncated(out) && !wasScanTruncated(value)`). A string that
 * quotes the marker therefore suppressed its own refusal at any size: a
 * 1.4 MiB leaf beginning with the marker text released, ~700 KiB of it
 * silently dropped, and the written file ended in "This payload was only
 * partially scanned - treat it as unverified" - the exact misleading
 * success `src/core/egress/guard.ts` says cannot happen.
 *
 * The trigger is content, not an attack: a note ABOUT the redactor, or a
 * re-imported artifact-store payload, quotes the marker verbatim.
 *
 * Truncation is a property of the scan (input length against the window),
 * so the guard now reads it from the scan itself. Pinned here alongside
 * the boundaries that were already correct and must stay correct: exactly
 * one window releases, one byte more refuses, and the ceiling is per
 * string leaf rather than per document.
 */

import { describe, expect, test } from "bun:test";

import { EGRESS_OUTCOME, redactForEgress } from "../../src/core/egress/guard.ts";
import {
  MAX_REDACTOR_INPUT,
  REDACTION_PLACEHOLDER,
  SCAN_TRUNCATED_MARKER,
  redactStructured,
  wasScanTruncated,
} from "../../src/core/redactor.ts";
import { fakeCredential } from "../helpers/fake-credentials.ts";

/** A vendor-prefixed token, caught by shape rather than by a word list. */
const TAIL_SECRET = fakeCredential("sk-", "live-TAILSECRET9999");

describe("content that quotes the truncation marker cannot suppress the refusal", () => {
  test("an oversized leaf beginning with the marker is refused, not released", () => {
    const poisoned = SCAN_TRUNCATED_MARKER + `${TAIL_SECRET} `.repeat(60_000);
    expect(poisoned.length).toBeGreaterThan(MAX_REDACTOR_INPUT);

    const verdict = redactForEgress("brain-bank-export", { note: poisoned });
    expect(verdict.outcome).toBe(EGRESS_OUTCOME.refusedScanTruncated);
  });

  test("the structured scan reports truncation for such a leaf", () => {
    const poisoned = SCAN_TRUNCATED_MARKER + "x".repeat(MAX_REDACTOR_INPUT);
    expect(redactStructured({ note: poisoned }).truncated).toBe(true);
  });

  test("a payload that quotes the marker but fits the window is released intact", () => {
    // The marker is ordinary text below the window: refusing here would
    // make any note about the redactor unexportable.
    const quoted = `a note about ${SCAN_TRUNCATED_MARKER} and what it means`;
    const verdict = redactForEgress("brain-bank-export", { note: quoted });
    expect(verdict.outcome).toBe(EGRESS_OUTCOME.released);
    if (verdict.outcome !== EGRESS_OUTCOME.released) throw new Error("unreachable");
    expect(verdict.payload).toEqual({ note: quoted });
    expect(wasScanTruncated(quoted)).toBe(true);
  });
});

describe("the window boundary is unchanged", () => {
  test("exactly one window releases", () => {
    const verdict = redactForEgress("brain-bank-export", { note: "a".repeat(MAX_REDACTOR_INPUT) });
    expect(verdict.outcome).toBe(EGRESS_OUTCOME.released);
  });

  test("one byte more refuses", () => {
    const verdict = redactForEgress("brain-bank-export", {
      note: "a".repeat(MAX_REDACTOR_INPUT + 1),
    });
    expect(verdict.outcome).toBe(EGRESS_OUTCOME.refusedScanTruncated);
  });

  test("the ceiling is per string leaf, not per document", () => {
    const leaf = "a".repeat(600 * 1024);
    const verdict = redactForEgress("brain-bank-export", { one: leaf, two: leaf, three: leaf });
    expect(verdict.outcome).toBe(EGRESS_OUTCOME.released);
  });
});

describe("a sibling {name, value} secret pair is judged by the name", () => {
  // The four text passes and the walk's key-name rule all read the
  // credential's OWN key. Configuration formats that put the name in a
  // SIBLING member - the environment-entry shape ECS, Kubernetes and
  // docker-compose share - therefore passed whole: the walk saw the key
  // `value` (which says nothing) and never consulted the sibling
  // `DB_PASSWORD`, so the literal secret rode through the export boundary
  // with `redacted: false`.

  test("an environment-style secret pair has its value redacted", () => {
    const result = redactStructured({
      environment: [{ name: "DB_PASSWORD", value: "hunter2s3cret" }],
    });
    expect(result.redacted).toBe(true);
    const entry = (result.value as { environment: Array<{ name: string; value: string }> })
      .environment[0]!;
    expect(entry.name).toBe("DB_PASSWORD");
    expect(entry.value).toBe(REDACTION_PLACEHOLDER);
  });

  test("the same pair is redacted under redactTokens too", () => {
    const result = redactStructured(
      { environment: [{ name: "DB_PASSWORD", value: "hunter2s3cret" }] },
      { redactTokens: true },
    );
    expect(result.redacted).toBe(true);
    const entry = (result.value as { environment: Array<{ name: string; value: string }> })
      .environment[0]!;
    expect(entry.value).toBe(REDACTION_PLACEHOLDER);
    expect(entry.name).toBe("DB_PASSWORD");
  });

  test("extra members of the entry survive; only the value is a credential", () => {
    const result = redactStructured({
      environment: [{ name: "DB_PASSWORD", value: "hunter2s3cret", required: true }],
    });
    const entry = result.value as {
      environment: Array<{ name: string; value: string; required: boolean }>;
    };
    expect(entry.environment[0]).toEqual({
      name: "DB_PASSWORD",
      value: REDACTION_PLACEHOLDER,
      required: true,
    });
  });

  test("a pair whose name is not a secret key passes through", () => {
    const input = { environment: [{ name: "NODE_ENV", value: "production" }] };
    const result = redactStructured(input);
    expect(result.value).toEqual(input);
    expect(result.redacted).toBe(false);
  });

  test("an ECS valueFrom ARN reference passes through untouched", () => {
    // valueFrom names a REFERENCE, not a literal: there is no `value`
    // member to redact, and the ARN is an identifier.
    const input = {
      environment: [
        { name: "DB_PASSWORD", valueFrom: { arn: "arn:aws:ecs:us-east-1:123:task/c" } },
      ],
    };
    const result = redactStructured(input);
    expect(result.value).toEqual(input);
    expect(result.redacted).toBe(false);
  });

  test("non-object array elements are unaffected", () => {
    const input = { items: ["plain text", 42, null, true, ["nested", "elements"]] };
    const result = redactStructured(input);
    expect(result.value).toEqual(input);
    expect(result.redacted).toBe(false);
  });

  test("a secret-shaped VALUE in a pair is the placeholder, not a partial scan", () => {
    // A vendor-prefixed value is fully replaced by the sibling rule, the
    // way it would be under a secret KEY name.
    const token = fakeCredential("sk-", "live-SIBLINGPAIR0000");
    const result = redactStructured({ env: [{ name: "API_KEY", value: token }] });
    const entry = (result.value as { env: Array<{ value: string }> }).env[0]!;
    expect(entry.value).toBe(REDACTION_PLACEHOLDER);
  });
});
