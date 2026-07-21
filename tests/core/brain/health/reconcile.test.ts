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

import { BRAIN_PREFERENCE_STATUS, BRAIN_SIGNAL_SIGN } from "../../../../src/core/brain/types.ts";
import {
  reconcileSemanticHealth,
  type PreferenceForHealth,
} from "../../../../src/core/brain/health/reconcile.ts";

const NOW = new Date("2026-05-27T00:00:00Z");

function pref(
  over: Partial<PreferenceForHealth> & Pick<PreferenceForHealth, "id">,
): PreferenceForHealth {
  return {
    status: BRAIN_PREFERENCE_STATUS.confirmed,
    scope: "coding",
    principle: "",
    evidenced_by: [],
    last_evidence_at: null,
    confirmed_at: "2026-05-01T00:00:00Z",
    topic: "t",
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

  test("a burst of preferences confirmed together yields a watch verdict", () => {
    const report = reconcileSemanticHealth(
      {
        preferences: [
          pref({ id: "pref-a", confirmed_at: "2026-05-01T00:00:00Z" }),
          pref({ id: "pref-b", confirmed_at: "2026-05-01T00:10:00Z" }),
        ],
        signSignById: signs,
        corpusPrinciples: [],
        coveredTopics: [],
      },
      { ...config, batchInflationMinBurstSize: 2 },
    );
    expect(report.batchInflation).toHaveLength(1);
    expect(report.batchInflation[0]!.ids).toEqual(["pref-a", "pref-b"]);
    expect(report.verdict).toBe("watch");
  });

  test("below the burst threshold stays clean", () => {
    const report = reconcileSemanticHealth(
      {
        preferences: [
          pref({ id: "pref-a", confirmed_at: "2026-05-01T00:00:00Z" }),
          pref({ id: "pref-b", confirmed_at: "2026-05-01T00:10:00Z" }),
        ],
        signSignById: signs,
        corpusPrinciples: [],
        coveredTopics: [],
      },
      config, // default minBurstSize is 5
    );
    expect(report.batchInflation).toEqual([]);
    expect(report.verdict).toBe("clean");
  });
});

