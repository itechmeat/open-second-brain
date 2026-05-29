/**
 * Named multi-vault profiles (Vault portability suite, Feature 4).
 *
 * A profile registry (name -> vault path) stored in a profiles.json
 * beside the config, with list / create / switch. Activation is a
 * pointer in that file (no symlinks). `resolveVault` consults the active
 * profile before the bare config `vault` key; with no profiles it is
 * unchanged (back-compat).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createProfile,
  listProfiles,
  switchProfile,
  resolveActiveProfileVault,
} from "../../../../src/core/brain/portability/profiles.ts";
import { resolveVault } from "../../../../src/core/config.ts";
import { atomicWriteFileSync } from "../../../../src/core/fs-atomic.ts";

let home: string;
let configPath: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "o2b-profiles-"));
  configPath = join(home, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${join(home, "default-vault")}\n`);
  delete process.env["VAULT_DIR"];
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("profile registry", () => {
  test("create + list", () => {
    createProfile(configPath, "work", "/srv/vaults/work");
    createProfile(configPath, "personal", "/srv/vaults/personal");
    const { profiles, active } = listProfiles(configPath);
    expect(profiles.map((p) => p.name).sort()).toEqual(["personal", "work"]);
    expect(active).toBeNull();
  });

  test("switch sets the active pointer", () => {
    createProfile(configPath, "work", "/srv/vaults/work");
    switchProfile(configPath, "work");
    expect(listProfiles(configPath).active).toBe("work");
    expect(resolveActiveProfileVault(configPath)).toBe("/srv/vaults/work");
  });

  test("switching to an unknown profile throws", () => {
    expect(() => switchProfile(configPath, "ghost")).toThrow();
  });

  test("resolveActiveProfileVault is null with no active profile", () => {
    expect(resolveActiveProfileVault(configPath)).toBeNull();
  });
});

describe("resolveVault integration", () => {
  test("returns the active profile's vault when one is active", () => {
    createProfile(configPath, "work", "/srv/vaults/work");
    switchProfile(configPath, "work");
    expect(resolveVault(configPath)).toBe("/srv/vaults/work");
  });

  test("falls back to the config vault when no profile is active (back-compat)", () => {
    expect(resolveVault(configPath)).toBe(join(home, "default-vault"));
  });
});
