/**
 * CLI tests for `o2b discipline install` / `o2b discipline uninstall` (Task 2.13).
 *
 * Sequence: install → install (idempotent) → uninstall → uninstall (no-op)
 * jobs.length transitions: 0 → 1 → 1 → 0 → 0
 *
 * OSB_HERMES_JOBS points at a tmp file so the user's real cron config
 * (/root/.hermes/cron/jobs.json) is never touched.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../helpers/run-cli.ts";

let tmp: string;
let vault: string;
let jobsFile: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-discipline-install-test-"));
  vault = join(tmp, "vault");
  jobsFile = join(tmp, "jobs.json");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function readJobs(): { jobs: unknown[] } {
  try {
    return JSON.parse(readFileSync(jobsFile, "utf8"));
  } catch {
    return { jobs: [] };
  }
}

describe("o2b discipline install / uninstall", () => {
  test("install → idempotent install → uninstall → idempotent uninstall", async () => {
    const env = { OSB_HERMES_JOBS: jobsFile };

    // 1. Install — job created
    const r1 = await runCli(
      ["discipline", "install", "--vault", vault, "--telegram-target", "telegram:-100123:42"],
      { env },
    );
    expect(r1.returncode).toBe(0);
    expect(r1.stdout).toContain("created");
    expect(readJobs().jobs.length).toBe(1);

    // 2. Install again — idempotent, job count unchanged
    const r2 = await runCli(
      ["discipline", "install", "--vault", vault, "--telegram-target", "telegram:-100123:42"],
      { env },
    );
    expect(r2.returncode).toBe(0);
    expect(r2.stdout).toContain("updated");
    expect(readJobs().jobs.length).toBe(1);

    // 3. Uninstall — job removed
    const r3 = await runCli(
      ["discipline", "uninstall", "--vault", vault],
      { env },
    );
    expect(r3.returncode).toBe(0);
    expect(r3.stdout).toContain("removed");
    expect(readJobs().jobs.length).toBe(0);

    // 4. Uninstall again — no-op, exits 0
    const r4 = await runCli(
      ["discipline", "uninstall", "--vault", vault],
      { env },
    );
    expect(r4.returncode).toBe(0);
    expect(r4.stdout).toContain("no-op");
    expect(readJobs().jobs.length).toBe(0);
  });

  test("install without --vault exits 2 with error on stderr", async () => {
    const env = { OSB_HERMES_JOBS: jobsFile };
    const r = await runCli(["discipline", "install"], { env });
    expect(r.returncode).toBe(2);
    expect(r.stderr).toContain("--vault is required");
  });

  test("install without --telegram-target exits 2 (no private chat id baked in)", async () => {
    const env = { OSB_HERMES_JOBS: jobsFile };
    const r = await runCli(
      ["discipline", "install", "--vault", vault],
      { env },
    );
    expect(r.returncode).toBe(2);
    expect(r.stderr).toContain("--telegram-target is required");
  });

  test("uninstall without --vault exits 2 with error on stderr", async () => {
    const env = { OSB_HERMES_JOBS: jobsFile };
    const r = await runCli(["discipline", "uninstall"], { env });
    expect(r.returncode).toBe(2);
    expect(r.stderr).toContain("--vault is required");
  });
});
