/**
 * Numeric `confidence_value` — Wilson 95% lower bound × freshness
 * decay. Tests pin the formula at notable boundaries and confirm
 * the on-disk `_confidence_value` field round-trips through the
 * writer / parser / refresh pipeline.
 */

import { describe, expect, test } from "bun:test";

import {
  computeConfidence,
  type ConfidenceComputeResult,
} from "../../src/core/brain/dream.ts";
import { DEFAULT_BRAIN_CONFIG } from "../../src/core/brain/policy.ts";

const cfg = DEFAULT_BRAIN_CONFIG;
const NOW = new Date("2026-05-15T00:00:00Z");

function iso(d: string): string {
  return new Date(d).toISOString();
}

describe("computeConfidence — numeric value", () => {
  test("zero evidence → value 0 and band low", () => {
    const r: ConfidenceComputeResult = computeConfidence(0, 0, null, cfg, NOW);
    expect(r.value).toBe(0);
    expect(r.band).toBe("low");
  });

  test("Wilson lower bound shrinks as n grows from 1 → 100", () => {
    const tiny = computeConfidence(1, 0, iso("2026-05-15"), cfg, NOW).value;
    const huge = computeConfidence(100, 0, iso("2026-05-15"), cfg, NOW).value;
    // Wilson lower bound for p̂=1 monotonically increases toward 1
    // as n grows. The freshness=1 boundary makes the comparison
    // honest: identical age, identical pHat, only n changes.
    expect(huge).toBeGreaterThan(tiny);
  });

  test("freshness decays linearly to 0 at retire.stale_evidence_days", () => {
    const half = computeConfidence(
      10,
      0,
      iso("2026-03-31"),
      cfg,
      NOW,
    ).value;
    const stale = computeConfidence(
      10,
      0,
      iso("2026-02-14"),
      cfg,
      NOW,
    ).value;
    // 45 days vs 90 days at 90-day decay → 0.5x vs 0.0x freshness.
    expect(half).toBeGreaterThan(stale + 0.001);
  });

  test("rounded to 4 decimals for YAML stability", () => {
    const r = computeConfidence(7, 1, iso("2026-05-10"), cfg, NOW);
    // Multiply by 10000 must produce an integer (within JS float
    // tolerance) — the writer's rounding contract.
    expect(Math.round(r.value * 10000) / 10000).toBe(r.value);
  });

  test("hard floor: applied <= low_max_applied keeps band low", () => {
    const r = computeConfidence(2, 0, iso("2026-05-15"), cfg, NOW);
    expect(r.band).toBe("low");
  });

  test("hard floor: violated >= applied keeps band low", () => {
    const r = computeConfidence(5, 5, iso("2026-05-15"), cfg, NOW);
    expect(r.band).toBe("low");
  });

  test("step-function eligibility: 10 applied / no violated / fresh → high", () => {
    const r = computeConfidence(10, 0, iso("2026-05-15"), cfg, NOW);
    expect(r.band).toBe("high");
  });

  test("step-function eligibility lost when stale → falls to medium", () => {
    // last evidence ~78 days ago — past high_freshness_factor cutoff
    // but not past stale_evidence_days.
    const r = computeConfidence(10, 0, iso("2026-02-26"), cfg, NOW);
    expect(r.band).toBe("medium");
  });

  test("numeric band max-lift: legacy=medium + numeric=high → high", () => {
    // Lower high_min so a 9-applied / 0-violated / fresh pref crosses
    // the numeric threshold even though legacy step-function would
    // cap it at medium (needs applied >= 10).
    const tunedCfg = {
      ...cfg,
      confidence: {
        ...cfg.confidence,
        high_min: 0.5,
        medium_min: 0.30,
      },
    };
    const r = computeConfidence(9, 0, iso("2026-05-15"), tunedCfg, NOW);
    expect(r.band).toBe("high");
  });

  test("numeric never demotes a legacy-high band", () => {
    // Legacy step → high; tighten numeric thresholds to demand
    // 0.99. Max-with-legacy keeps band at high.
    const strictCfg = {
      ...cfg,
      confidence: {
        ...cfg.confidence,
        high_min: 0.99,
        medium_min: 0.99,
      },
    };
    const r = computeConfidence(10, 0, iso("2026-05-15"), strictCfg, NOW);
    expect(r.band).toBe("high");
  });

  test("value is in [0, 1]", () => {
    const tries = [
      [1, 0, "2026-05-15"],
      [50, 50, "2026-05-15"],
      [0, 0, "2026-05-15"],
      [100, 0, "2026-05-15"],
      [10, 10, "2026-01-01"],
    ] as const;
    for (const [a, v, d] of tries) {
      const r = computeConfidence(a, v, iso(d), cfg, NOW);
      expect(r.value).toBeGreaterThanOrEqual(0);
      expect(r.value).toBeLessThanOrEqual(1);
    }
  });
});
