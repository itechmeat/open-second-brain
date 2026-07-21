/**
 * `health` block (v0.14.0) - tunes the semantic-health detectors and
 * the remediation step cap. Absent block falls back to
 * `BRAIN_HEALTH_DEFAULTS` via `resolveHealth`.
 */

import { describe, expect, test } from "bun:test";

import { parseBrainYaml } from "../../../src/core/brain/yaml-parse.ts";
import {
  BRAIN_HEALTH_DEFAULTS,
  BrainConfigError,
  resolveHealth,
  validateBrainConfigDetailed,
} from "../../../src/core/brain/policy.ts";

function validate(yaml: string) {
  return validateBrainConfigDetailed(parseBrainYaml(yaml), "<test>");
}

const HEAD = `schema_version: 1\n`;

describe("BRAIN_HEALTH_DEFAULTS", () => {
  test("documents the knob defaults", () => {
    expect(BRAIN_HEALTH_DEFAULTS.contradiction_jaccard).toBe(0.5);
    expect(BRAIN_HEALTH_DEFAULTS.concept_gap_min_frequency).toBe(3);
    expect(BRAIN_HEALTH_DEFAULTS.stale_claim_max_age_days).toBe(180);
    expect(BRAIN_HEALTH_DEFAULTS.remediation_step_cap).toBe(20);
    expect(BRAIN_HEALTH_DEFAULTS.silence_before).toBeNull();
  });
});

describe("health.silence_before", () => {
  test("a date-only value resolves as the watermark string", () => {
    const { config } = validate(HEAD + `health:\n  silence_before: "2026-01-01"\n`);
    expect(resolveHealth(config).silence_before).toBe("2026-01-01");
  });

  test("a full ISO timestamp resolves as the watermark string", () => {
    const { config } = validate(HEAD + `health:\n  silence_before: "2026-01-01T12:00:00Z"\n`);
    expect(resolveHealth(config).silence_before).toBe("2026-01-01T12:00:00Z");
  });

  test("an unparseable date is rejected loudly, never silently ignored", () => {
    expect(() => validate(HEAD + `health:\n  silence_before: "2026-13-99"\n`)).toThrow(
      BrainConfigError,
    );
    expect(() => validate(HEAD + `health:\n  silence_before: "not-a-date"\n`)).toThrow(
      BrainConfigError,
    );
  });

  test("a non-string value is rejected", () => {
    expect(() => validate(HEAD + `health:\n  silence_before: 2026\n`)).toThrow(BrainConfigError);
  });
});

describe("health config block", () => {
  test("absent block → cfg.health undefined; resolveHealth returns defaults", () => {
    const { config } = validate(HEAD);
    expect(config.health).toBeUndefined();
    expect(resolveHealth(config)).toEqual(BRAIN_HEALTH_DEFAULTS);
  });

  test("present with all fields → loaded fully", () => {
    const { config } = validate(
      HEAD +
        `health:\n` +
        `  contradiction_jaccard: 0.7\n` +
        `  concept_gap_min_frequency: 5\n` +
        `  stale_claim_max_age_days: 90\n` +
        `  remediation_step_cap: 4\n`,
    );
    expect(resolveHealth(config)).toEqual({
      contradiction_jaccard: 0.7,
      concept_gap_min_frequency: 5,
      stale_claim_max_age_days: 90,
      remediation_step_cap: 4,
      silence_before: null,
    });
  });

  test("partial block → missing fields fall back to defaults", () => {
    const { config } = validate(HEAD + `health:\n  concept_gap_min_frequency: 2\n`);
    const resolved = resolveHealth(config);
    expect(resolved.concept_gap_min_frequency).toBe(2);
    expect(resolved.contradiction_jaccard).toBe(BRAIN_HEALTH_DEFAULTS.contradiction_jaccard);
  });

  test("contradiction_jaccard out of (0, 1] is rejected", () => {
    expect(() => validate(HEAD + `health:\n  contradiction_jaccard: 1.5\n`)).toThrow(
      BrainConfigError,
    );
  });

  test("a non-positive integer knob is rejected", () => {
    expect(() => validate(HEAD + `health:\n  concept_gap_min_frequency: 0\n`)).toThrow(
      BrainConfigError,
    );
  });

  test("an unknown sub-key is a forward-compat warning, not an error", () => {
    const { warnings } = validate(HEAD + `health:\n  future_knob: 1\n`);
    expect(warnings.some((w) => w.message.includes("health.future_knob"))).toBe(true);
  });
});
