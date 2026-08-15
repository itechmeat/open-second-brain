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
  SCAN_TRUNCATED_MARKER,
  redactStructured,
  wasScanTruncated,
} from "../../src/core/redactor.ts";

/** A vendor-prefixed token, caught by shape rather than by a word list. */
const TAIL_SECRET = "sk-live-TAILSECRET9999";

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
