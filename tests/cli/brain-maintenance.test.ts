/**
 * `o2b brain maintenance` CLI surface (t_166d1226): run executes
 * dream + reindex under the lease (exit 0 even on a gate skip - cron
 * must not alarm on a quiet hour), status renders lease + journal.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { MAINTENANCE_EXIT } from "../../src/cli/brain/verbs/maintenance.ts";
import { MAINTENANCE_FAILURE_STREAK_LIMIT_DEFAULT } from "../../src/core/brain/policy/blocks/maintenance.ts";
import { runCli } from "../helpers/run-cli.ts";

let tmp: string;
let vault: string;
let configPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-cli-maint-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  configPath = join(tmp, "config.yaml");
  writeFileSync(configPath, `vault: ${vault}\n`);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

test("run executes dream and reindex; status shows the journal", async () => {
  const init = await runCli(["brain", "init", "--vault", vault], {
    env: { OPEN_SECOND_BRAIN_CONFIG: configPath },
  });
  expect(init.returncode).toBe(0);

  const run = await runCli(["brain", "maintenance", "run", "--vault", vault, "--json"], {
    env: { OPEN_SECOND_BRAIN_CONFIG: configPath },
  });
  expect(run.returncode).toBe(0);
  const ran = JSON.parse(run.stdout) as {
    verdict: string;
    tasks: Array<{ name: string; ok: boolean }>;
  };
  expect(ran.verdict).toBe("run");
  expect(ran.tasks.map((t) => t.name).toSorted()).toEqual([
    "bridges",
    "clusters",
    "dream",
    "reindex",
  ]);
  expect(ran.tasks.every((t) => t.ok)).toBe(true);
  expect(existsSync(join(vault, ".open-second-brain", "maintenance-runs.jsonl"))).toBe(true);

  const status = await runCli(["brain", "maintenance", "status", "--vault", vault, "--json"], {
    env: { OPEN_SECOND_BRAIN_CONFIG: configPath },
  });
  expect(status.returncode).toBe(0);
  const state = JSON.parse(status.stdout) as {
    lease: unknown;
    journal: Array<{ verdict: string }>;
  };
  expect(state.lease).toBeNull();
  expect(state.journal.length).toBeGreaterThanOrEqual(2);
});

test("a window that excludes the current hour skips with exit 0", async () => {
  const init = await runCli(["brain", "init", "--vault", vault], {
    env: { OPEN_SECOND_BRAIN_CONFIG: configPath },
  });
  expect(init.returncode).toBe(0);
  // A degenerate 1-hour window that the current hour cannot match:
  // pick the hour after next in UTC, exclusive end one hour later.
  const hour = (new Date().getUTCHours() + 2) % 24;
  const end = (hour + 1) % 24;
  const run = await runCli(
    ["brain", "maintenance", "run", "--window", `${hour}-${end}`, "--vault", vault, "--json"],
    { env: { OPEN_SECOND_BRAIN_CONFIG: configPath } },
  );
  expect(run.returncode).toBe(0);
  expect(JSON.parse(run.stdout).verdict).toBe("skipped:window");
});

test("a malformed window is a usage error", async () => {
  const result = await runCli(
    ["brain", "maintenance", "run", "--window", "25-3", "--vault", vault],
    { env: { OPEN_SECOND_BRAIN_CONFIG: configPath } },
  );
  expect(result.returncode).toBe(2);
});

/** Seed `task`'s journal with the failures that trip the streak refusal. */
function seedFailureStreak(task: string, count: number): void {
  const path = join(vault, ".open-second-brain", "maintenance-runs.jsonl");
  mkdirSync(dirname(path), { recursive: true });
  for (let i = 0; i < count; i++) {
    appendFileSync(
      path,
      JSON.stringify({
        ts: new Date(Date.now() - (count - i) * 86_400_000).toISOString(),
        holder: `seed@${i}`,
        verdict: "run",
        task,
        ok: false,
        duration_ms: 1,
        error: "seeded failure",
      }) + "\n",
    );
  }
}

test("a refused task is reported as refused, with its own exit code", async () => {
  const init = await runCli(["brain", "init", "--vault", vault], {
    env: { OPEN_SECOND_BRAIN_CONFIG: configPath },
  });
  expect(init.returncode).toBe(0);
  seedFailureStreak("dream", MAINTENANCE_FAILURE_STREAK_LIMIT_DEFAULT);

  const run = await runCli(["brain", "maintenance", "run", "--vault", vault], {
    env: { OPEN_SECOND_BRAIN_CONFIG: configPath },
  });
  // Not 1: nothing was attempted, so nothing failed - and not 0, because
  // a heavy pass is standing refused and only an operator can change that.
  expect(run.returncode).toBe(MAINTENANCE_EXIT.refused);
  expect(run.stdout).toContain("dream: REFUSED");
  expect(run.stdout).not.toContain("dream: FAILED");
  // The healthy tasks still ran under the same lease.
  expect(run.stdout).toContain("reindex: ok");
});

test("--retry runs the refused task and names an unknown task as a usage error", async () => {
  const init = await runCli(["brain", "init", "--vault", vault], {
    env: { OPEN_SECOND_BRAIN_CONFIG: configPath },
  });
  expect(init.returncode).toBe(0);
  seedFailureStreak("dream", MAINTENANCE_FAILURE_STREAK_LIMIT_DEFAULT);

  const typo = await runCli(
    ["brain", "maintenance", "run", "--retry", "dreams", "--vault", vault],
    { env: { OPEN_SECOND_BRAIN_CONFIG: configPath } },
  );
  expect(typo.returncode).toBe(MAINTENANCE_EXIT.usage);
  expect(typo.stderr).toContain("dreams");

  const retried = await runCli(
    ["brain", "maintenance", "run", "--retry", "dream", "--vault", vault, "--json"],
    { env: { OPEN_SECOND_BRAIN_CONFIG: configPath } },
  );
  expect(retried.returncode).toBe(MAINTENANCE_EXIT.ok);
  const payload = JSON.parse(retried.stdout) as {
    tasks: Array<{ name: string; ok: boolean; refused?: boolean }>;
  };
  const dream = payload.tasks.find((t) => t.name === "dream");
  expect(dream?.refused).toBeUndefined();
  expect(dream?.ok).toBe(true);
});
