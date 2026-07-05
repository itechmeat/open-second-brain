/**
 * `lessons:` config block (t_62363378) — tunables for the signed,
 * recency-scored lessons digest (`Brain/lessons.md`).
 */

import { describe, expect, test } from "bun:test";
import { parseBrainYaml } from "../../../src/core/brain/yaml-parse.ts";
import { BrainConfigError, validateBrainConfigDetailed } from "../../../src/core/brain/policy.ts";

function validate(yaml: string) {
  return validateBrainConfigDetailed(parseBrainYaml(yaml), "<test>");
}

const HEAD = `schema_version: 1\n`;

describe("lessons config block", () => {
  test("absent block → cfg.lessons is undefined; consumers use defaults", () => {
    const { config } = validate(HEAD);
    expect(config.lessons).toBeUndefined();
  });

  test("present values load into BrainLessonsConfig", () => {
    const { config } = validate(
      HEAD + `lessons:\n  half_life_days: 14\n  corroboration_min: 3\n  limit: 50\n`,
    );
    expect(config.lessons?.half_life_days).toBe(14);
    expect(config.lessons?.corroboration_min).toBe(3);
    expect(config.lessons?.limit).toBe(50);
  });

  test("partial block keeps other fields undefined (defaults apply downstream)", () => {
    const { config } = validate(HEAD + `lessons:\n  half_life_days: 45\n`);
    expect(config.lessons?.half_life_days).toBe(45);
    expect(config.lessons?.corroboration_min).toBeUndefined();
    expect(config.lessons?.limit).toBeUndefined();
  });

  test("half_life_days: 0 rejected", () => {
    expect(() => validate(HEAD + `lessons:\n  half_life_days: 0\n`)).toThrow(BrainConfigError);
  });

  test("half_life_days: 366 rejected", () => {
    expect(() => validate(HEAD + `lessons:\n  half_life_days: 366\n`)).toThrow(BrainConfigError);
  });

  test("corroboration_min: 0 rejected", () => {
    expect(() => validate(HEAD + `lessons:\n  corroboration_min: 0\n`)).toThrow(BrainConfigError);
  });

  test("limit: 201 rejected", () => {
    expect(() => validate(HEAD + `lessons:\n  limit: 201\n`)).toThrow(BrainConfigError);
  });

  test("non-integer half_life_days rejected", () => {
    expect(() => validate(HEAD + `lessons:\n  half_life_days: 30.5\n`)).toThrow(BrainConfigError);
  });

  test("string value rejected", () => {
    expect(() => validate(HEAD + `lessons:\n  half_life_days: "thirty"\n`)).toThrow(
      BrainConfigError,
    );
  });

  test("unknown sub-key warns, doesn't throw", () => {
    const { warnings } = validate(HEAD + `lessons:\n  half_life_days: 30\n  future_thing: 1\n`);
    expect(warnings.find((w) => w.message.includes("future_thing"))).toBeDefined();
  });

  test("non-object lessons value is a hard error", () => {
    expect(() => validate(HEAD + `lessons: not-a-map\n`)).toThrow(BrainConfigError);
  });

  test("empty lessons block is permitted", () => {
    const { config } = validate(HEAD + `lessons:\n  __reserved: 1\n`);
    expect(config.lessons).toEqual({});
  });
});
