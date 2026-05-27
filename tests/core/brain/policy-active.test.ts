/**
 * `active.{most_applied_window_days, most_applied_limit}` block (v0.10.11).
 */

import { describe, expect, test } from "bun:test";
import {
  BrainConfigError,
  parseBrainYaml,
  validateBrainConfigDetailed,
} from "../../../src/core/brain/policy.ts";

function validate(yaml: string) {
  return validateBrainConfigDetailed(parseBrainYaml(yaml), "<test>");
}

const HEAD = `schema_version: 1\n`;

describe("active.most_applied_* config block", () => {
  test("absent block → cfg.active is undefined; consumers use defaults", () => {
    const { config } = validate(HEAD);
    expect(config.active).toBeUndefined();
  });

  test("present with values → loaded into BrainMostAppliedConfig", () => {
    const { config } = validate(
      HEAD + `active:\n` + `  most_applied_window_days: 7\n` + `  most_applied_limit: 3\n`,
    );
    expect(config.active?.most_applied?.window_days).toBe(7);
    expect(config.active?.most_applied?.limit).toBe(3);
  });

  test("empty active block (no most_applied keys) is permitted", () => {
    const { config } = validate(HEAD + `active:\n  __reserved: 1\n`);
    // unknown sub-key warns, but the block is otherwise valid
    expect(config.active).toEqual({});
  });

  test("window_days: 0 rejected", () => {
    expect(() =>
      validate(HEAD + `active:\n  most_applied_window_days: 0\n  most_applied_limit: 5\n`),
    ).toThrow(BrainConfigError);
  });

  test("window_days: 366 rejected", () => {
    expect(() =>
      validate(HEAD + `active:\n  most_applied_window_days: 366\n  most_applied_limit: 5\n`),
    ).toThrow(BrainConfigError);
  });

  test("limit: 0 rejected", () => {
    expect(() =>
      validate(HEAD + `active:\n  most_applied_window_days: 30\n  most_applied_limit: 0\n`),
    ).toThrow(BrainConfigError);
  });

  test("limit: 51 rejected", () => {
    expect(() =>
      validate(HEAD + `active:\n  most_applied_window_days: 30\n  most_applied_limit: 51\n`),
    ).toThrow(BrainConfigError);
  });

  test("non-integer window_days rejected", () => {
    expect(() =>
      validate(HEAD + `active:\n  most_applied_window_days: 30.5\n  most_applied_limit: 10\n`),
    ).toThrow(BrainConfigError);
  });

  test("string window_days rejected", () => {
    expect(() => validate(HEAD + `active:\n  most_applied_window_days: "thirty"\n`)).toThrow(
      BrainConfigError,
    );
  });

  test("only window_days set → limit defaults to 10", () => {
    const { config } = validate(HEAD + `active:\n  most_applied_window_days: 14\n`);
    expect(config.active?.most_applied?.window_days).toBe(14);
    expect(config.active?.most_applied?.limit).toBe(10);
  });

  test("only limit set → window_days defaults to 30", () => {
    const { config } = validate(HEAD + `active:\n  most_applied_limit: 3\n`);
    expect(config.active?.most_applied?.window_days).toBe(30);
    expect(config.active?.most_applied?.limit).toBe(3);
  });

  test("unknown sub-key under active: emits warning, doesn't throw", () => {
    const { warnings } = validate(
      HEAD + `active:\n  most_applied_window_days: 30\n  future_thing: 1\n`,
    );
    const found = warnings.find((w) => w.message.includes("future_thing"));
    expect(found).toBeDefined();
  });

  test("non-object active value is a hard error", () => {
    expect(() => validate(HEAD + `active: not-a-map\n`)).toThrow(BrainConfigError);
  });
});
