/**
 * The `recall_inject:` block of `Brain/_brain.yaml`: operator-declared
 * recall slices. Slice names are declared once in `slices:` and every
 * per-slice field is flat-encoded as `slice_<name>_<field>`, so a typo in
 * either half is a hard load error rather than a silently ignored key.
 */

import { describe, expect, test } from "bun:test";

import { BrainConfigError } from "../../../../src/core/brain/policy/errors.ts";
import {
  validateBrainConfig,
  validateBrainConfigDetailed,
} from "../../../../src/core/brain/policy/validate.ts";
import { parseBrainYaml } from "../../../../src/core/brain/yaml-parse.ts";

function load(block: string) {
  return validateBrainConfigDetailed(
    parseBrainYaml(`schema_version: 1\nrecall_inject:\n${block}`),
    "<test fixture>",
  );
}

function expectFieldError(block: string, field: string): void {
  let caught: unknown;
  try {
    load(block);
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(BrainConfigError);
  expect((caught as BrainConfigError).field).toBe(field);
}

const CONTRACT_EXAMPLE = [
  "  slices: [decisions, lessons]",
  "  slice_decisions_heading: Recent decisions",
  "  slice_decisions_path_prefix: Brain/decisions/",
  "  slice_decisions_types: [decision]",
  "  slice_decisions_limit: 2",
  "  slice_decisions_max_chars: 400",
  "  slice_lessons_path_prefix: Brain/lessons",
  "",
].join("\n");

describe("recall_inject block", () => {
  test("the contract example parses to two slices in declared order", () => {
    const { config, warnings } = load(CONTRACT_EXAMPLE);
    expect(warnings).toEqual([]);
    expect(config.recall_inject).toEqual({
      slices: [
        {
          name: "decisions",
          heading: "Recent decisions",
          pathPrefix: "Brain/decisions/",
          types: ["decision"],
          limit: 2,
          maxChars: 400,
        },
        {
          name: "lessons",
          heading: "lessons",
          pathPrefix: "Brain/lessons",
          types: [],
          limit: null,
          maxChars: null,
        },
      ],
    });
  });

  test("a vault without the block has no recall_inject key", () => {
    const config = validateBrainConfig(parseBrainYaml("schema_version: 1\n"), "<test fixture>");
    expect("recall_inject" in config).toBe(false);
  });

  test("an unknown field for a declared slice is a hard error", () => {
    expectFieldError(
      "  slices: [decisions]\n  slice_decisions_sort: recency\n",
      "recall_inject.slice_decisions_sort",
    );
  });

  test("a slice key for an undeclared name is a hard error", () => {
    expectFieldError(
      "  slices: [decisions]\n  slice_lessons_limit: 2\n",
      "recall_inject.slice_lessons_limit",
    );
  });

  test("a duplicate slice name is a hard error", () => {
    expectFieldError("  slices: [decisions, decisions]\n", "recall_inject.slices");
  });

  test("a slice name outside the pattern is a hard error", () => {
    expectFieldError("  slices: [Decisions]\n", "recall_inject.slices");
    expectFieldError("  slices: [my_slice]\n", "recall_inject.slices");
    expectFieldError("  slices: [1st]\n", "recall_inject.slices");
    expectFieldError(`  slices: [a${"b".repeat(24)}]\n`, "recall_inject.slices");
  });

  test("more than six slices is a hard error", () => {
    expectFieldError("  slices: [a, b, c, d, e, f, g]\n", "recall_inject.slices");
    expect(load("  slices: [a, b, c, d, e, f]\n").config.recall_inject?.slices).toHaveLength(6);
  });

  test("slices that is not an array is a hard error", () => {
    expectFieldError("  slices: decisions\n", "recall_inject.slices");
  });

  test("limit outside 1..10 is a hard error", () => {
    expectFieldError("  slices: [a]\n  slice_a_limit: 0\n", "recall_inject.slice_a_limit");
    expectFieldError("  slices: [a]\n  slice_a_limit: 11\n", "recall_inject.slice_a_limit");
    expect(
      load("  slices: [a]\n  slice_a_limit: 10\n").config.recall_inject?.slices[0]?.limit,
    ).toBe(10);
  });

  test("max_chars outside 100..8000 is a hard error", () => {
    expectFieldError("  slices: [a]\n  slice_a_max_chars: 99\n", "recall_inject.slice_a_max_chars");
    expectFieldError(
      "  slices: [a]\n  slice_a_max_chars: 8001\n",
      "recall_inject.slice_a_max_chars",
    );
    expect(
      load("  slices: [a]\n  slice_a_max_chars: 100\n").config.recall_inject?.slices[0]?.maxChars,
    ).toBe(100);
  });

  test("types that is not an array is a hard error", () => {
    expectFieldError("  slices: [a]\n  slice_a_types: decision\n", "recall_inject.slice_a_types");
  });

  test("a blank heading or a blank types entry is a hard error", () => {
    expectFieldError('  slices: [a]\n  slice_a_heading: "  "\n', "recall_inject.slice_a_heading");
    expectFieldError('  slices: [a]\n  slice_a_types: ["  "]\n', "recall_inject.slice_a_types");
  });

  test("a non-string heading, a bare slice key and a fractional limit are hard errors", () => {
    expectFieldError("  slices: [a]\n  slice_a_heading: 5\n", "recall_inject.slice_a_heading");
    expectFieldError("  slices: [a]\n  slice_a_heading: [x]\n", "recall_inject.slice_a_heading");
    expectFieldError("  slices: [a]\n  slice_a: 1\n", "recall_inject.slice_a");
    expectFieldError("  slices: [a]\n  slice_a_limit: 2.5\n", "recall_inject.slice_a_limit");
    expectFieldError("  slices: [a]\n  slice_a_limit: -1\n", "recall_inject.slice_a_limit");
  });

  test("an empty slices list parses to no slices", () => {
    expect(load("  slices: []\n").config.recall_inject).toEqual({ slices: [] });
  });

  test("an unknown non-slice key warns and does not error", () => {
    const { config, warnings } = load("  slices: [a]\n  future_knob: 3\n");
    expect(config.recall_inject?.slices).toHaveLength(1);
    expect(warnings.map((w) => w.message)).toEqual([
      "recall_inject.future_knob: unknown field ignored (forward-compat)",
    ]);
  });

  test("path_prefix is normalised to forward slashes", () => {
    const { config } = load("  slices: [a]\n  slice_a_path_prefix: Brain\\decisions\\\n");
    expect(config.recall_inject?.slices[0]?.pathPrefix).toBe("Brain/decisions/");
  });

  test("a path_prefix containing .. is rejected", () => {
    expectFieldError(
      "  slices: [a]\n  slice_a_path_prefix: Brain/../private\n",
      "recall_inject.slice_a_path_prefix",
    );
  });

  test("an absolute or drive-letter path_prefix is rejected", () => {
    for (const prefix of ["/Brain", "/etc", "\\\\Brain\\\\x", "C:/Brain", "c:Brain"]) {
      expectFieldError(
        `  slices: [a]\n  slice_a_path_prefix: ${prefix}\n`,
        "recall_inject.slice_a_path_prefix",
      );
    }
  });
});
