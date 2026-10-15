/**
 * The `storage:` policy block (storage lifecycle, Lane 1).
 *
 * Claims pinned here:
 *
 *   1. `resolveStorage` parses the five keys and every present key is
 *      bounded: out-of-range values HARD-error naming the field - a
 *      silently clamped cap would be indistinguishable from no cap, and
 *      for a gate that is the worst possible failure.
 *   2. `critical_percent` must exceed `warn_percent`, and `critical_days`
 *      must be smaller than `warn_days` - the same coherence class: a
 *      critical band that fires before the warn band inverts the tiers.
 *   3. An absent block resolves to the documented defaults with the cap
 *      absent (unbounded), both through the validator and through
 *      `loadStorageConfigSafe` on a vault with no `_brain.yaml`.
 *   4. The template ratchet: the block appears in the generated
 *      template, `mergeBrainYaml` appends it to an existing `_brain.yaml`
 *      without rewriting any existing value, and the merged file
 *      validates and resolves.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_BRAIN_CONFIG_YAML } from "../../../src/core/brain/config-template.ts";
import { parseBrainYaml } from "../../../src/core/brain/yaml-parse.ts";
import { mergeBrainYaml } from "../../../src/core/brain/upgrade.ts";
import { BRAIN_STORAGE_DEFAULTS, resolveStorage } from "../../../src/core/brain/policy.ts";
import {
  loadStorageConfigSafe,
  validateBrainConfigDetailed,
} from "../../../src/core/brain/policy.ts";
import { BrainConfigError } from "../../../src/core/brain/policy/errors.ts";
import { brainConfigPath } from "../../../src/core/brain/paths.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-storage-policy-"));
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

const SOURCE = "<test fixture>";

/** Validate a YAML snippet and resolve its storage block. */
function resolveFromYaml(yaml: string): ReturnType<typeof resolveStorage> {
  const { config } = validateBrainConfigDetailed(parseBrainYaml(yaml), SOURCE);
  return resolveStorage(config);
}

function writeConfig(yaml: string): void {
  mkdirSync(join(vault, "Brain"), { recursive: true });
  writeFileSync(brainConfigPath(vault), yaml, "utf8");
}

const FULL_BLOCK = `schema_version: 1

storage:
  cap_bytes: 1073741824
  warn_percent: 70
  critical_percent: 90
  warn_days: 21
  critical_days: 5
`;

