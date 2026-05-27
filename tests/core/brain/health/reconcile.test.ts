/**
 * Semantic-health reconciliation surface (F6).
 *
 * A single deterministic pass that runs the three detectors partitioned
 * into domains and folds their findings into one verdict. No sub-agents,
 * no IO - the caller hands in already-gathered data.
 *
 * Verdict escalation: a contradiction between two confirmed preferences
 * is the most serious finding (two active rules disagree) and forces
 * `investigate`; gaps or stale claims alone are `watch`; nothing is
 * `clean`.
 */

import { describe, expect, test } from "bun:test";

import {
  BRAIN_PREFERENCE_STATUS,
  BRAIN_SIGNAL_SIGN,
} from "../../../../src/core/brain/types.ts";
import {
  reconcileSemanticHealth,
  type PreferenceForHealth,
} from "../../../../src/core/brain/health/reconcile.ts";

const NOW = new Date("2026-05-27T00:00:00Z");

function pref(over: Partial<PreferenceForHealth> & Pick<PreferenceForHealth, "id">): PreferenceForHealth {
  return {
    status: BRAIN_PREFERENCE_STATUS.confirmed,
    scope: "coding",
    principle: "",
    evidenced_by: [],
    last_evidence_at: null,
    ...over,
  };
}

const signs = new Map([
  ["sig-pos", BRAIN_SIGNAL_SIGN.positive],
  ["sig-neg", BRAIN_SIGNAL_SIGN.negative],
]);

const config = {
  contradictionJaccard: 0.5,
  conceptGapMinFrequency: 3,
  staleClaimMaxAgeDays: 90,
  now: NOW,
};

describe("reconcileSemanticHealth", () => {
  test("clean vault yields a clean verdict and empty domains", () => {
    const report = reconcileSemanticHealth(
      {
        preferences: [pref({ id: "pref-a", principle: "write tests first" })],
        signSignById: signs,
        corpusPrinciples: ["write tests first"],
        coveredTopics: ["tests-first"],
      },
      config,
    );
    expect(report.verdict).toBe("clean");
    expect(report.contradictions).toEqual([]);
    expect(report.conceptGaps).toEqual([]);
    expect(report.staleClaims).toEqual([]);
  });

  test("a contradiction forces an investigate verdict", () => {
    const report = reconcileSemanticHealth(
      {
        preferences: [
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
        signSignById: signs,
        corpusPrinciples: [],
        coveredTopics: [],
      },
      config,
    );
    expect(report.contradictions.length).toBe(1);
    expect(report.verdict).toBe("investigate");
  });

  test("only stale claims yields a watch verdict", () => {
    const report = reconcileSemanticHealth(
      {
        preferences: [
          pref({
            id: "pref-old",
            principle: "ship on fridays",
            last_evidence_at: "2026-01-01T00:00:00Z",
          }),
        ],
        signSignById: signs,
        corpusPrinciples: [],
        coveredTopics: [],
      },
      config,
    );
    expect(report.staleClaims.length).toBe(1);
    expect(report.verdict).toBe("watch");
  });

  test("only concept gaps yields a watch verdict", () => {
    const report = reconcileSemanticHealth(
      {
        preferences: [],
        signSignById: signs,
        corpusPrinciples: ["Kanban slow", "Kanban stuck", "Kanban grooming"],
        coveredTopics: [],
      },
      config,
    );
    expect(report.conceptGaps.map((g) => g.term)).toContain("kanban");
    expect(report.verdict).toBe("watch");
  });
});
