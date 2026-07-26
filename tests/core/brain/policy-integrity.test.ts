/**
 * `integrity` block (context-integrity-gates) - the three-mode delivery
 * and embedding-ABI gates plus the context-pack validity window.
 *
 * Same shape as `policy-guardrails.test.ts`: defaults, absent block,
 * partial block, every out-of-range rejection, non-object block, unknown
 * sub-key warning. Out-of-range values are hard errors - this block must
 * never clamp or silently default, because a gate that quietly reverts
 * to `off` is precisely the silent degradation the wave removes.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseBrainYaml } from "../../../src/core/brain/yaml-parse.ts";
import {
  BRAIN_INTEGRITY_DEFAULTS,
  BRAIN_INTEGRITY_STRICT_FALLBACK,
  BrainConfigError,
  brainConfigReadFailure,
  loadIntegrityConfigSafe,
  PACK_VALIDITY_SECONDS_DEFAULT,
  resolveIntegrity,
  validateBrainConfigDetailed,
} from "../../../src/core/brain/policy.ts";
import {
  BRAIN_INTEGRITY_DEFAULTS as BARREL_DEFAULTS,
  resolveIntegrity as barrelResolveIntegrity,
} from "../../../src/core/brain/index.ts";
import { GATE_MODE } from "../../../src/core/integrity/stamp.ts";

function validate(yaml: string) {
  return validateBrainConfigDetailed(parseBrainYaml(yaml), "<test>");
}

const HEAD = `schema_version: 1\n`;
const GATE_KEYS = ["owner_scope_delivery", "embedding_abi"] as const;

describe("BRAIN_INTEGRITY_DEFAULTS", () => {
  test("owner_scope_delivery defaults to off so no existing vault narrows", () => {
    expect(BRAIN_INTEGRITY_DEFAULTS.owner_scope_delivery).toBe(GATE_MODE.off);
  });

  test("embedding_abi defaults to warn (vec_version is not stable across peers)", () => {
    expect(BRAIN_INTEGRITY_DEFAULTS.embedding_abi).toBe(GATE_MODE.warn);
  });

  test("pack_validity_seconds defaults to the documented window", () => {
    expect(BRAIN_INTEGRITY_DEFAULTS.pack_validity_seconds).toBe(PACK_VALIDITY_SECONDS_DEFAULT);
    expect(Number.isInteger(PACK_VALIDITY_SECONDS_DEFAULT)).toBe(true);
    expect(PACK_VALIDITY_SECONDS_DEFAULT).toBeGreaterThan(0);
  });

  test("is frozen", () => {
    expect(Object.isFrozen(BRAIN_INTEGRITY_DEFAULTS)).toBe(true);
  });

  test("is reachable through the Brain barrel", () => {
    expect(BARREL_DEFAULTS).toBe(BRAIN_INTEGRITY_DEFAULTS);
    expect(barrelResolveIntegrity(validate(HEAD).config)).toEqual(BRAIN_INTEGRITY_DEFAULTS);
  });
});

describe("integrity config block", () => {
  test("absent block → cfg.integrity is undefined; resolveIntegrity returns defaults", () => {
    const { config, warnings } = validate(HEAD);
    expect(config.integrity).toBeUndefined();
    expect(resolveIntegrity(config)).toEqual(BRAIN_INTEGRITY_DEFAULTS);
    expect(warnings.length).toBe(0);
  });

  test("`integrity` is a known top-level key (no forward-compat warning)", () => {
    const { warnings } = validateBrainConfigDetailed(
      { schema_version: 1, integrity: {} },
      "<test>",
    );
    expect(warnings.length).toBe(0);
  });

  test("present with all three fields → loaded fully", () => {
    const { config } = validate(
      HEAD +
        `integrity:\n` +
        `  owner_scope_delivery: fail\n` +
        `  embedding_abi: off\n` +
        `  pack_validity_seconds: 60\n`,
    );
    expect(config.integrity).toEqual({
      owner_scope_delivery: "fail",
      embedding_abi: "off",
      pack_validity_seconds: 60,
    });
    expect(resolveIntegrity(config)).toEqual({
      owner_scope_delivery: "fail",
      embedding_abi: "off",
      pack_validity_seconds: 60,
    });
  });

  test("each mode key accepts every gate mode", () => {
    for (const key of GATE_KEYS) {
      for (const mode of ["off", "warn", "fail"] as const) {
        const { config } = validate(HEAD + `integrity:\n  ${key}: ${mode}\n`);
        expect(config.integrity?.[key]).toBe(mode);
        expect(resolveIntegrity(config)[key]).toBe(mode);
      }
    }
  });

  test("partial block → missing fields fall back to defaults via resolveIntegrity", () => {
    const { config } = validate(HEAD + `integrity:\n  owner_scope_delivery: warn\n`);
    expect(config.integrity?.owner_scope_delivery).toBe("warn");
    expect(config.integrity?.embedding_abi).toBeUndefined();
    const resolved = resolveIntegrity(config);
    expect(resolved.owner_scope_delivery).toBe("warn");
    expect(resolved.embedding_abi).toBe(BRAIN_INTEGRITY_DEFAULTS.embedding_abi);
    expect(resolved.pack_validity_seconds).toBe(BRAIN_INTEGRITY_DEFAULTS.pack_validity_seconds);
  });

  test("an invalid mode string is rejected, naming the dotted field", () => {
    for (const key of GATE_KEYS) {
      for (const bad of ["on", "true", "OFF", "Warn", "refuse"]) {
        let caught: unknown;
        try {
          validate(HEAD + `integrity:\n  ${key}: ${bad}\n`);
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(BrainConfigError);
        expect((caught as BrainConfigError).field).toBe(`integrity.${key}`);
        expect((caught as BrainConfigError).message).toContain(`integrity.${key}`);
      }
    }
  });

  test("a non-string mode value is rejected", () => {
    for (const key of GATE_KEYS) {
      for (const bad of ["1", "true", "null", "0.5"]) {
        expect(() => validate(HEAD + `integrity:\n  ${key}: ${bad}\n`)).toThrow(BrainConfigError);
      }
    }
  });

  test("pack_validity_seconds: 0 rejected", () => {
    let caught: unknown;
    try {
      validate(HEAD + `integrity:\n  pack_validity_seconds: 0\n`);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BrainConfigError);
    expect((caught as BrainConfigError).field).toBe("integrity.pack_validity_seconds");
  });

  test("pack_validity_seconds: negative rejected", () => {
    expect(() => validate(HEAD + `integrity:\n  pack_validity_seconds: -1\n`)).toThrow(
      BrainConfigError,
    );
  });

  test("pack_validity_seconds: non-integer rejected", () => {
    expect(() => validate(HEAD + `integrity:\n  pack_validity_seconds: 2.5\n`)).toThrow(
      BrainConfigError,
    );
  });

  test("pack_validity_seconds: non-number rejected", () => {
    expect(() => validate(HEAD + `integrity:\n  pack_validity_seconds: soon\n`)).toThrow(
      BrainConfigError,
    );
  });

  test("pack_validity_seconds: 1 accepted (no clamping, no silent default)", () => {
    const { config } = validate(HEAD + `integrity:\n  pack_validity_seconds: 1\n`);
    expect(config.integrity?.pack_validity_seconds).toBe(1);
    expect(resolveIntegrity(config).pack_validity_seconds).toBe(1);
  });

  test("non-object integrity block rejected", () => {
    expect(() => validate(HEAD + `integrity: "nope"\n`)).toThrow(BrainConfigError);
  });

  test("unknown sub-key warns but does not throw", () => {
    const { config, warnings } = validate(
      HEAD + `integrity:\n  embedding_abi: fail\n  unknown_field: 1\n`,
    );
    expect(config.integrity?.embedding_abi).toBe("fail");
    expect(warnings.some((w) => w.message.includes("integrity.unknown_field"))).toBe(true);
  });

  test("a block of only unknown sub-keys still resolves to defaults", () => {
    const { config, warnings } = validate(HEAD + `integrity:\n  unknown_field: 1\n`);
    expect(config.integrity).toEqual({});
    expect(resolveIntegrity(config)).toEqual(BRAIN_INTEGRITY_DEFAULTS);
    expect(warnings.length).toBe(1);
  });

  test("each known sub-key emits no forward-compat warning", () => {
    for (const key of [...GATE_KEYS, "pack_validity_seconds"] as const) {
      const value = key === "pack_validity_seconds" ? "30" : "warn";
      const { warnings } = validate(HEAD + `integrity:\n  ${key}: ${value}\n`);
      expect(warnings.some((w) => w.message.includes(`integrity.${key}`))).toBe(false);
    }
  });
});

/**
 * `loadIntegrityConfigSafe` used to be a bare `try { … } catch { return
 * defaults }`, which made ANY `_brain.yaml` problem - a bad gate token or
 * an unrelated syntax error a hundred lines away - silently turn
 * `owner_scope_delivery: fail` into `off`. An isolation boundary
 * disabled by a typo, with no signal on any surface, is the exact class
 * of degradation this block exists to gate.
 */
