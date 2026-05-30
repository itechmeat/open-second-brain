import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { brainDirs } from "../../src/core/brain/paths.ts";
import { runCli } from "../helpers/run-cli.ts";

let tmp: string;
let vault: string;
let configPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-brain-watchdog-"));
  vault = join(tmp, "vault");
  configPath = join(tmp, "config.yaml");
  bootstrapBrain(vault);
  writeFileSync(configPath, `vault: ${vault}\nagent_name: tester\n`);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const env = () => ({ OPEN_SECOND_BRAIN_CONFIG: configPath });

describe("o2b brain watchdog", () => {
  test("prints JSON probe report and search-index recommendation", async () => {
    const result = await runCli(["brain", "watchdog", "--json"], {
      env: env(),
    });

    expect(result.returncode).toBe(0);
    const body = JSON.parse(result.stdout);
    expect(body.report.checks).toContainEqual(
      expect.objectContaining({ name: "search-index", status: "warning" }),
    );
    expect(body.remediation_plan).toContainEqual(
      expect.objectContaining({ command: "o2b search index" }),
    );
  });

  test("--remediate applies safe directory repair", async () => {
    rmSync(brainDirs(vault).inbox, { recursive: true, force: true });

    const result = await runCli(["brain", "watchdog", "--remediate", "--json"], { env: env() });

    expect(result.returncode).toBe(0);
    expect(JSON.parse(result.stdout).applied_remediations).toContainEqual(
      expect.objectContaining({ action: "create-dir", target: "Brain/inbox" }),
    );
    expect(existsSync(brainDirs(vault).inbox)).toBe(true);
  });

  test("snapshot restore request exits 2 without --force-restore", async () => {
    const result = await runCli(["brain", "watchdog", "--restore", "run-1", "--json"], {
      env: env(),
    });

    expect(result.returncode).toBe(2);
    expect(JSON.parse(result.stdout).restore.refused).toBe(true);
  });
});
