/**
 * The `quote_check.*` config resolvers (answer-trust wave, Lane A).
 *
 * Three keys in the `quote_check` block of `Brain/_brain.yaml`, one
 * resolver each, no second reader: default `shadow` per phase,
 * `off|shadow|enforce` accepted, any other value a field-named error
 * naming `quote_check.<phase>` (never silently `off`), unknown block keys
 * warned per the strict-block convention. The resolvers are pure: the
 * brain config path in, the mode out; no environment variable and no
 * other file participates.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ANSWER_QUOTE_CHECK_MODES,
  isAnswerQuoteCheckMode,
  resolveAnswerQuoteCheckActive,
  resolveAnswerQuoteCheckRecall,
  resolveAnswerQuoteCheckSubagent,
} from "../../src/core/config.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-quote-check-config-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** Write a `Brain/_brain.yaml` under `root` and return its path. */
function brainYaml(body: string, root: string = tmp): string {
  const brain = join(root, "Brain");
  mkdirSync(brain, { recursive: true });
  const path = join(brain, "_brain.yaml");
  writeFileSync(path, body);
  return path;
}

/** A path under the throwaway root where nothing was ever written. */
function absentPath(): string {
  return join(tmp, "Brain", "missing", "_brain.yaml");
}

describe("ANSWER_QUOTE_CHECK_MODES vocabulary", () => {
  test("carries exactly the three modes and the guard accepts only them", () => {
    expect(ANSWER_QUOTE_CHECK_MODES).toEqual(["off", "shadow", "enforce"]);
    expect(isAnswerQuoteCheckMode("shadow")).toBe(true);
    for (const outsider of ["", "off ", "ON", "enforced", null, undefined, 42, {}]) {
      expect(isAnswerQuoteCheckMode(outsider)).toBe(false);
    }
  });
});

describe("resolveAnswerQuoteCheck* defaults", () => {
  test("an absent config file resolves every phase to shadow", () => {
    const absent = absentPath();
    expect(resolveAnswerQuoteCheckRecall(absent)).toBe("shadow");
    expect(resolveAnswerQuoteCheckActive(absent)).toBe("shadow");
    expect(resolveAnswerQuoteCheckSubagent(absent)).toBe("shadow");
  });

  test("a config without the block resolves every phase to shadow", () => {
    const path = brainYaml("schema_version: 2\n");
    expect(resolveAnswerQuoteCheckRecall(path)).toBe("shadow");
    expect(resolveAnswerQuoteCheckActive(path)).toBe("shadow");
    expect(resolveAnswerQuoteCheckSubagent(path)).toBe("shadow");
  });

  test("a block without the phase key resolves that phase to shadow", () => {
    const path = brainYaml("quote_check:\n  recall: enforce\n");
    expect(resolveAnswerQuoteCheckRecall(path)).toBe("enforce");
    expect(resolveAnswerQuoteCheckActive(path)).toBe("shadow");
    expect(resolveAnswerQuoteCheckSubagent(path)).toBe("shadow");
  });
});

describe("resolveAnswerQuoteCheck* accepted values", () => {
  for (const mode of ANSWER_QUOTE_CHECK_MODES) {
    test(`each resolver reads its own key: ${mode}`, () => {
      const path = brainYaml(
        `quote_check:\n  recall: ${mode}\n  active: ${mode}\n  subagent: ${mode}\n`,
      );
      expect(resolveAnswerQuoteCheckRecall(path)).toBe(mode);
      expect(resolveAnswerQuoteCheckActive(path)).toBe(mode);
      expect(resolveAnswerQuoteCheckSubagent(path)).toBe(mode);
    });
  }

  test("quoted values read the same as bare words", () => {
    const path = brainYaml('quote_check:\n  recall: "enforce"\n');
    expect(resolveAnswerQuoteCheckRecall(path)).toBe("enforce");
  });
});