describe("loadIntegrityConfigSafe distinguishes absent from unreadable", () => {
  let vault: string;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "o2b-integrity-safe-"));
    mkdirSync(join(vault, "Brain"), { recursive: true });
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  test("a never-initialized vault gets the documented defaults", () => {
    expect(loadIntegrityConfigSafe(vault)).toEqual(BRAIN_INTEGRITY_DEFAULTS);
    expect(brainConfigReadFailure(vault)).toBeNull();
  });

  test("an unrelated syntax error does NOT disable the isolation gate", () => {
    writeFileSync(
      join(vault, "Brain", "_brain.yaml"),
      "schema_version: 1\nintegrity:\n  owner_scope_delivery: fail\nnotes:\n  read_paths: 5\n",
      "utf8",
    );
    const resolved = loadIntegrityConfigSafe(vault);
    expect(resolved.owner_scope_delivery).not.toBe(GATE_MODE.off);
    expect(resolved).toEqual(BRAIN_INTEGRITY_STRICT_FALLBACK);
  });

  test("an unreadable config is nameable rather than silent", () => {
    writeFileSync(join(vault, "Brain", "_brain.yaml"), "schema_version: 9\n", "utf8");
    const failure = brainConfigReadFailure(vault);
    expect(failure).not.toBeNull();
    expect(failure!.length).toBeGreaterThan(0);
  });

  test("a valid config still resolves exactly what the operator wrote", () => {
    writeFileSync(
      join(vault, "Brain", "_brain.yaml"),
      "schema_version: 1\nintegrity:\n  owner_scope_delivery: warn\n",
      "utf8",
    );
    expect(loadIntegrityConfigSafe(vault).owner_scope_delivery).toBe(GATE_MODE.warn);
    expect(brainConfigReadFailure(vault)).toBeNull();
  });
});
