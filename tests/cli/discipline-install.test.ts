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

  test("weekly install uses weekly job name, script, and default schedule", async () => {
    const env = { OSB_HERMES_JOBS: jobsFile };

    const r = await runCli(
      [
        "discipline",
        "install",
        "--weekly",
        "--vault",
        vault,
        "--telegram-target",
        "telegram:-100123:42",
      ],
      { env },
    );

    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("created");

    const job = readJobs().jobs[0] as {
      id: string;
      name: string;
      script: string;
      schedule: { kind: string; expr: string; display: string };
    };
    expect(job.id).toMatch(/^osb-weekly-brain-digest-/);
    expect(job.name).toBe("osb-weekly-brain-digest");
    expect(job.script).toContain("--window 7d");
    expect(job.schedule.expr).toBe("59 8 * * 1");
    expect(job.schedule.display).toBe("59 8 * * 1");
  });

  test("weekly install respects --at override", async () => {
    const env = { OSB_HERMES_JOBS: jobsFile };

    const r = await runCli(
      [
        "discipline",
        "install",
        "--weekly",
        "--at",
        "0 9 * * 1",
        "--vault",
        vault,
        "--telegram-target",
        "telegram:-100123:42",
      ],
      { env },
    );

    expect(r.returncode).toBe(0);

    const job = readJobs().jobs[0] as {
      schedule: { expr: string; display: string };
    };
    expect(job.schedule.expr).toBe("0 9 * * 1");
    expect(job.schedule.display).toBe("0 9 * * 1");
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

  test("uninstall --weekly removes only the weekly job", async () => {
    const env = { OSB_HERMES_JOBS: jobsFile };

    await runCli(
      ["discipline", "install", "--vault", vault, "--telegram-target", "telegram:-100123:42"],
      { env },
    );
    await runCli(
      ["discipline", "install", "--weekly", "--vault", vault, "--telegram-target", "telegram:-100123:42"],
      { env },
    );
    expect(readJobs().jobs.length).toBe(2);

    const r = await runCli(
      ["discipline", "uninstall", "--vault", vault, "--weekly"],
      { env },
    );
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("removed");
    expect(readJobs().jobs.length).toBe(1);
    expect(readJobs().jobs[0]).toMatchObject({ name: "osb-discipline-report" });
  });

  test("uninstall without --weekly removes both jobs", async () => {
    const env = { OSB_HERMES_JOBS: jobsFile };

    await runCli(
      ["discipline", "install", "--vault", vault, "--telegram-target", "telegram:-100123:42"],
      { env },
    );
    await runCli(
      ["discipline", "install", "--weekly", "--vault", vault, "--telegram-target", "telegram:-100123:42"],
      { env },
    );
    expect(readJobs().jobs.length).toBe(2);

    const r = await runCli(
      ["discipline", "uninstall", "--vault", vault],
      { env },
    );
    expect(r.returncode).toBe(0);
    expect(readJobs().jobs.length).toBe(0);
  });
});
