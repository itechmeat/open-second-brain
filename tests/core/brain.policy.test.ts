import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BRAIN_CONFIG_SUPPORTED_VERSIONS,
  BrainConfigError,
  DEFAULT_BRAIN_CONFIG,
  DEFAULT_BRAIN_CONFIG_YAML,
  loadBrainConfig,
  loadBrainConfigDetailed,
  parseBrainYaml,
  validateBrainConfig,
  validateBrainConfigDetailed,
} from "../../src/core/brain/policy.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-brain-policy-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeBrainYaml(vault: string, body: string): string {
  const brainDir = join(vault, "Brain");
  mkdirSync(brainDir, { recursive: true });
  const path = join(brainDir, "_brain.yaml");
  writeFileSync(path, body, "utf8");
  return path;
}

describe("DEFAULT_BRAIN_CONFIG", () => {
  test("matches the values listed in §10 of the design doc", () => {
    expect(DEFAULT_BRAIN_CONFIG.schema_version).toBe(1);
    expect(DEFAULT_BRAIN_CONFIG.dream.candidate_threshold).toBe(3);
    expect(DEFAULT_BRAIN_CONFIG.dream.unconfirmed_window_days).toBe(14);
    expect(DEFAULT_BRAIN_CONFIG.dream.contradiction_window_days).toBe(14);
    expect(DEFAULT_BRAIN_CONFIG.retire.stale_evidence_days).toBe(90);
    expect(DEFAULT_BRAIN_CONFIG.confidence.low_max_applied).toBe(2);
    expect(DEFAULT_BRAIN_CONFIG.confidence.high_min_applied).toBe(10);
    expect(DEFAULT_BRAIN_CONFIG.confidence.high_freshness_factor).toBe(0.8);
    expect(DEFAULT_BRAIN_CONFIG.snapshots.retention_count).toBe(10);
  });

  test("BRAIN_CONFIG_SUPPORTED_VERSIONS includes 1", () => {
    expect(BRAIN_CONFIG_SUPPORTED_VERSIONS).toContain(1);
  });

  test("DEFAULT_BRAIN_CONFIG_YAML parses back into a valid config", () => {
    const parsed = parseBrainYaml(DEFAULT_BRAIN_CONFIG_YAML);
    const config = validateBrainConfig(parsed, "<default>");
    expect(config).toEqual(DEFAULT_BRAIN_CONFIG);
  });
});

describe("validateBrainConfig — happy path", () => {
  test("accepts the default config", () => {
    const config = validateBrainConfig(
      JSON.parse(JSON.stringify(DEFAULT_BRAIN_CONFIG)),
      "<test>",
    );
    expect(config.schema_version).toBe(1);
    expect(config.snapshots.retention_count).toBe(10);
  });

  test("fills missing blocks from defaults", () => {
    const config = validateBrainConfig({ schema_version: 1 }, "<test>");
    expect(config.dream.candidate_threshold).toBe(3);
    expect(config.retire.stale_evidence_days).toBe(90);
    expect(config.confidence.high_freshness_factor).toBe(0.8);
    expect(config.snapshots.retention_count).toBe(10);
  });

  test("merges single overridden field with defaults", () => {
    const config = validateBrainConfig(
      {
        schema_version: 1,
        dream: { candidate_threshold: 5 },
      },
      "<test>",
    );
    expect(config.dream.candidate_threshold).toBe(5);
    // Untouched fields fall back to defaults.
    expect(config.dream.unconfirmed_window_days).toBe(14);
  });
});

