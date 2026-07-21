/**
 * Pure `_brain.yaml` transform behind `o2b brain health-baseline`. The
 * writer must upsert or remove ONLY the `silence_before` line, leaving
 * every other block and key byte-for-byte intact, and the result must
 * always re-parse through the real config loader.
 */

import { describe, expect, test } from "bun:test";

import { applyHealthSilenceBeforeToYaml } from "../../../src/core/brain/health-baseline.ts";
import { parseBrainYaml } from "../../../src/core/brain/yaml-parse.ts";

const BASE = "schema_version: 1\n\nvault:\n  ignore_paths:\n    - .git\n";

function silenceOf(text: string): unknown {
  const parsed = parseBrainYaml(text) as Record<string, Record<string, unknown>>;
  return parsed["health"]?.["silence_before"];
}

describe("applyHealthSilenceBeforeToYaml", () => {
  test("appends a health block when none exists", () => {
    const out = applyHealthSilenceBeforeToYaml(BASE, "2026-01-01");
    expect(silenceOf(out)).toBe("2026-01-01");
    // The pre-existing vault block is untouched.
    expect(out).toContain("vault:\n  ignore_paths:\n    - .git");
  });

  test("upserts into an existing health block without disturbing siblings", () => {
    const withBlock = `${BASE}\nhealth:\n  concept_gap_min_frequency: 5\n`;
    const out = applyHealthSilenceBeforeToYaml(withBlock, "2026-02-02");
    expect(silenceOf(out)).toBe("2026-02-02");
    const parsed = parseBrainYaml(out) as Record<string, Record<string, unknown>>;
    expect(parsed["health"]?.["concept_gap_min_frequency"]).toBe(5);
  });

  test("replaces an existing silence_before line rather than duplicating it", () => {
    const first = applyHealthSilenceBeforeToYaml(BASE, "2026-01-01");
    const second = applyHealthSilenceBeforeToYaml(first, "2026-09-09");
    expect(silenceOf(second)).toBe("2026-09-09");
    expect(second.match(/silence_before/g)?.length).toBe(1);
  });

  test("clearing removes the line and the now-empty header it created", () => {
    const set = applyHealthSilenceBeforeToYaml(BASE, "2026-01-01");
    const cleared = applyHealthSilenceBeforeToYaml(set, null);
    expect(silenceOf(cleared)).toBeUndefined();
    expect(cleared).not.toContain("health:");
  });

  test("clearing keeps a health block that still has other keys", () => {
    const withBlock = `${BASE}\nhealth:\n  concept_gap_min_frequency: 5\n  silence_before: "2026-01-01"\n`;
    const cleared = applyHealthSilenceBeforeToYaml(withBlock, null);
    expect(silenceOf(cleared)).toBeUndefined();
    const parsed = parseBrainYaml(cleared) as Record<string, Record<string, unknown>>;
    expect(parsed["health"]?.["concept_gap_min_frequency"]).toBe(5);
  });

  test("clearing an absent watermark is a no-op", () => {
    expect(applyHealthSilenceBeforeToYaml(BASE, null)).toBe(BASE);
  });
});