describe("resolveAnswerQuoteCheck* refusals", () => {
  test("an unknown value is a field-named error, never a silent off", () => {
    const path = brainYaml("quote_check:\n  recall: enforced\n");
    expect(() => resolveAnswerQuoteCheckRecall(path)).toThrow(
      /quote_check\.recall: unsupported value "enforced"; expected one of off, shadow, enforce/,
    );
  });

  test("a wrongly typed value is the same field-named error", () => {
    const numbered = brainYaml("quote_check:\n  active: 3\n");
    expect(() => resolveAnswerQuoteCheckActive(numbered)).toThrow(/quote_check\.active:/);
    const flagged = brainYaml("quote_check:\n  subagent: true\n");
    expect(() => resolveAnswerQuoteCheckSubagent(flagged)).toThrow(/quote_check\.subagent:/);
    const empty = brainYaml("quote_check:\n  recall:\n");
    expect(() => resolveAnswerQuoteCheckRecall(empty)).toThrow(/quote_check\.recall:/);
  });

  test("a scalar block is a field-named error on the block", () => {
    const path = brainYaml("quote_check: enforce\n");
    expect(() => resolveAnswerQuoteCheckRecall(path)).toThrow(
      /quote_check: expected a block of per-phase modes/,
    );
  });

  test("a malformed YAML file is refused by name, with the parser's line detail", () => {
    const path = brainYaml("quote_check:\n    deep:\n        nested: 1\n");
    expect(() => resolveAnswerQuoteCheckRecall(path)).toThrow(
      /quote_check: failed to parse: line \d+/,
    );
  });
});

describe("unknown keys inside the quote_check block", () => {
  test("warn per the strict-block convention without disturbing the known keys", () => {
    const errWrite = spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const path = brainYaml("quote_check:\n  recall: off\n  bogus: enforce\n");
      expect(resolveAnswerQuoteCheckRecall(path)).toBe("off");
      const lines = errWrite.mock.calls
        .map((call) => String(call[0]))
        .filter((text) => text.includes("quote_check."));
      expect(lines).toEqual(["quote_check.bogus: unknown field ignored (forward-compat)\n"]);
    } finally {
      errWrite.mockRestore();
    }
  });

  test("warn once per key per process, not once per call", () => {
    const errWrite = spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const path = brainYaml("quote_check:\n  subagent: off\n  mistyped: shadow\n");
      resolveAnswerQuoteCheckSubagent(path);
      resolveAnswerQuoteCheckSubagent(path);
      const lines = errWrite.mock.calls
        .map((call) => String(call[0]))
        .filter((text) => text.includes("quote_check.mistyped"));
      expect(lines.length).toBe(1);
    } finally {
      errWrite.mockRestore();
    }
  });

  test("a block with only known keys warns nothing", () => {
    const errWrite = spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const path = brainYaml(
        "quote_check:\n  recall: off\n  active: enforce\n  subagent: shadow\n",
      );
      expect(resolveAnswerQuoteCheckActive(path)).toBe("enforce");
      const lines = errWrite.mock.calls
        .map((call) => String(call[0]))
        .filter((text) => text.includes("quote_check."));
      expect(lines).toEqual([]);
    } finally {
      errWrite.mockRestore();
    }
  });
});

describe("the resolvers are pure", () => {
  test("no environment variable and no second file participates", () => {
    const path = brainYaml("quote_check:\n  recall: enforce\n");
    const other = brainYaml("quote_check:\n  recall: off\n", join(tmp, "other-vault"));
    expect(other).not.toBe(path);
    process.env["OPEN_SECOND_BRAIN_QUOTE_CHECK_RECALL"] = "off";
    process.env["QUOTE_CHECK_RECALL"] = "off";
    process.env["OPEN_SECOND_BRAIN_RECALL_INJECT_ENABLED"] = "false";
    try {
      expect(resolveAnswerQuoteCheckRecall(path)).toBe("enforce");
      expect(resolveAnswerQuoteCheckRecall(other)).toBe("off");
    } finally {
      delete process.env["OPEN_SECOND_BRAIN_QUOTE_CHECK_RECALL"];
      delete process.env["QUOTE_CHECK_RECALL"];
      delete process.env["OPEN_SECOND_BRAIN_RECALL_INJECT_ENABLED"];
    }
  });

  test("without a path, the standard vault's Brain/_brain.yaml is read", () => {
    const vault = tmp;
    brainYaml("quote_check:\n  active: enforce\n", vault);
    process.env["VAULT_DIR"] = vault;
    try {
      expect(resolveAnswerQuoteCheckActive()).toBe("enforce");
      expect(resolveAnswerQuoteCheckRecall()).toBe("shadow");
    } finally {
      delete process.env["VAULT_DIR"];
    }
  });

  test("without a path and without a vault, the defaults apply", () => {
    process.env["VAULT_DIR"] = join(tmp, "no", "such", "vault");
    try {
      expect(resolveAnswerQuoteCheckSubagent()).toBe("shadow");
    } finally {
      delete process.env["VAULT_DIR"];
    }
  });
});