describe("validateBrainConfig — error cases", () => {
  test("missing schema_version → error naming the field", () => {
    expect(() => validateBrainConfig({}, "<test>")).toThrow(BrainConfigError);
    try {
      validateBrainConfig({}, "<test>");
    } catch (err) {
      expect(err).toBeInstanceOf(BrainConfigError);
      expect((err as BrainConfigError).field).toBe("schema_version");
    }
  });

  test("unsupported schema_version → error", () => {
    expect(() =>
      validateBrainConfig({ schema_version: 99 }, "<test>"),
    ).toThrow(/schema_version/);
  });

  test("non-integer schema_version → error", () => {
    expect(() =>
      validateBrainConfig({ schema_version: "1" }, "<test>"),
    ).toThrow(/schema_version/);
    expect(() =>
      validateBrainConfig({ schema_version: 1.5 }, "<test>"),
    ).toThrow(/schema_version/);
  });

  test("negative threshold → error naming the field", () => {
    try {
      validateBrainConfig(
        { schema_version: 1, dream: { candidate_threshold: -1 } },
        "<test>",
      );
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(BrainConfigError);
      expect((err as BrainConfigError).field).toBe("dream.candidate_threshold");
    }
  });

  test("non-integer threshold → error", () => {
    expect(() =>
      validateBrainConfig(
        { schema_version: 1, dream: { candidate_threshold: 3.5 } },
        "<test>",
      ),
    ).toThrow(/positive integer/);
  });

  test("zero candidate_threshold → error (must be positive)", () => {
    expect(() =>
      validateBrainConfig(
        { schema_version: 1, dream: { candidate_threshold: 0 } },
        "<test>",
      ),
    ).toThrow(/positive integer/);
  });

  test("high_freshness_factor <= 0 → error", () => {
    expect(() =>
      validateBrainConfig(
        { schema_version: 1, confidence: { high_freshness_factor: 0 } },
        "<test>",
      ),
    ).toThrow(/\(0, 1\]/);
    expect(() =>
      validateBrainConfig(
        { schema_version: 1, confidence: { high_freshness_factor: -0.1 } },
        "<test>",
      ),
    ).toThrow(/\(0, 1\]/);
  });

  test("high_freshness_factor > 1 → error", () => {
    expect(() =>
      validateBrainConfig(
        { schema_version: 1, confidence: { high_freshness_factor: 1.5 } },
        "<test>",
      ),
    ).toThrow(/\(0, 1\]/);
  });

  test("high_freshness_factor == 1 is accepted (inclusive upper bound)", () => {
    const cfg = validateBrainConfig(
      { schema_version: 1, confidence: { high_freshness_factor: 1 } },
      "<test>",
    );
    expect(cfg.confidence.high_freshness_factor).toBe(1);
  });

  test("snapshots.retention_count must be positive integer", () => {
    expect(() =>
      validateBrainConfig(
        { schema_version: 1, snapshots: { retention_count: 0 } },
        "<test>",
      ),
    ).toThrow(/positive integer/);
    expect(() =>
      validateBrainConfig(
        { schema_version: 1, snapshots: { retention_count: -5 } },
        "<test>",
      ),
    ).toThrow(/positive integer/);
    expect(() =>
      validateBrainConfig(
        { schema_version: 1, snapshots: { retention_count: 1.5 } },
        "<test>",
      ),
    ).toThrow(/positive integer/);
  });

  test("non-object root → error", () => {
    expect(() => validateBrainConfig(null, "<test>")).toThrow(BrainConfigError);
    expect(() => validateBrainConfig(42, "<test>")).toThrow(BrainConfigError);
    expect(() => validateBrainConfig([], "<test>")).toThrow(BrainConfigError);
  });

  test("non-object block → error", () => {
    expect(() =>
      validateBrainConfig({ schema_version: 1, dream: 5 }, "<test>"),
    ).toThrow(/dream/);
  });

  test("confidence.low_max_applied = 0 is allowed (non-negative)", () => {
    const cfg = validateBrainConfig(
      { schema_version: 1, confidence: { low_max_applied: 0 } },
      "<test>",
    );
    expect(cfg.confidence.low_max_applied).toBe(0);
  });
});

