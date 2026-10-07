/**
 * Unit tests for the pure one-line hygiene digest composer
 * (context-injection-pipeline, lane B, task B1).
 *
 * The composer folds a hygiene scan's eligible findings plus the
 * index-backed dangling-link count into ONE line for the Stop channel.
 * These tests pin the contract the hook relies on: info never emits,
 * zero eligible content emits nothing, detector counts keep the
 * registered order with the dangling count last, the line always fits
 * the named cap, and identical input composes byte-identical output.
 */

import { describe, expect, test } from "bun:test";

import {
  HYGIENE_DIGEST_MAX_CHARS,
  HYGIENE_DIGEST_POINTER,
  HYGIENE_DIGEST_PREFIX,
  HYGIENE_DIGEST_SEVERITIES,
  composeHygieneDigest,
} from "../../hooks/lib/hygiene-digest-text.ts";
import {
  HYGIENE_DETECTOR_IDS,
  type HygieneDetectorId,
  type HygieneFinding,
  type HygieneSeverity,
} from "../../src/core/brain/hygiene/types.ts";

let seq = 0;

function finding(detector: HygieneDetectorId, severity: HygieneSeverity): HygieneFinding {
  seq += 1;
  return {
    id: `${detector}:${String(seq).padStart(4, "0")}`,
    detector,
    severity,
    title: `fixture finding ${seq}`,
    targets: [`target-${seq}`],
    proposed_action: "review",
    evidence: {},
  };
}

describe("composeHygieneDigest", () => {
  test("zero findings compose to null", () => {
    expect(composeHygieneDigest({ findings: [], danglingLinks: null })).toBeNull();
    expect(composeHygieneDigest({ findings: [], danglingLinks: 0 })).toBeNull();
  });

  test("info-only findings compose to null", () => {
    const findings = [
      finding("usefulness", "info"),
      finding("slug-collisions", "info"),
      finding("freshness", "info"),
    ];
    expect(composeHygieneDigest({ findings, danglingLinks: null })).toBeNull();
    expect(composeHygieneDigest({ findings, danglingLinks: 0 })).toBeNull();
  });

  test("warning and action findings are included, info findings are not", () => {
    const findings = [
      finding("conflicts", "warning"),
      finding("freshness", "action"),
      finding("usefulness", "info"),
    ];
    const line = composeHygieneDigest({ findings, danglingLinks: null });
    expect(line).not.toBeNull();
    expect(line).toContain("1 conflicts");
    expect(line).toContain("1 freshness");
    expect(line).not.toContain("usefulness");
  });

  test("counts are per detector in HYGIENE_DETECTOR_IDS order with the dangling-link count last", () => {
    const findings = [
      finding("dedup", "warning"),
      finding("conflicts", "warning"),
      finding("dedup", "action"),
      finding("capture-scope", "warning"),
    ];
    const line = composeHygieneDigest({ findings, danglingLinks: 3 });
    expect(line).not.toBeNull();
    const positions = [
      line!.indexOf("1 conflicts"),
      line!.indexOf("2 dedup"),
      line!.indexOf("1 capture-scope"),
      line!.indexOf("3 dangling links"),
    ];
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].toSorted((a, b) => a - b)).toEqual(positions);
  });

  test("an unmeasured or zero dangling count contributes no segment", () => {
    const findings = [finding("conflicts", "warning")];
    for (const danglingLinks of [null, 0]) {
      const line = composeHygieneDigest({ findings, danglingLinks });
      expect(line).not.toBeNull();
      expect(line).not.toContain("dangling");
    }
  });

  test("a dangling count alone composes a line", () => {
    const line = composeHygieneDigest({ findings: [], danglingLinks: 2 });
    expect(line).not.toBeNull();
    expect(line).toContain("2 dangling links");
    expect(line).toContain(HYGIENE_DIGEST_POINTER);
  });

  test("the output is exactly one line", () => {
    const findings = [finding("conflicts", "warning"), finding("dedup", "warning")];
    const line = composeHygieneDigest({ findings, danglingLinks: 1 });
    expect(line).not.toBeNull();
    expect(line!.includes("\n")).toBe(false);
  });

  test("the line never exceeds the cap, even on a pathological fixture", () => {
    const findings: HygieneFinding[] = [];
    for (const detector of HYGIENE_DETECTOR_IDS) {
      for (let i = 0; i < 12345; i += 1) findings.push(finding(detector, "warning"));
    }
    const line = composeHygieneDigest({ findings, danglingLinks: 987654321 });
    expect(line).not.toBeNull();
    expect(line!.length).toBeLessThanOrEqual(HYGIENE_DIGEST_MAX_CHARS);
    expect(line!.startsWith(HYGIENE_DIGEST_PREFIX)).toBe(true);
    expect(line!.endsWith(HYGIENE_DIGEST_POINTER)).toBe(true);
  });

  test("identical input composes byte-identical output, regardless of finding order", () => {
    const findings = [
      finding("dedup", "warning"),
      finding("conflicts", "warning"),
      finding("freshness", "action"),
    ];
    const shuffled = [findings[2]!, findings[0]!, findings[1]!];
    const a = composeHygieneDigest({ findings, danglingLinks: 4 });
    const b = composeHygieneDigest({ findings: shuffled, danglingLinks: 4 });
    expect(a).not.toBeNull();
    expect(a).toBe(b);
  });

  test("the line names the subsystem in full and points at the scan surface", () => {
    const findings = [finding("conflicts", "warning")];
    const line = composeHygieneDigest({ findings, danglingLinks: null });
    expect(line).not.toBeNull();
    expect(line!.startsWith(HYGIENE_DIGEST_PREFIX)).toBe(true);
    expect(line!.endsWith(HYGIENE_DIGEST_POINTER)).toBe(true);
    expect(line!.startsWith("Open Second Brain")).toBe(true);
    expect(line).not.toContain("OSB");
    expect(line).not.toContain("!");
  });
});

describe("digest constants", () => {
  test("only warning and action severities surface at turn end", () => {
    expect([...HYGIENE_DIGEST_SEVERITIES].toSorted()).toEqual(["action", "warning"]);
  });

  test("the cap leaves room for the fixed prefix and pointer", () => {
    expect(HYGIENE_DIGEST_MAX_CHARS).toBeGreaterThanOrEqual(
      HYGIENE_DIGEST_PREFIX.length + HYGIENE_DIGEST_POINTER.length + 40,
    );
  });
});
