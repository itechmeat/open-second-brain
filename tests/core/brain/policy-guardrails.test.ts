/**
 * `guardrails` block (v0.10.16) - controls self-approval thresholds and
 * instruction-file-ceiling warning.
 */

import { describe, expect, test } from "bun:test";

import {
  BRAIN_GUARDRAIL_DEFAULTS,
  BrainConfigError,
  parseBrainYaml,
  resolveGuardrails,
  validateBrainConfigDetailed,
} from "../../../src/core/brain/policy.ts";

function validate(yaml: string) {
  return validateBrainConfigDetailed(parseBrainYaml(yaml), "<test>");
}

const HEAD = `schema_version: 1\n`;

describe("BRAIN_GUARDRAIL_DEFAULTS", () => {
  test("documents the four threshold defaults", () => {
    expect(BRAIN_GUARDRAIL_DEFAULTS.promotion_min_signals).toBe(2);
    expect(BRAIN_GUARDRAIL_DEFAULTS.promotion_min_distinct_agents).toBe(1);
    expect(BRAIN_GUARDRAIL_DEFAULTS.promotion_min_age_days).toBe(0);
    expect(BRAIN_GUARDRAIL_DEFAULTS.instruction_file_max_lines).toBe(200);
  });
});

describe("guardrails config block", () => {
  test("absent block → cfg.guardrails is undefined; resolveGuardrails returns defaults", () => {
    const { config } = validate(HEAD);
    expect(config.guardrails).toBeUndefined();
    expect(resolveGuardrails(config)).toEqual(BRAIN_GUARDRAIL_DEFAULTS);
  });

  test("present with all four fields → loaded fully", () => {
    const { config } = validate(
      HEAD +
        `guardrails:\n` +
        `  promotion_min_signals: 3\n` +
        `  promotion_min_distinct_agents: 2\n` +
        `  promotion_min_age_days: 7\n` +
        `  instruction_file_max_lines: 300\n`,
    );
    expect(config.guardrails).toEqual({
      promotion_min_signals: 3,
      promotion_min_distinct_agents: 2,
      promotion_min_age_days: 7,
      instruction_file_max_lines: 300,
    });
    expect(resolveGuardrails(config).instruction_file_max_lines).toBe(300);
  });

  test("partial block → missing fields fall back to defaults via resolveGuardrails", () => {
    const { config } = validate(
      HEAD + `guardrails:\n  promotion_min_signals: 5\n`,
    );
    expect(config.guardrails?.promotion_min_signals).toBe(5);
    const resolved = resolveGuardrails(config);
    expect(resolved.promotion_min_signals).toBe(5);
    expect(resolved.instruction_file_max_lines).toBe(
      BRAIN_GUARDRAIL_DEFAULTS.instruction_file_max_lines,
    );
    expect(resolved.promotion_min_distinct_agents).toBe(
      BRAIN_GUARDRAIL_DEFAULTS.promotion_min_distinct_agents,
    );
  });

  test("promotion_min_signals: 0 rejected", () => {
    expect(() =>
      validate(HEAD + `guardrails:\n  promotion_min_signals: 0\n`),
    ).toThrow(BrainConfigError);
  });

  test("promotion_min_signals: negative rejected", () => {
    expect(() =>
      validate(HEAD + `guardrails:\n  promotion_min_signals: -1\n`),
    ).toThrow(BrainConfigError);
  });

  test("promotion_min_signals: non-integer rejected", () => {
    expect(() =>
      validate(HEAD + `guardrails:\n  promotion_min_signals: 2.5\n`),
    ).toThrow(BrainConfigError);
  });

  test("promotion_min_distinct_agents: 0 rejected", () => {
    expect(() =>
      validate(HEAD + `guardrails:\n  promotion_min_distinct_agents: 0\n`),
    ).toThrow(BrainConfigError);
  });

  test("promotion_min_age_days: 0 accepted (means disabled)", () => {
    const { config } = validate(
      HEAD + `guardrails:\n  promotion_min_age_days: 0\n`,
    );
    expect(config.guardrails?.promotion_min_age_days).toBe(0);
  });

  test("promotion_min_age_days: negative rejected", () => {
    expect(() =>
      validate(HEAD + `guardrails:\n  promotion_min_age_days: -1\n`),
    ).toThrow(BrainConfigError);
  });

  test("instruction_file_max_lines: 0 rejected", () => {
    expect(() =>
      validate(HEAD + `guardrails:\n  instruction_file_max_lines: 0\n`),
    ).toThrow(BrainConfigError);
  });

  test("instruction_file_max_lines: extreme upper bound 10000 accepted", () => {
    const { config } = validate(
      HEAD + `guardrails:\n  instruction_file_max_lines: 10000\n`,
    );
    expect(config.guardrails?.instruction_file_max_lines).toBe(10000);
  });

  test("instruction_file_max_lines: above hard ceiling rejected", () => {
    expect(() =>
      validate(
        HEAD + `guardrails:\n  instruction_file_max_lines: 100000\n`,
      ),
    ).toThrow(BrainConfigError);
  });

  test("non-object guardrails block rejected", () => {
    expect(() =>
      validate(HEAD + `guardrails: "nope"\n`),
    ).toThrow(BrainConfigError);
  });

  test("unknown sub-key warns but does not throw", () => {
    const { config, warnings } = validate(
      HEAD + `guardrails:\n  promotion_min_signals: 3\n  unknown_field: 1\n`,
    );
    expect(config.guardrails?.promotion_min_signals).toBe(3);
    expect(warnings.some((w) => w.message.includes("guardrails.unknown_field"))).toBe(true);
  });
});
