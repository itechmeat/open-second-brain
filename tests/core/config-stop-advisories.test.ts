/**
 * Unit tests for the two default-ON switches of the end-of-turn
 * advisories: `stop_guardrail_enabled` (the brain-event reminder) and
 * `quote_check_enabled` (the answer-time quote check). Env wins over
 * config; only the literal `"false"` / `"0"` turn a switch off.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  resolveQuoteCheckEnabled,
  resolveStopAdvisoryDelivery,
  resolveStopGuardrailEnabled,
} from "../../src/core/config.ts";

const DELIVERY_ENV = "OPEN_SECOND_BRAIN_STOP_ADVISORY_DELIVERY";

const SWITCHES = [
  {
    name: "stop_guardrail_enabled",
    env: "OPEN_SECOND_BRAIN_STOP_GUARDRAIL_ENABLED",
    resolve: resolveStopGuardrailEnabled,
  },
  {
    name: "quote_check_enabled",
    env: "OPEN_SECOND_BRAIN_QUOTE_CHECK_ENABLED",
    resolve: resolveQuoteCheckEnabled,
  },
] as const;

let tmp: string;
let configPath: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-config-stop-advisories-"));
  configPath = join(tmp, "config.yaml");
  for (const env of [...SWITCHES.map((sw) => sw.env), DELIVERY_ENV]) {
    savedEnv[env] = process.env[env];
    delete process.env[env];
  }
});

afterEach(() => {
  for (const env of [...SWITCHES.map((sw) => sw.env), DELIVERY_ENV]) {
    if (savedEnv[env] === undefined) delete process.env[env];
    else process.env[env] = savedEnv[env];
  }
  rmSync(tmp, { recursive: true, force: true });
});

function writeConfig(entries: Record<string, string>): void {
  const body = Object.entries(entries)
    .map(([k, v]) => `${k}: "${v}"`)
    .join("\n");
  writeFileSync(configPath, body + "\n");
}

for (const { name, env, resolve } of SWITCHES) {
  describe(name, () => {
    test("defaults to on, with or without a config file", () => {
      expect(resolve(configPath)).toBe(true);
      writeConfig({});
      expect(resolve(configPath)).toBe(true);
    });

    test('"false" and "0" in the config turn it off', () => {
      for (const value of ["false", "0"]) {
        writeConfig({ [name]: value });
        expect(resolve(configPath)).toBe(false);
      }
    });

    test("any other value leaves it on", () => {
      for (const value of ["true", "1", "no", "off", ""]) {
        writeConfig({ [name]: value });
        expect(resolve(configPath)).toBe(true);
      }
    });

    test("the env override wins over the config, both ways", () => {
      writeConfig({ [name]: "true" });
      process.env[env] = "0";
      expect(resolve(configPath)).toBe(false);
      writeConfig({ [name]: "false" });
      process.env[env] = "true";
      expect(resolve(configPath)).toBe(true);
    });

    test("a blank env value falls back to the config", () => {
      writeConfig({ [name]: "false" });
      process.env[env] = "  ";
      expect(resolve(configPath)).toBe(false);
    });
  });
}

describe("stop_advisory_delivery", () => {
  test("defaults to async; only the literal sync selects the synchronous form", () => {
    expect(resolveStopAdvisoryDelivery(configPath)).toBe("async");
    writeConfig({ stop_advisory_delivery: "sync" });
    expect(resolveStopAdvisoryDelivery(configPath)).toBe("sync");
    writeConfig({ stop_advisory_delivery: "blocking" });
    expect(resolveStopAdvisoryDelivery(configPath)).toBe("async");
  });

  test("the env override wins both ways; a blank one falls back to the config", () => {
    writeConfig({ stop_advisory_delivery: "sync" });
    process.env[DELIVERY_ENV] = "async";
    expect(resolveStopAdvisoryDelivery(configPath)).toBe("async");
    writeConfig({});
    process.env[DELIVERY_ENV] = " sync ";
    expect(resolveStopAdvisoryDelivery(configPath)).toBe("sync");
    writeConfig({ stop_advisory_delivery: "sync" });
    process.env[DELIVERY_ENV] = "";
    expect(resolveStopAdvisoryDelivery(configPath)).toBe("sync");
  });
});
