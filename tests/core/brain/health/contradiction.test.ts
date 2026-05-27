/**
 * Cross-preference contradiction detector (F1).
 *
 * A contradiction is structural, not lexical: two confirmed
 * preferences about the same subject (high principle token overlap)
 * that carry an opposite sign of record. No negation word list - the
 * polarity comes entirely from each preference's `evidenced_by` signals.
 */

import { describe, expect, test } from "bun:test";

import { BRAIN_PREFERENCE_STATUS, BRAIN_SIGNAL_SIGN } from "../../../../src/core/brain/types.ts";
import {
  detectContradictions,
  type PreferenceForContradiction,
} from "../../../../src/core/brain/health/contradiction.ts";

function pref(
  over: Partial<PreferenceForContradiction> &
    Pick<PreferenceForContradiction, "id" | "principle" | "evidenced_by">,
): PreferenceForContradiction {
  return {
    scope: "coding",
    status: BRAIN_PREFERENCE_STATUS.confirmed,
    ...over,
  };
}

const signs = new Map([
  ["sig-pos", BRAIN_SIGNAL_SIGN.positive],
  ["sig-neg", BRAIN_SIGNAL_SIGN.negative],
]);

describe("detectContradictions", () => {
  test("flags same-scope high-overlap pair with opposite signs", () => {
    const findings = detectContradictions(
      [
        pref({
          id: "pref-a",
          principle: "always indent source with tabs not spaces",
          evidenced_by: ["[[sig-pos]]"],
        }),
        pref({
          id: "pref-b",
          principle: "never indent source with tabs always spaces",
          evidenced_by: ["[[sig-neg]]"],
        }),
      ],
      signs,
      { jaccard: 0.5 },
    );
    expect(findings.length).toBe(1);
    expect(findings[0]!.aId).toBe("pref-a");
    expect(findings[0]!.bId).toBe("pref-b");
    expect(findings[0]!.aSign).toBe(BRAIN_SIGNAL_SIGN.positive);
    expect(findings[0]!.bSign).toBe(BRAIN_SIGNAL_SIGN.negative);
    expect(findings[0]!.jaccard).toBeGreaterThanOrEqual(0.5);
  });

  test("same sign is not a contradiction (those are duplicates)", () => {
    const findings = detectContradictions(
      [
        pref({
          id: "pref-a",
          principle: "always indent source with tabs not spaces",
          evidenced_by: ["[[sig-pos]]"],
        }),
        pref({
          id: "pref-b",
          principle: "always indent source with tabs not spaces here",
          evidenced_by: ["[[sig-pos]]"],
        }),
      ],
      signs,
      { jaccard: 0.5 },
    );
    expect(findings).toEqual([]);
  });

  test("low token overlap is not compared even with opposite signs", () => {
    const findings = detectContradictions(
      [
        pref({
          id: "pref-a",
          principle: "deploy releases on friday afternoon",
          evidenced_by: ["[[sig-pos]]"],
        }),
        pref({
          id: "pref-b",
          principle: "write unit tests before merging code",
          evidenced_by: ["[[sig-neg]]"],
        }),
      ],
      signs,
      { jaccard: 0.5 },
    );
    expect(findings).toEqual([]);
  });

  test("different scopes are bucketed apart and never paired", () => {
    const findings = detectContradictions(
      [
        pref({
          id: "pref-a",
          scope: "coding",
          principle: "always indent source with tabs not spaces",
          evidenced_by: ["[[sig-pos]]"],
        }),
        pref({
          id: "pref-b",
          scope: "writing",
          principle: "never indent source with tabs always spaces",
          evidenced_by: ["[[sig-neg]]"],
        }),
      ],
      signs,
      { jaccard: 0.5 },
    );
    expect(findings).toEqual([]);
  });

  test("unconfirmed preferences are skipped", () => {
    const findings = detectContradictions(
      [
        pref({
          id: "pref-a",
          principle: "always indent source with tabs not spaces",
          evidenced_by: ["[[sig-pos]]"],
        }),
        pref({
          id: "pref-b",
          status: BRAIN_PREFERENCE_STATUS.unconfirmed,
          principle: "never indent source with tabs always spaces",
          evidenced_by: ["[[sig-neg]]"],
        }),
      ],
      signs,
      { jaccard: 0.5 },
    );
    expect(findings).toEqual([]);
  });

  test("unknown-sign preferences are skipped (no resolvable evidence)", () => {
    const findings = detectContradictions(
      [
        pref({
          id: "pref-a",
          principle: "always indent source with tabs not spaces",
          evidenced_by: ["[[sig-pos]]"],
        }),
        pref({
          id: "pref-b",
          principle: "never indent source with tabs always spaces",
          evidenced_by: ["[[sig-orphaned]]"],
        }),
      ],
      signs,
      { jaccard: 0.5 },
    );
    expect(findings).toEqual([]);
  });

  test("output is deterministically ordered with aId < bId", () => {
    const findings = detectContradictions(
      [
        pref({
          id: "pref-zebra",
          principle: "always indent source with tabs not spaces",
          evidenced_by: ["[[sig-neg]]"],
        }),
        pref({
          id: "pref-alpha",
          principle: "never indent source with tabs always spaces",
          evidenced_by: ["[[sig-pos]]"],
        }),
      ],
      signs,
      { jaccard: 0.5 },
    );
    expect(findings.length).toBe(1);
    expect(findings[0]!.aId).toBe("pref-alpha");
    expect(findings[0]!.bId).toBe("pref-zebra");
  });
});
