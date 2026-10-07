import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  resolveNearDuplicateRetireSiblingsEnabled,
  resolveNearDuplicateWriteWideningEnabled,
} from "../../src/core/config.ts";

const CASES = [
  {
    resolve: resolveNearDuplicateRetireSiblingsEnabled,
    key: "near_duplicate_retire_siblings_enabled",
    env: "OPEN_SECOND_BRAIN_NEAR_DUPLICATE_RETIRE_SIBLINGS_ENABLED",
  },
  {
    resolve: resolveNearDuplicateWriteWideningEnabled,
    key: "near_duplicate_write_widening_enabled",
    env: "OPEN_SECOND_BRAIN_NEAR_DUPLICATE_WRITE_WIDENING_ENABLED",
  },
] as const;

let tmp: string;
let configPath: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-config-near-dup-"));
  configPath = join(tmp, "config.yaml");
  for (const { env } of CASES) {
    savedEnv[env] = process.env[env];
    delete process.env[env];
  }
});

afterEach(() => {
  for (const { env } of CASES) {
    if (savedEnv[env] === undefined) delete process.env[env];
    else process.env[env] = savedEnv[env];
  }
  rmSync(tmp, { recursive: true, force: true });
});

for (const { resolve, key, env } of CASES) {
  describe(key, () => {
    test("defaults to off", () => {
      expect(resolve(configPath)).toBe(false);
    });

    test("the config key turns it on", () => {
      writeFileSync(configPath, `${key}: "true"\n`);
      expect(resolve(configPath)).toBe(true);
    });

    test("the env var turns it on", () => {
      process.env[env] = "1";
      expect(resolve(configPath)).toBe(true);
    });
  });
}
