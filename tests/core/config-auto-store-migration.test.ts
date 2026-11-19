/**
 * The `auto_store_migration` machine config key (change
 * auto-store-migration, decision D5): the automatic migration after an
 * update is ON by default, because the owner decision replaces the old
 * "offered, never run" rule; a machine opts out per machine, so the key
 * lives in the machine config and the environment overrides it for CI.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { autoStoreMigrationSetting, resolveAutoStoreMigration } from "../../src/core/config.ts";

const ENV = "OPEN_SECOND_BRAIN_AUTO_STORE_MIGRATION";

let tmp: string;
let configPath: string;
let savedEnv: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-config-auto-migrate-"));
  configPath = join(tmp, "config.yaml");
  savedEnv = process.env[ENV];
  delete process.env[ENV];
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV];
  else process.env[ENV] = savedEnv;
  rmSync(tmp, { recursive: true, force: true });
});

describe("auto_store_migration", () => {
  test("defaults to on", () => {
    expect(resolveAutoStoreMigration(configPath)).toBe(true);
  });

  test("the config key turns it off", () => {
    writeFileSync(configPath, "vault: /tmp/vault\nauto_store_migration: false\n");
    expect(resolveAutoStoreMigration(configPath)).toBe(false);
  });

  test("the config key keeps it on explicitly", () => {
    writeFileSync(configPath, "vault: /tmp/vault\nauto_store_migration: true\n");
    expect(resolveAutoStoreMigration(configPath)).toBe(true);
  });

  test("off wins: the environment never turns it on over a config opt-out", () => {
    writeFileSync(configPath, "vault: /tmp/vault\nauto_store_migration: false\n");
    process.env[ENV] = "1";
    expect(resolveAutoStoreMigration(configPath)).toBe(false);
    process.env[ENV] = "true";
    expect(resolveAutoStoreMigration(configPath)).toBe(false);
  });

  test("off wins: the environment turns it off over a config that says on", () => {
    writeFileSync(configPath, "vault: /tmp/vault\nauto_store_migration: true\n");
    process.env[ENV] = "false";
    expect(resolveAutoStoreMigration(configPath)).toBe(false);
  });

  test("an absent config answers the default", () => {
    expect(resolveAutoStoreMigration(join(tmp, "missing.yaml"))).toBe(true);
  });

  test("a config that cannot be read means no automatic migration, and never throws", () => {
    // A directory in the file's place: present, and not readable as a config.
    mkdirSync(configPath);
    expect(resolveAutoStoreMigration(configPath)).toBe(false);
    const setting = autoStoreMigrationSetting(configPath);
    expect(setting.enabled).toBe(false);
    expect(setting.unreadable).not.toBeNull();
  });

  const ON = ["true", "TRUE", "True", "1", "yes", "YES", "on", "On", "  true  ", "true # keep it"];
  const OFF = ["false", "FALSE", "False", "0", "no", "No", "off", "OFF", "false  # keep it off"];
  const UNRECOGNISED = ["maybe", "2", "nope", "disabled", "'"];

  for (const value of ON) {
    test(`the config value ${JSON.stringify(value)} is on`, () => {
      writeFileSync(configPath, `auto_store_migration: ${value}\n`);
      expect(autoStoreMigrationSetting(configPath)).toMatchObject({
        enabled: true,
        unrecognised: [],
      });
    });
  }

  for (const value of OFF) {
    test(`the config value ${JSON.stringify(value)} is off`, () => {
      writeFileSync(configPath, `auto_store_migration: ${value}\n`);
      expect(autoStoreMigrationSetting(configPath)).toMatchObject({
        enabled: false,
        unrecognised: [],
      });
    });
    test(`the environment value ${JSON.stringify(value)} is off`, () => {
      process.env[ENV] = value;
      expect(autoStoreMigrationSetting(configPath)).toMatchObject({
        enabled: false,
        unrecognised: [],
      });
    });
  }

  for (const value of UNRECOGNISED) {
    test(`the config value ${JSON.stringify(value)} is off and reported`, () => {
      writeFileSync(configPath, `auto_store_migration: ${value}\n`);
      const setting = autoStoreMigrationSetting(configPath);
      expect(setting.enabled).toBe(false);
      expect(setting.unrecognised).toEqual([{ source: "config", value: value.trim() }]);
    });
    test(`the environment value ${JSON.stringify(value)} is off and reported`, () => {
      process.env[ENV] = value;
      const setting = autoStoreMigrationSetting(configPath);
      expect(setting.enabled).toBe(false);
      expect(setting.unrecognised).toEqual([{ source: "environment", value: value.trim() }]);
    });
  }

  test("a key with no value is off and reported", () => {
    writeFileSync(configPath, "auto_store_migration:\n");
    const setting = autoStoreMigrationSetting(configPath);
    expect(setting.enabled).toBe(false);
    expect(setting.unrecognised).toEqual([{ source: "config", value: "" }]);
  });

  test("an empty environment value counts as unset", () => {
    process.env[ENV] = "  ";
    expect(autoStoreMigrationSetting(configPath)).toMatchObject({
      enabled: true,
      unrecognised: [],
    });
  });
});
