/**
 * CLI smoke test for `o2b search --property KEY=VALUE`.
 *
 * The full search pipeline needs an indexed vault to return real
 * results; this test focuses on the property-flag parsing surface
 * (rejection of malformed values) so it stays fast and does not
 * require sqlite-vec.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../helpers/run-cli.ts";

let tmp: string;
let vault: string;
let configHome: string;
let configPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-search-property-cli-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
  mkdirSync(join(vault, "Brain", "retired"), { recursive: true });
  mkdirSync(join(vault, "Brain", "inbox"), { recursive: true });
  mkdirSync(join(vault, "Brain", "log"), { recursive: true });
  writeFileSync(join(vault, "Brain", "_brain.yaml"), "schema_version: 1\n");

  configHome = mkdtempSync(join(tmpdir(), "o2b-search-property-cli-cfg-"));
  configPath = join(configHome, "config.yaml");
  writeFileSync(configPath, `vault: ${vault}\nagent_name: test\n`);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

describe("o2b search --property", () => {
  test("malformed --property without '=' is rejected", async () => {
    const r = await runCli(
      ["search", "foo", "--property", "no-equals-here"],
      { env: { OPEN_SECOND_BRAIN_CONFIG: configPath } },
    );
    expect(r.returncode).not.toBe(0);
    expect(r.stderr).toContain("--property must be KEY=VALUE");
  });

  test("--property KEY=  rejects empty value", async () => {
    const r = await runCli(
      ["search", "foo", "--property", "type="],
      { env: { OPEN_SECOND_BRAIN_CONFIG: configPath } },
    );
    expect(r.returncode).not.toBe(0);
    expect(r.stderr).toContain("KEY=VALUE");
  });

  test("--property =VALUE rejects empty key", async () => {
    const r = await runCli(
      ["search", "foo", "--property", "=decision"],
      { env: { OPEN_SECOND_BRAIN_CONFIG: configPath } },
    );
    expect(r.returncode).not.toBe(0);
    expect(r.stderr).toContain("KEY=VALUE");
  });
});
