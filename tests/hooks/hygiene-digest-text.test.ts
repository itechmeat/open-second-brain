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

/** The module-private separator between the counts and the pointer: an em dash with spaces. */
const POINTER_JOIN = " \u2014 ";

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
      // The POINTER names the dangling-links surface, so the segment
      // check is numeric: no "<n> dangling links" count may appear.
      expect(line).not.toMatch(/\d dangling links/);
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

  /**
   * Every realistic population fits the default cap with room to spare,
   * so the degradation loop is reachable only through a tighter ceiling:
   * `maxChars` exercises the exact branch the hook relies on when a
   * pathological population does arrive.
   */
  test("a cap nothing fits under keeps the prefix and pointer floor as one line", () => {
    const findings = [finding("conflicts", "warning"), finding("dedup", "warning")];
    const floor = composeHygieneDigest({ findings, danglingLinks: 7 }, 1);
    expect(floor).toBe(`${HYGIENE_DIGEST_PREFIX} ${POINTER_JOIN}${HYGIENE_DIGEST_POINTER}`);
    expect(floor!.includes("\n")).toBe(false);
  });

  test("a tight cap drops whole trailing segments, the dangling count first", () => {
    const findings = [
      finding("conflicts", "warning"),
      finding("dedup", "warning"),
      finding("freshness", "action"),
    ];
    const twoSegments = `${HYGIENE_DIGEST_PREFIX} 1 conflicts, 1 dedup${POINTER_JOIN}${HYGIENE_DIGEST_POINTER}`;
    // One char below the full line's length: the last whole segments go
    // (freshness, then the dangling count), never a partial slice.
    expect(composeHygieneDigest({ findings, danglingLinks: 5 }, twoSegments.length)).toBe(
      twoSegments,
    );
    // One char tighter and the second segment goes whole too.
    const oneSegment = `${HYGIENE_DIGEST_PREFIX} 1 conflicts${POINTER_JOIN}${HYGIENE_DIGEST_POINTER}`;
    expect(composeHygieneDigest({ findings, danglingLinks: 5 }, twoSegments.length - 1)).toBe(
      oneSegment,
    );
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

  test("the pointer names a surface that shows each kind of count the line reports", () => {
    // The CLI scan lists the detector findings. The dangling-link count
    // is NOT on that surface: it is measured from the search index and
    // reported only by the MCP brain_hygiene tool, so a pointer to the
    // scan alone would send the reader somewhere the line's dangling
    // count never appears.
    expect(HYGIENE_DIGEST_POINTER).toContain("o2b brain hygiene scan");
    expect(HYGIENE_DIGEST_POINTER).toContain("brain_hygiene");
    expect(HYGIENE_DIGEST_POINTER).toContain("dangling");
    expect(HYGIENE_DIGEST_POINTER).not.toContain("OSB");
    expect(HYGIENE_DIGEST_POINTER).not.toContain("!");
  });

  test("the cap leaves room for the fixed prefix and pointer", () => {
    expect(HYGIENE_DIGEST_MAX_CHARS).toBeGreaterThanOrEqual(
      HYGIENE_DIGEST_PREFIX.length + HYGIENE_DIGEST_POINTER.length + 40,
    );
  });
});
