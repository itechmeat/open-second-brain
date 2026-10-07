/**
 * Unit tests for the `hygiene_digest_enabled` resolver
 * (context-injection-pipeline, lane B, task B3).
 *
 * The flag gates the Stop hygiene-digest hook. Default OFF, env wins
 * over config, only the literal `"true"`/`"1"` are truthy - the shared
 * `resolveConfigFlag` body, pinned here against the same drift the
 * recall-inject flag tests pin theirs against.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveHygieneDigestEnabled } from "../../src/core/config.ts";

/** Env keys these tests own outright, whatever the outer shell set. */
const OWNED_ENV = ["OPEN_SECOND_BRAIN_HYGIENE_DIGEST_ENABLED"] as const;

let tmp: string;
let configPath: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-config-hygiene-digest-"));
  configPath = join(tmp, "config.yaml");
  for (const key of OWNED_ENV) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of OWNED_ENV) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  rmSync(tmp, { recursive: true, force: true });
});

function writeConfig(entries: Record<string, string>): void {
  const body = Object.entries(entries)
    .map(([k, v]) => `${k}: "${v}"`)
    .join("\n");
  writeFileSync(configPath, body + "\n");
}

describe("resolveHygieneDigestEnabled", () => {
  test("defaults to false", () => {
    expect(resolveHygieneDigestEnabled(configPath)).toBe(false);
  });

  test("turns on from config", () => {
    writeConfig({ hygiene_digest_enabled: "true" });
    expect(resolveHygieneDigestEnabled(configPath)).toBe(true);
  });

  test("turns on from env, which wins over config", () => {
    writeConfig({ hygiene_digest_enabled: "false" });
    process.env["OPEN_SECOND_BRAIN_HYGIENE_DIGEST_ENABLED"] = "1";
    expect(resolveHygieneDigestEnabled(configPath)).toBe(true);
  });

  test("values other than the truthy literals stay off", () => {
    for (const value of ["false", "0", "yes", ""]) {
      writeConfig({ hygiene_digest_enabled: value });
      expect(resolveHygieneDigestEnabled(configPath)).toBe(false);
    }
    writeConfig({});
    process.env["OPEN_SECOND_BRAIN_HYGIENE_DIGEST_ENABLED"] = "maybe";
    expect(resolveHygieneDigestEnabled(configPath)).toBe(false);
  });
});