describe("validateBrainConfig — warnings (forward-compat)", () => {
  test("unknown top-level keys produce warnings, not errors", () => {
    const result = validateBrainConfigDetailed(
      { schema_version: 1, future_field: "x", another: 42 },
      "<test>",
    );
    expect(result.warnings.length).toBe(2);
    expect(result.warnings.map((w) => w.message).join("\n")).toContain(
      "future_field",
    );
    expect(result.warnings.map((w) => w.message).join("\n")).toContain(
      "another",
    );
    expect(result.config.schema_version).toBe(1);
  });

  test("no warnings on a fully-known config", () => {
    const result = validateBrainConfigDetailed(
      JSON.parse(JSON.stringify(DEFAULT_BRAIN_CONFIG)),
      "<test>",
    );
    expect(result.warnings.length).toBe(0);
  });
});

describe("loadBrainConfig — filesystem integration", () => {
  test("loads a well-formed config from <vault>/Brain/_brain.yaml", () => {
    writeBrainYaml(tmp, DEFAULT_BRAIN_CONFIG_YAML);
    const cfg = loadBrainConfig(tmp);
    expect(cfg).toEqual(DEFAULT_BRAIN_CONFIG);
  });

  test("loadBrainConfigDetailed returns warnings + path", () => {
    writeBrainYaml(
      tmp,
      `${DEFAULT_BRAIN_CONFIG_YAML}\nfuture_field: 1\n`,
    );
    const result = loadBrainConfigDetailed(tmp);
    expect(result.path).toBe(join(tmp, "Brain", "_brain.yaml"));
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]!.message).toContain("future_field");
  });

  test("missing file → BrainConfigError pointing at init", () => {
    expect(() => loadBrainConfig(tmp)).toThrow(/o2b brain init/);
  });

  test("malformed YAML → BrainConfigError", () => {
    writeBrainYaml(tmp, "schema_version: 1\nthis is not yaml: [unbalanced\n");
    // Top-level key with an inline-array-like value is parsed as a string,
    // so this particular text actually parses. Use a real shape error: a
    // child line at the top level (no parent block).
    writeBrainYaml(tmp, "schema_version: 1\n  nested_without_parent: 1\n");
    expect(() => loadBrainConfig(tmp)).toThrow(BrainConfigError);
  });

  test("non-object dream block → BrainConfigError", () => {
    writeBrainYaml(tmp, "schema_version: 1\ndream: 5\n");
    expect(() => loadBrainConfig(tmp)).toThrow(/dream/);
  });
});

describe("parseBrainYaml", () => {
  test("parses scalars: numbers, floats, quoted strings, booleans, null", () => {
    const parsed = parseBrainYaml(
      `schema_version: 1\nint_val: 42\nfloat_val: 0.8\nstr_val: "hello"\nbool_t: true\nbool_f: false\nnone: null\n`,
    );
    expect(parsed["schema_version"]).toBe(1);
    expect(parsed["int_val"]).toBe(42);
    expect(parsed["float_val"]).toBe(0.8);
    expect(parsed["str_val"]).toBe("hello");
    expect(parsed["bool_t"]).toBe(true);
    expect(parsed["bool_f"]).toBe(false);
    expect(parsed["none"]).toBeNull();
  });

  test("parses one-level indented blocks", () => {
    const parsed = parseBrainYaml(
      `schema_version: 1\ndream:\n  candidate_threshold: 3\n  unconfirmed_window_days: 14\n`,
    );
    expect(parsed["dream"]).toEqual({
      candidate_threshold: 3,
      unconfirmed_window_days: 14,
    });
  });

  test("strips comments and blank lines", () => {
    const parsed = parseBrainYaml(
      `# comment\nschema_version: 1\n\n# another\ndream:\n  # nested comment\n  candidate_threshold: 3\n`,
    );
    expect(parsed["schema_version"]).toBe(1);
    expect(parsed["dream"]).toEqual({ candidate_threshold: 3 });
  });

  test("rejects nested blocks deeper than one level", () => {
    expect(() =>
      parseBrainYaml(
        `top:\n  middle:\n    leaf: 1\n`,
      ),
    ).toThrow(/deeper than one level/);
  });

  test("rejects duplicate top-level key", () => {
    expect(() =>
      parseBrainYaml(`schema_version: 1\nschema_version: 2\n`),
    ).toThrow(/duplicate/);
  });
});
