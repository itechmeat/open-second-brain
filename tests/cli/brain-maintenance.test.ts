/**
 * `o2b brain maintenance` CLI surface (t_166d1226): run executes
 * dream + reindex under the lease (exit 0 even on a gate skip - cron
 * must not alarm on a quiet hour), status renders lease + journal.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
