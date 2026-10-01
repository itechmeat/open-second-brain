/**
 * CLI tests for `o2b discipline install` / `o2b discipline uninstall` (Task 2.13).
 *
 * Sequence: install → install (idempotent) → uninstall → uninstall (no-op)
 * jobs.length transitions: 0 → 1 → 1 → 0 → 0
 *
 * OSB_HERMES_JOBS points at a tmp file so the user's real cron config
 * (~/.hermes/cron/jobs.json of whoever runs the suite) is never touched.
 * The default path itself is asserted through the pure resolver, which
 * takes the environment and the home directory as arguments.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HermesJobsPathError, resolveJobsFilePath } from "../../src/cli/discipline-install.ts";
import { runCli } from "../helpers/run-cli.ts";

const CLI_ENTRY = join(import.meta.dir, "..", "..", "src", "cli", "main.ts");
const NO_HOME_PRELOAD = join(import.meta.dir, "..", "fixtures", "discipline-install", "no-home.ts");

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
    const r3 = await runCli(["discipline", "uninstall", "--vault", vault], { env });
    expect(r3.returncode).toBe(0);
    expect(r3.stdout).toContain("removed");
    expect(readJobs().jobs.length).toBe(0);

    // 4. Uninstall again — no-op, exits 0
    const r4 = await runCli(["discipline", "uninstall", "--vault", vault], { env });
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
    const r = await runCli(["discipline", "install", "--vault", vault], { env });
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
    expect(readJobs().jobs.length).toBe(2);

    const r = await runCli(["discipline", "uninstall", "--vault", vault, "--weekly"], { env });
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
    expect(readJobs().jobs.length).toBe(2);

    const r = await runCli(["discipline", "uninstall", "--vault", vault], { env });
    expect(r.returncode).toBe(0);
    expect(readJobs().jobs.length).toBe(0);
  });
});

describe("resolveJobsFilePath", () => {
  const JOBS_TAIL = [".hermes", "cron", "jobs.json"] as const;

  test("defaults to the Hermes jobs file under the given home", () => {
    expect(resolveJobsFilePath({}, "/home/op")).toBe(join("/home/op", ...JOBS_TAIL));
    // Root hosts keep the path they always had.
    expect(resolveJobsFilePath({}, "/root")).toBe(join("/root", ...JOBS_TAIL));
  });

  test("OSB_HERMES_JOBS overrides the default, even without a home", () => {
    expect(resolveJobsFilePath({ OSB_HERMES_JOBS: "/srv/jobs.json" }, "/home/op")).toBe(
      "/srv/jobs.json",
    );
    expect(resolveJobsFilePath({ OSB_HERMES_JOBS: "/srv/jobs.json" }, "")).toBe("/srv/jobs.json");
  });

  test("an empty OSB_HERMES_JOBS is unset, not a path", () => {
    expect(resolveJobsFilePath({ OSB_HERMES_JOBS: "" }, "/home/op")).toBe(
      join("/home/op", ...JOBS_TAIL),
    );
  });

  test("no home and no override is a named error that names the way out", () => {
    let caught: unknown;
    try {
      resolveJobsFilePath({}, "");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HermesJobsPathError);
    expect((caught as Error).name).toBe("HermesJobsPathError");
    expect((caught as Error).message).toContain("OSB_HERMES_JOBS");
  });
});

describe("o2b discipline on a host without a home directory", () => {
  test("install and uninstall exit 1 naming OSB_HERMES_JOBS and write nothing", () => {
    for (const verb of [
      ["install", "--vault", vault, "--telegram-target", "telegram:-100123:42"],
      ["uninstall", "--vault", vault],
    ]) {
      const env: Record<string, string> = { PATH: process.env["PATH"] ?? "", HOME: tmp };
      if (process.env["SYSTEMROOT"]) env["SYSTEMROOT"] = process.env["SYSTEMROOT"];
      const run = Bun.spawnSync(
        [process.execPath, "--preload", NO_HOME_PRELOAD, CLI_ENTRY, "discipline", ...verb],
        { cwd: tmp, env, stdout: "pipe", stderr: "pipe" },
      );
      expect(run.stderr.toString()).toContain("cannot resolve the home directory");
      expect(run.stderr.toString()).toContain("OSB_HERMES_JOBS");
      expect(run.exitCode).toBe(1);
      expect(existsSync(join(tmp, ".hermes"))).toBe(false);
    }
  });
});
