/**
 * CLI smoke test for `o2b brain summary` (v0.10.16).
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
  tmp = mkdtempSync(join(tmpdir(), "o2b-brain-summary-cli-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
  mkdirSync(join(vault, "Brain", "retired"), { recursive: true });
  mkdirSync(join(vault, "Brain", "inbox"), { recursive: true });
  mkdirSync(join(vault, "Brain", "log"), { recursive: true });
  writeFileSync(join(vault, "Brain", "_brain.yaml"), "schema_version: 1\n");

  configHome = mkdtempSync(join(tmpdir(), "o2b-brain-summary-cli-cfg-"));
  configPath = join(configHome, "config.yaml");
  writeFileSync(configPath, `vault: ${vault}\nagent_name: test\n`);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

describe("o2b brain summary", () => {
  test("clean vault: prints markdown report with trust=clean", async () => {
    const r = await runCli(["brain", "summary", "--skip-dream"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: configPath },
    });
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("# Operator summary");
    expect(r.stdout).toContain("Trust: **clean**");
  });

  test("--json prints structured envelope", async () => {
    const r = await runCli(["brain", "summary", "--skip-dream", "--json"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: configPath },
    });
    expect(r.returncode).toBe(0);
    const payload = JSON.parse(r.stdout) as { trust_verdict: string };
    expect(payload.trust_verdict).toBe("clean");
  });

  test("--help prints the verb help", async () => {
    const r = await runCli(["brain", "summary", "--help"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: configPath },
    });
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("brain summary");
    expect(r.stdout).toContain("--skip-dream");
  });

  test("rejects --top-actions=-1", async () => {
    const r = await runCli(["brain", "summary", "--skip-dream", "--top-actions", "-1"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: configPath },
    });
    expect(r.returncode).toBe(1);
  });
});