describe("reconcileSemanticHealth acknowledge-before watermark", () => {
  test("an unset watermark leaves the report free of a suppressed field", () => {
    const report = reconcileSemanticHealth(
      {
        preferences: [
          pref({ id: "pref-a", confirmed_at: "2026-05-01T00:00:00Z" }),
          pref({ id: "pref-b", confirmed_at: "2026-05-01T00:10:00Z" }),
        ],
        signSignById: signs,
        corpusPrinciples: ["Kanban slow", "Kanban stuck", "Kanban grooming"],
        coveredTopics: [],
      },
      { ...config, batchInflationMinBurstSize: 2 },
    );
    expect(report.batchInflation).toHaveLength(1);
    expect(report.conceptGaps.length).toBeGreaterThan(0);
    expect(report.verdict).toBe("watch");
    expect("suppressed" in report).toBe(false);
  });

  test("a burst whose windowEnd predates the watermark is suppressed and clears the verdict", () => {
    const report = reconcileSemanticHealth(
      {
        preferences: [
          pref({ id: "pref-a", confirmed_at: "2026-01-01T00:00:00Z" }),
          pref({ id: "pref-b", confirmed_at: "2026-01-01T00:10:00Z" }),
        ],
        signSignById: signs,
        corpusPrinciples: [],
        coveredTopics: [],
      },
      { ...config, batchInflationMinBurstSize: 2, silenceBefore: "2026-03-01" },
    );
    expect(report.batchInflation).toEqual([]);
    expect(report.verdict).toBe("clean");
    expect(report.suppressed).toEqual({
      conceptGaps: 0,
      batchInflation: 1,
      baseline: "2026-03-01",
    });
  });

  test("a burst reaching at or after the watermark still surfaces", () => {
    const report = reconcileSemanticHealth(
      {
        preferences: [
          pref({ id: "pref-a", confirmed_at: "2026-05-01T00:00:00Z" }),
          pref({ id: "pref-b", confirmed_at: "2026-05-01T00:10:00Z" }),
        ],
        signSignById: signs,
        corpusPrinciples: [],
        coveredTopics: [],
      },
      { ...config, batchInflationMinBurstSize: 2, silenceBefore: "2026-03-01" },
    );
    expect(report.batchInflation).toHaveLength(1);
    expect(report.verdict).toBe("watch");
    expect("suppressed" in report).toBe(false);
  });

  test("a burst whose windowEnd equals the watermark instant surfaces (strictly-older boundary)", () => {
    // windowEnd == watermark: `endMs < watermarkMs` is false, so the burst
    // is kept. Only a window entirely BEFORE the watermark is hidden.
    const report = reconcileSemanticHealth(
      {
        preferences: [
          pref({ id: "pref-a", confirmed_at: "2026-03-01T00:00:00Z" }),
          pref({ id: "pref-b", confirmed_at: "2026-03-01T00:00:00Z" }),
        ],
        signSignById: signs,
        corpusPrinciples: [],
        coveredTopics: [],
      },
      { ...config, batchInflationMinBurstSize: 2, silenceBefore: "2026-03-01" },
    );
    expect(report.batchInflation).toHaveLength(1);
    expect(report.verdict).toBe("watch");
    expect("suppressed" in report).toBe(false);
  });

  test("a burst straddling the watermark surfaces (only fully-old bursts hide)", () => {
    // windowStart before, windowEnd after the watermark (1h apart, inside
    // the 24h default window). The burst is not entirely old, so it stays.
    const report = reconcileSemanticHealth(
      {
        preferences: [
          pref({ id: "pref-a", confirmed_at: "2026-02-28T23:30:00Z" }),
          pref({ id: "pref-b", confirmed_at: "2026-03-01T00:30:00Z" }),
        ],
        signSignById: signs,
        corpusPrinciples: [],
        coveredTopics: [],
      },
      { ...config, batchInflationMinBurstSize: 2, silenceBefore: "2026-03-01" },
    );
    expect(report.batchInflation).toHaveLength(1);
    expect(report.verdict).toBe("watch");
    expect("suppressed" in report).toBe(false);
  });

  test("a concept gap whose newest mention equals the watermark surfaces (kept on the boundary)", () => {
    // latest == watermark: `latest >= watermarkMs` is true, so the gap is
    // kept. Suppression needs EVERY mention strictly older.
    const report = reconcileSemanticHealth(
      {
        preferences: [],
        signSignById: signs,
        corpusPrinciples: ["Kanban slow", "Kanban stuck", "Kanban grooming"],
        corpusPrincipleDates: [
          "2026-01-01T00:00:00Z",
          "2026-01-02T00:00:00Z",
          "2026-03-01T00:00:00Z",
        ],
        coveredTopics: [],
      },
      { ...config, silenceBefore: "2026-03-01" },
    );
    expect(report.conceptGaps.some((g) => g.term === "kanban")).toBe(true);
    expect(report.verdict).toBe("watch");
    expect("suppressed" in report).toBe(false);
  });

  test("a concept gap is suppressed when every mentioning entry predates the watermark", () => {
    const report = reconcileSemanticHealth(
      {
        preferences: [],
        signSignById: signs,
        corpusPrinciples: ["Kanban slow", "Kanban stuck", "Kanban grooming"],
        corpusPrincipleDates: [
          "2026-01-01T00:00:00Z",
          "2026-01-02T00:00:00Z",
          "2026-01-03T00:00:00Z",
        ],
        coveredTopics: [],
      },
      { ...config, silenceBefore: "2026-03-01" },
    );
    expect(report.conceptGaps).toEqual([]);
    expect(report.verdict).toBe("clean");
    expect(report.suppressed).toEqual({
      conceptGaps: 1,
      batchInflation: 0,
      baseline: "2026-03-01",
    });
  });

  test("a concept gap with one fresh mention surfaces at full frequency", () => {
    const report = reconcileSemanticHealth(
      {
        preferences: [],
        signSignById: signs,
        corpusPrinciples: ["Kanban slow", "Kanban stuck", "Kanban grooming"],
        corpusPrincipleDates: [
          "2026-01-01T00:00:00Z",
          "2026-01-02T00:00:00Z",
          "2026-06-01T00:00:00Z",
        ],
        coveredTopics: [],
      },
      { ...config, silenceBefore: "2026-03-01" },
    );
    const kanban = report.conceptGaps.find((g) => g.term === "kanban");
    expect(kanban?.frequency).toBe(3);
    expect(report.verdict).toBe("watch");
    expect("suppressed" in report).toBe(false);
  });

  test("an undated mention keeps the gap visible (undated counts as newer)", () => {
    const report = reconcileSemanticHealth(
      {
        preferences: [],
        signSignById: signs,
        corpusPrinciples: ["Kanban slow", "Kanban stuck", "Kanban grooming"],
        corpusPrincipleDates: ["2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z", null],
        coveredTopics: [],
      },
      { ...config, silenceBefore: "2026-03-01" },
    );
    expect(report.conceptGaps.some((g) => g.term === "kanban")).toBe(true);
    expect("suppressed" in report).toBe(false);
  });

  test("a set watermark that hides nothing keeps the report byte-identical (no suppressed field)", () => {
    const report = reconcileSemanticHealth(
      {
        preferences: [pref({ id: "pref-a", principle: "write tests first" })],
        signSignById: signs,
        corpusPrinciples: ["write tests first"],
        coveredTopics: ["tests-first"],
      },
      { ...config, silenceBefore: "2026-03-01" },
    );
    expect(report.verdict).toBe("clean");
    expect("suppressed" in report).toBe(false);
  });

  test("an unparseable watermark throws rather than silently disabling the filter", () => {
    expect(() =>
      reconcileSemanticHealth(
        {
          preferences: [],
          signSignById: signs,
          corpusPrinciples: [],
          coveredTopics: [],
        },
        { ...config, silenceBefore: "not-a-date" },
      ),
    ).toThrow();
  });
});