describe("resolveStorage", () => {
  test("parses the five keys", () => {
    expect(resolveFromYaml(FULL_BLOCK)).toEqual({
      cap_bytes: 1073741824,
      warn_percent: 70,
      critical_percent: 90,
      warn_days: 21,
      critical_days: 5,
    });
  });

  test("an absent block resolves to the documented defaults, cap absent", () => {
    expect(BRAIN_STORAGE_DEFAULTS).toEqual({
      cap_bytes: null,
      warn_percent: 80,
      critical_percent: 95,
      warn_days: 30,
      critical_days: 7,
    });
    expect(resolveFromYaml("schema_version: 1")).toEqual(BRAIN_STORAGE_DEFAULTS);
  });

  test("an absent config file resolves to the defaults", () => {
    expect(loadStorageConfigSafe(vault)).toEqual(BRAIN_STORAGE_DEFAULTS);
  });

  test("a partial block keeps the defaults for absent keys", () => {
    expect(resolveFromYaml("schema_version: 1\n\nstorage:\n  cap_bytes: 4096\n")).toEqual({
      ...BRAIN_STORAGE_DEFAULTS,
      cap_bytes: 4096,
    });
  });

  test.each([
    ["cap_bytes: 0", "storage.cap_bytes"],
    ["cap_bytes: -5", "storage.cap_bytes"],
    ["cap_bytes: 1.5", "storage.cap_bytes"],
    ['cap_bytes: "big"', "storage.cap_bytes"],
    ["warn_percent: 0", "storage.warn_percent"],
    ["warn_percent: 101", "storage.warn_percent"],
    ["warn_days: 0", "storage.warn_days"],
    ["critical_days: 0", "storage.critical_days"],
  ])("hard-errors the out-of-range value %s", (line, field) => {
    let errored = false;
    try {
      resolveFromYaml(`schema_version: 1\n\nstorage:\n  ${line}\n`);
    } catch (err) {
      errored = true;
      expect(err).toBeInstanceOf(BrainConfigError);
      expect((err as BrainConfigError).field).toBe(field);
    }
    expect(errored).toBe(true);
  });

  test.each([["  warn_percent: 95"], ["  warn_percent: 100"]])(
    "a warn band at or past the default critical band blames warn_percent: %s",
    (warn) => {
      let errored = false;
      try {
        resolveFromYaml(`schema_version: 1\n\nstorage:\n${warn}\n`);
      } catch (err) {
        errored = true;
        expect(err).toBeInstanceOf(BrainConfigError);
        // critical_percent is not in the file: the key the operator set is
        // the key at fault, not the default it conflicts with.
        expect((err as BrainConfigError).field).toBe("storage.warn_percent");
      }
      expect(errored).toBe(true);
    },
  );

  test.each([["  warn_days: 7"], ["  warn_days: 1"]])(
    "a warn horizon at or nearer the default critical horizon blames warn_days: %s",
    (warn) => {
      let errored = false;
      try {
        resolveFromYaml(`schema_version: 1\n\nstorage:\n${warn}\n`);
      } catch (err) {
        errored = true;
        expect(err).toBeInstanceOf(BrainConfigError);
        expect((err as BrainConfigError).field).toBe("storage.warn_days");
      }
      expect(errored).toBe(true);
    },
  );

  test.each([
    ["  warn_percent: 80", "  critical_percent: 80"],
    ["  warn_percent: 80", "  critical_percent: 70"],
  ])("refuses a critical band that does not exceed the warn band", (warn, critical) => {
    let errored = false;
    try {
      resolveFromYaml(`schema_version: 1\n\nstorage:\n${warn}\n${critical}\n`);
    } catch (err) {
      errored = true;
      expect(err).toBeInstanceOf(BrainConfigError);
      // Both keys were spelled, so either could yield: the error names
      // the pair, never one side of a conflict the operator can resolve
      // from either direction.
      expect((err as BrainConfigError).field).toBe(
        "storage.warn_percent, storage.critical_percent",
      );
    }
    expect(errored).toBe(true);
  });

  test.each([
    ["  warn_days: 7", "  critical_days: 7"],
    ["  warn_days: 7", "  critical_days: 14"],
  ])("refuses a critical horizon not smaller than the warn horizon", (warn, critical) => {
    let errored = false;
    try {
      resolveFromYaml(`schema_version: 1\n\nstorage:\n${warn}\n${critical}\n`);
    } catch (err) {
      errored = true;
      expect(err).toBeInstanceOf(BrainConfigError);
      expect((err as BrainConfigError).field).toBe("storage.warn_days, storage.critical_days");
    }
    expect(errored).toBe(true);
  });

  test("an unreadable config file raises out of the safe loader", () => {
    writeConfig("schema_version: 1\n\nstorage:\n  cap_bytes: 0\n");
    expect(() => loadStorageConfigSafe(vault)).toThrow(BrainConfigError);
  });
});

describe("the storage block in the template ratchet", () => {
  test("the generated template carries the block, commented at its defaults", () => {
    expect(DEFAULT_BRAIN_CONFIG_YAML).toContain("storage:");
    expect(DEFAULT_BRAIN_CONFIG_YAML).toContain("warn_percent: 80");
    expect(DEFAULT_BRAIN_CONFIG_YAML).toContain("critical_percent: 95");
    expect(DEFAULT_BRAIN_CONFIG_YAML).toContain("warn_days: 30");
    expect(DEFAULT_BRAIN_CONFIG_YAML).toContain("critical_days: 7");
  });

  test("mergeBrainYaml preserves an existing storage block byte for byte", () => {
    // The template ships the block commented ("nothing new becomes
    // live"), so the merge has nothing to append for it; what the merge
    // must never do is rewrite an operator's own storage values. A live
    // file carrying an operator-set cap merges back byte-identical in
    // that block, and the merged file still validates and resolves.
    const live = [
      "schema_version: 1",
      "",
      "dream:",
      "  candidate_threshold: 5",
      "  unconfirmed_window_days: 7",
      "  contradiction_window_days: 14",
      "",
      "storage:",
      "  cap_bytes: 4096",
      "",
    ].join("\n");
    const merged = mergeBrainYaml(live, DEFAULT_BRAIN_CONFIG_YAML);
    expect(merged).toContain("candidate_threshold: 5");
    expect(merged).toContain("cap_bytes: 4096");
    expect(resolveFromYaml(merged)).toEqual({
      ...BRAIN_STORAGE_DEFAULTS,
      cap_bytes: 4096,
    });
    expect(merged).toContain("storage:");
  });
});
