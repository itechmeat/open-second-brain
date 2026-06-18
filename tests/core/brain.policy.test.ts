import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseBrainYaml } from "../../src/core/brain/yaml-parse.ts";
import {
  BRAIN_CONFIG_SUPPORTED_VERSIONS,
  BrainConfigError,
  DEFAULT_BRAIN_CONFIG,
  DEFAULT_BRAIN_CONFIG_YAML,
  formatPrimaryAgentYamlValue,
  loadBrainConfig,
  loadBrainConfigDetailed,
  validateBrainConfig,
  validateBrainConfigDetailed,
} from "../../src/core/brain/policy.ts";
import { resolveSchemaVocabulary } from "../../src/core/brain/schema-vocab.ts";

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
    expect(DEFAULT_BRAIN_CONFIG.primary_agent).toBeNull();
    expect(DEFAULT_BRAIN_CONFIG.dream.candidate_threshold).toBe(3);
    expect(DEFAULT_BRAIN_CONFIG.dream.unconfirmed_window_days).toBe(14);
    expect(DEFAULT_BRAIN_CONFIG.dream.contradiction_window_days).toBe(14);
    expect(DEFAULT_BRAIN_CONFIG.retire.stale_evidence_days).toBe(90);
    expect(DEFAULT_BRAIN_CONFIG.confidence.low_max_applied).toBe(2);
    expect(DEFAULT_BRAIN_CONFIG.confidence.medium_min).toBe(0.4);
    expect(DEFAULT_BRAIN_CONFIG.confidence.high_min).toBe(0.75);
    expect(DEFAULT_BRAIN_CONFIG.snapshots.retention_count).toBe(10);
  });

  test("primary_agent default is null and YAML round-trips", () => {
    const parsed = parseBrainYaml(DEFAULT_BRAIN_CONFIG_YAML);
    const config = validateBrainConfig(parsed, "<default>");
    expect(config.primary_agent).toBeNull();
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
    const config = validateBrainConfig(JSON.parse(JSON.stringify(DEFAULT_BRAIN_CONFIG)), "<test>");
    expect(config.schema_version).toBe(1);
    expect(config.snapshots.retention_count).toBe(10);
  });

  test("fills missing blocks from defaults", () => {
    const config = validateBrainConfig({ schema_version: 1 }, "<test>");
    expect(config.dream.candidate_threshold).toBe(3);
    expect(config.retire.stale_evidence_days).toBe(90);
    expect(config.confidence.medium_min).toBe(0.4);
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

describe("validateBrainConfig — schema block", () => {
  test("absent schema block keeps the default config unchanged", () => {
    expect(DEFAULT_BRAIN_CONFIG).not.toHaveProperty("schema");

    const cfg = validateBrainConfig({ schema_version: 1 }, "<test>");
    expect(cfg.schema).toBeUndefined();
    expect(resolveSchemaVocabulary(cfg.schema).preference_types).toEqual(["preference"]);
  });

  test("accepts inline array declarations and resolves them through schema vocabulary", () => {
    const cfg = validateBrainConfig(
      parseBrainYaml(
        [
          "schema_version: 1",
          "schema:",
          "  preference_types: [research, decision]",
          "  signal_types: [observation]",
          "  page_types: [paper, researcher]",
          "  log_event_kinds: [milestone]",
        ].join("\n"),
      ),
      "<schema>",
    );

    expect(cfg.schema?.preference_types).toEqual(["research", "decision"]);
    const vocab = resolveSchemaVocabulary(cfg.schema);
    expect(vocab.preference_types).toEqual(["preference", "research", "decision"]);
    expect(vocab.signal_types).toEqual(["feedback", "observation"]);
    expect(vocab.page_types).toEqual(["note", "paper", "researcher"]);
    expect(vocab.log_event_kinds).toContain("milestone");
  });

  test("rejects invalid schema tokens with a field-named error", () => {
    let thrown: unknown;
    try {
      validateBrainConfig(
        parseBrainYaml("schema_version: 1\nschema:\n  preference_types: [research, ../escape]\n"),
        "<schema>",
      );
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain("schema.preference_types[1]");
    expect(message.match(/schema\.preference_types\[1\]/g)?.length).toBe(1);
  });

  test("unknown schema subkeys warn without failing validation", () => {
    const result = validateBrainConfigDetailed(
      parseBrainYaml(
        "schema_version: 1\nschema:\n  preference_types: [research]\n  routing_hints: [later]\n",
      ),
      "<schema>",
    );

    expect(result.config.schema?.preference_types).toEqual(["research"]);
    expect(result.warnings.map((warning) => warning.message)).toContain(
      "schema.routing_hints: unknown field ignored (forward-compat)",
    );
  });

  test("accepts schema mutation metadata without warning", () => {
    const result = validateBrainConfigDetailed(
      parseBrainYaml(
        [
          "schema_version: 1",
          "schema:",
          "  preference_types: [research]",
          "  aliases:",
          "    - research=study",
          "  prefixes:",
          "    - pref=research",
          "  link_types: [supports]",
          "  extractable: [research]",
          "  expert_routing:",
          "    - research=schema-author",
        ].join("\n"),
      ),
      "<schema>",
    );

    expect(result.config.schema?.aliases).toEqual(["research=study"]);
    expect(result.config.schema?.prefixes).toEqual(["pref=research"]);
    expect(result.config.schema?.link_types).toEqual(["supports"]);
    expect(result.config.schema?.extractable).toEqual(["research"]);
    expect(result.config.schema?.expert_routing).toEqual(["research=schema-author"]);
    expect(result.warnings.map((warning) => warning.message)).not.toContain(
      "schema.aliases: unknown field ignored (forward-compat)",
    );
  });

  test("rejects blank schema metadata entries after trimming", () => {
    expect(() =>
      validateBrainConfig(
        parseBrainYaml("schema_version: 1\nschema:\n  aliases:\n    - '   '\n"),
        "<schema>",
      ),
    ).toThrow("schema.aliases[0]");
  });
});

describe("validateBrainConfig — feedback block", () => {
  test("absent feedback block leaves config.feedback undefined", () => {
    expect(DEFAULT_BRAIN_CONFIG).not.toHaveProperty("feedback");
    const cfg = validateBrainConfig({ schema_version: 1 }, "<test>");
    expect(cfg.feedback).toBeUndefined();
  });

  test("accepts a valid default_scope", () => {
    const cfg = validateBrainConfig(
      parseBrainYaml("schema_version: 1\nfeedback:\n  default_scope: coding\n"),
      "<test>",
    );
    expect(cfg.feedback?.default_scope).toBe("coding");
  });

  test("empty feedback block leaves default_scope undefined", () => {
    const cfg = validateBrainConfig({ schema_version: 1, feedback: {} }, "<test>");
    expect(cfg.feedback).toBeDefined();
    expect(cfg.feedback?.default_scope).toBeUndefined();
  });

  test("unknown feedback subkeys warn without failing validation", () => {
    const result = validateBrainConfigDetailed(
      parseBrainYaml(
        "schema_version: 1\nfeedback:\n  default_scope: coding\n  typo_scope: research\n",
      ),
      "<test>",
    );

    expect(result.config.feedback?.default_scope).toBe("coding");
    expect(result.warnings.map((warning) => warning.message)).toContain(
      "feedback.typo_scope: unknown field ignored (forward-compat)",
    );
  });

  test("rejects a non-string default_scope", () => {
    expect(() =>
      validateBrainConfig(
        parseBrainYaml("schema_version: 1\nfeedback:\n  default_scope: 42\n"),
        "<test>",
      ),
    ).toThrow(/feedback\.default_scope/);
  });

  test("rejects a blank default_scope", () => {
    expect(() =>
      validateBrainConfig(
        parseBrainYaml("schema_version: 1\nfeedback:\n  default_scope: '   '\n"),
        "<test>",
      ),
    ).toThrow(/feedback\.default_scope/);
  });

  test("rejects an over-long default_scope (>128 chars)", () => {
    const huge = "x".repeat(129);
    expect(() =>
      validateBrainConfig(
        parseBrainYaml(`schema_version: 1\nfeedback:\n  default_scope: "${huge}"\n`),
        "<test>",
      ),
    ).toThrow(/feedback\.default_scope/);
  });

  test("rejects a non-map feedback block", () => {
    expect(() =>
      validateBrainConfig(parseBrainYaml("schema_version: 1\nfeedback: not-a-map\n"), "<test>"),
    ).toThrow(/feedback/);
  });
});

describe("validateBrainConfig — primary_agent", () => {
  test("absent → null (default)", () => {
    const cfg = validateBrainConfig({ schema_version: 1 }, "<test>");
    expect(cfg.primary_agent).toBeNull();
  });

  test("explicit null is accepted", () => {
    const cfg = validateBrainConfig({ schema_version: 1, primary_agent: null }, "<test>");
    expect(cfg.primary_agent).toBeNull();
  });

  test("non-empty string is preserved and trimmed", () => {
    const cfg = validateBrainConfig(
      { schema_version: 1, primary_agent: "  hermes-vps  " },
      "<test>",
    );
    expect(cfg.primary_agent).toBe("hermes-vps");
  });

  test("empty string rejected with named field", () => {
    try {
      validateBrainConfig({ schema_version: 1, primary_agent: "" }, "<test>");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(BrainConfigError);
      expect((err as BrainConfigError).field).toBe("primary_agent");
    }
  });

  test("whitespace-only string rejected", () => {
    expect(() =>
      validateBrainConfig({ schema_version: 1, primary_agent: "   " }, "<test>"),
    ).toThrow(/primary_agent/);
  });

  test("non-string non-null rejected", () => {
    expect(() => validateBrainConfig({ schema_version: 1, primary_agent: 42 }, "<test>")).toThrow(
      /primary_agent/,
    );
  });
});

describe("formatPrimaryAgentYamlValue", () => {
  test("quotes strings so comment-like content round-trips", () => {
    const scalar = formatPrimaryAgentYamlValue("hermes lead # primary");
    expect(scalar).toBe('"hermes lead # primary"');
    const cfg = validateBrainConfig(
      parseBrainYaml(`schema_version: 1\nprimary_agent: ${scalar}\n`),
    );
    expect(cfg.primary_agent).toBe("hermes lead # primary");
  });

  test("rejects values that would need escaping in the tiny YAML parser", () => {
    expect(() => formatPrimaryAgentYamlValue("agent\nnext")).toThrow(/disallowed character/);
    expect(() => formatPrimaryAgentYamlValue("agent\rnext")).toThrow(/disallowed character/);
    expect(() => formatPrimaryAgentYamlValue("agent\\path")).toThrow(/disallowed character/);
    expect(() => formatPrimaryAgentYamlValue('agent "quoted"')).toThrow(/disallowed character/);
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
    expect(() => validateBrainConfig({ schema_version: 99 }, "<test>")).toThrow(/schema_version/);
  });

  test("non-integer schema_version → error", () => {
    expect(() => validateBrainConfig({ schema_version: "1" }, "<test>")).toThrow(/schema_version/);
    expect(() => validateBrainConfig({ schema_version: 1.5 }, "<test>")).toThrow(/schema_version/);
  });

  test("negative threshold → error naming the field", () => {
    try {
      validateBrainConfig({ schema_version: 1, dream: { candidate_threshold: -1 } }, "<test>");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(BrainConfigError);
      expect((err as BrainConfigError).field).toBe("dream.candidate_threshold");
    }
  });

  test("non-integer threshold → error", () => {
    expect(() =>
      validateBrainConfig({ schema_version: 1, dream: { candidate_threshold: 3.5 } }, "<test>"),
    ).toThrow(/positive integer/);
  });

  test("zero candidate_threshold → error (must be positive)", () => {
    expect(() =>
      validateBrainConfig({ schema_version: 1, dream: { candidate_threshold: 0 } }, "<test>"),
    ).toThrow(/positive integer/);
  });

  test("snapshots.retention_count must be positive integer", () => {
    expect(() =>
      validateBrainConfig({ schema_version: 1, snapshots: { retention_count: 0 } }, "<test>"),
    ).toThrow(/positive integer/);
    expect(() =>
      validateBrainConfig({ schema_version: 1, snapshots: { retention_count: -5 } }, "<test>"),
    ).toThrow(/positive integer/);
    expect(() =>
      validateBrainConfig({ schema_version: 1, snapshots: { retention_count: 1.5 } }, "<test>"),
    ).toThrow(/positive integer/);
  });

  test("non-object root → error", () => {
    expect(() => validateBrainConfig(null, "<test>")).toThrow(BrainConfigError);
    expect(() => validateBrainConfig(42, "<test>")).toThrow(BrainConfigError);
    expect(() => validateBrainConfig([], "<test>")).toThrow(BrainConfigError);
  });

  test("non-object block → error", () => {
    expect(() => validateBrainConfig({ schema_version: 1, dream: 5 }, "<test>")).toThrow(/dream/);
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
    expect(result.warnings.map((w) => w.message).join("\n")).toContain("future_field");
    expect(result.warnings.map((w) => w.message).join("\n")).toContain("another");
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

describe("validateBrainConfig — vault block (v0.10.9)", () => {
  test("absent vault block leaves config.vault undefined", () => {
    const cfg = validateBrainConfig({ schema_version: 1 }, "<test>");
    expect(cfg.vault).toBeUndefined();
  });

  test("vault block present without ignore_paths leaves vault undefined", () => {
    // Walker behaviour is identical to "absent block" (fall back to
    // defaults) — see design §4 table row 2.
    const cfg = validateBrainConfig({ schema_version: 1, vault: {} }, "<test>");
    expect(cfg.vault).toBeUndefined();
  });

  test("vault.ignore_paths populated → preserved verbatim", () => {
    const cfg = validateBrainConfig(
      {
        schema_version: 1,
        vault: { ignore_paths: [".git", "node_modules", "Brain/.snapshots"] },
      },
      "<test>",
    );
    expect(cfg.vault?.ignore_paths).toEqual([".git", "node_modules", "Brain/.snapshots"]);
  });

  test("vault.ignore_paths empty array honoured as explicit empty", () => {
    const cfg = validateBrainConfig({ schema_version: 1, vault: { ignore_paths: [] } }, "<test>");
    expect(cfg.vault?.ignore_paths).toEqual([]);
  });

  test("vault.ignore_paths inline [] YAML form is honoured as explicit empty", () => {
    const cfg = validateBrainConfig(
      parseBrainYaml(`schema_version: 1\nvault:\n  ignore_paths: []\n`),
      "<test>",
    );
    expect(cfg.vault?.ignore_paths).toEqual([]);
  });

  test("vault block not a map → BrainConfigError naming the field", () => {
    expect(() => validateBrainConfig({ schema_version: 1, vault: 5 }, "<test>")).toThrow(/vault/);
  });

  test("vault.ignore_paths not an array → BrainConfigError", () => {
    expect(() =>
      validateBrainConfig({ schema_version: 1, vault: { ignore_paths: "not-a-list" } }, "<test>"),
    ).toThrow(/vault\.ignore_paths/);
  });

  test("non-string entry → BrainConfigError naming the index", () => {
    expect(() =>
      validateBrainConfig({ schema_version: 1, vault: { ignore_paths: [".git", 42] } }, "<test>"),
    ).toThrow(/vault\.ignore_paths\[1\]/);
  });

  test("empty-string entry rejected", () => {
    expect(() =>
      validateBrainConfig({ schema_version: 1, vault: { ignore_paths: ["   "] } }, "<test>"),
    ).toThrow(/non-empty/);
  });

  test("entry with newline is rejected", () => {
    expect(() =>
      validateBrainConfig({ schema_version: 1, vault: { ignore_paths: ["bad\nentry"] } }, "<test>"),
    ).toThrow(/vault\.ignore_paths\[0\]/);
  });

  test("unknown sub-key under vault produces a warning, not an error", () => {
    const result = validateBrainConfigDetailed(
      {
        schema_version: 1,
        vault: { ignore_paths: [".git"], unknown_extra: true },
      },
      "<test>",
    );
    expect(result.config.vault?.ignore_paths).toEqual([".git"]);
    expect(result.warnings.some((w) => w.message.includes("unknown_extra"))).toBe(true);
  });

  test("DEFAULT_BRAIN_CONFIG_YAML parses with the vault block populated", () => {
    const parsed = parseBrainYaml(DEFAULT_BRAIN_CONFIG_YAML);
    const cfg = validateBrainConfig(parsed, "<default>");
    expect(cfg.vault?.ignore_paths).toContain(".obsidian");
    expect(cfg.vault?.ignore_paths).toContain("Brain/.snapshots");
  });

  test("trailing slash on a path entry is normalised, not silently dropped", () => {
    const cfg = validateBrainConfig(
      { schema_version: 1, vault: { ignore_paths: ["Brain/.snapshots/"] } },
      "<test>",
    );
    expect(cfg.vault?.ignore_paths).toEqual(["Brain/.snapshots"]);
  });

  test("leading ./ on a path entry is normalised", () => {
    const cfg = validateBrainConfig(
      { schema_version: 1, vault: { ignore_paths: ["./Brain/.snapshots"] } },
      "<test>",
    );
    expect(cfg.vault?.ignore_paths).toEqual(["Brain/.snapshots"]);
  });

  test("entry that normalises to empty (e.g. './' / '/') is rejected", () => {
    expect(() =>
      validateBrainConfig({ schema_version: 1, vault: { ignore_paths: ["./"] } }, "<test>"),
    ).toThrow(/vault\.ignore_paths\[0\].*empty/);
    expect(() =>
      validateBrainConfig({ schema_version: 1, vault: { ignore_paths: ["///"] } }, "<test>"),
    ).toThrow(/vault\.ignore_paths\[0\].*empty/);
  });

  test("leading-slash entry is rejected (matchIgnore cannot match it)", () => {
    expect(() =>
      validateBrainConfig(
        { schema_version: 1, vault: { ignore_paths: ["/Brain/.snapshots"] } },
        "<test>",
      ),
    ).toThrow(/vault\.ignore_paths\[0\].*leading '\/'/);
  });
});

describe("loadBrainConfig — filesystem integration", () => {
  test("loads a well-formed config from <vault>/Brain/_brain.yaml", () => {
    writeBrainYaml(tmp, DEFAULT_BRAIN_CONFIG_YAML);
    const cfg = loadBrainConfig(tmp);
    expect(cfg).toEqual(DEFAULT_BRAIN_CONFIG);
  });

  test("loadBrainConfigDetailed returns warnings + path", () => {
    writeBrainYaml(tmp, `${DEFAULT_BRAIN_CONFIG_YAML}\nfuture_field: 1\n`);
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

  test("dream.heal_enrich_enabled defaults to false", () => {
    writeBrainYaml(tmp, DEFAULT_BRAIN_CONFIG_YAML);
    expect(loadBrainConfig(tmp).dream.heal_enrich_enabled).toBe(false);
  });

  test("dream.heal_enrich_enabled can be opted in via YAML", () => {
    writeBrainYaml(
      tmp,
      "schema_version: 1\ndream:\n  candidate_threshold: 3\n  unconfirmed_window_days: 14\n  contradiction_window_days: 14\n  heal_enrich_enabled: true\n",
    );
    expect(loadBrainConfig(tmp).dream.heal_enrich_enabled).toBe(true);
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

  test("parses inline scalar arrays", () => {
    const parsed = parseBrainYaml(
      `schema_version: 1\nvault:\n  ignore_paths: [Drafts, "Drafts/cache"]\n`,
    );
    expect((parsed["vault"] as { ignore_paths: unknown }).ignore_paths).toEqual([
      "Drafts",
      "Drafts/cache",
    ]);
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
    expect(() => parseBrainYaml(`top:\n  middle:\n    leaf: 1\n`)).toThrow(/deeper than one level/);
  });

  test("rejects duplicate top-level key", () => {
    expect(() => parseBrainYaml(`schema_version: 1\nschema_version: 2\n`)).toThrow(/duplicate/);
  });
});
