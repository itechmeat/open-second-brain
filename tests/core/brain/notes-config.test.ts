/**
 * Task 1: `notes:` config block + atom types.
 *
 * Asserts the optional `notes:` block on `_brain.yaml`:
 *   - `BRAIN_NOTES_DEFAULTS` exposes an empty `read_paths` slot.
 *   - `resolveNotes(cfg)` returns a fully-populated struct.
 *   - The validator rejects non-arrays, non-strings, empty strings,
 *     absolute paths, and `..` traversal.
 *   - Unknown sub-keys emit a forward-compat warning, not an error.
 */

import { describe, expect, test } from "bun:test";

import {
  BrainConfigError,
  BRAIN_NOTES_DEFAULTS,
  parseBrainYaml,
  resolveNotes,
  validateBrainConfigDetailed,
} from "../../../src/core/brain/policy.ts";

function validate(yaml: string) {
  return validateBrainConfigDetailed(parseBrainYaml(yaml), "<test>");
}

const HEAD = `schema_version: 1\n`;

describe("BRAIN_NOTES_DEFAULTS", () => {
  test("starts with an empty read_paths array", () => {
    expect(BRAIN_NOTES_DEFAULTS.read_paths).toEqual([]);
  });

  test("is frozen and the array is frozen", () => {
    expect(Object.isFrozen(BRAIN_NOTES_DEFAULTS)).toBe(true);
    expect(Object.isFrozen(BRAIN_NOTES_DEFAULTS.read_paths)).toBe(true);
  });
});

describe("notes config block", () => {
  test("absent block - cfg.notes undefined; resolveNotes returns defaults", () => {
    const { config } = validate(HEAD);
    expect(config.notes).toBeUndefined();
    expect(resolveNotes(config)).toEqual(BRAIN_NOTES_DEFAULTS);
  });

  test("present with a single read_path", () => {
    const { config } = validate(
      HEAD + `notes:\n  read_paths:\n    - Daily\n`,
    );
    expect(config.notes).toEqual({ read_paths: ["Daily"] });
    expect(resolveNotes(config).read_paths).toEqual(["Daily"]);
  });

  test("present with multiple read_paths preserves order", () => {
    const { config } = validate(
      HEAD +
        `notes:\n` +
        `  read_paths:\n` +
        `    - Daily\n` +
        `    - Journal/Weekly\n` +
        `    - Notes\n`,
    );
    expect(resolveNotes(config).read_paths).toEqual([
      "Daily",
      "Journal/Weekly",
      "Notes",
    ]);
  });

  test("explicit empty array preserves the empty-list intent", () => {
    const { config } = validate(HEAD + `notes:\n  read_paths: []\n`);
    expect(config.notes).toEqual({ read_paths: [] });
    expect(resolveNotes(config).read_paths).toEqual([]);
  });

  test("rejects non-mapping notes", () => {
    expect(() => validate(HEAD + `notes: Daily\n`)).toThrow(
      BrainConfigError,
    );
  });

  test("rejects non-array read_paths", () => {
    expect(() =>
      validate(HEAD + `notes:\n  read_paths: Daily\n`),
    ).toThrow(BrainConfigError);
  });

  test("rejects non-string entries", () => {
    expect(() =>
      validate(HEAD + `notes:\n  read_paths:\n    - 42\n`),
    ).toThrow(BrainConfigError);
  });

  test("rejects empty / whitespace-only string entries", () => {
    expect(() =>
      validate(HEAD + `notes:\n  read_paths:\n    - ""\n`),
    ).toThrow(BrainConfigError);
    expect(() =>
      validate(HEAD + `notes:\n  read_paths:\n    - "   "\n`),
    ).toThrow(BrainConfigError);
  });

  test("rejects absolute paths", () => {
    expect(() =>
      validate(HEAD + `notes:\n  read_paths:\n    - /etc/daily\n`),
    ).toThrow(BrainConfigError);
  });

  test("rejects parent-traversal", () => {
    expect(() =>
      validate(HEAD + `notes:\n  read_paths:\n    - ../escape\n`),
    ).toThrow(BrainConfigError);
    expect(() =>
      validate(HEAD + `notes:\n  read_paths:\n    - Daily/../etc\n`),
    ).toThrow(BrainConfigError);
  });

  test("trims surrounding whitespace on each entry", () => {
    const { config } = validate(
      HEAD + `notes:\n  read_paths:\n    - "  Daily  "\n`,
    );
    expect(resolveNotes(config).read_paths).toEqual(["Daily"]);
  });

  test("unknown sub-keys emit a forward-compat warning, not an error", () => {
    const { config, warnings } = validate(
      HEAD +
        `notes:\n` +
        `  read_paths:\n    - Daily\n` +
        `  future_field: hello\n`,
    );
    expect(config.notes).toEqual({ read_paths: ["Daily"] });
    expect(
      warnings.some((w) => w.message.includes("notes.future_field")),
    ).toBe(true);
  });

  test("resolveNotes returns frozen output", () => {
    const { config } = validate(HEAD);
    const resolved = resolveNotes(config);
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolved.read_paths)).toBe(true);
  });
});
