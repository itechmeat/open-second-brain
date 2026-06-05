/**
 * Dual-output wiring (t_00eece5d): with `report_snapshots_enabled`,
 * the digest / daily / weekly surfaces persist one snapshot per run
 * under `Brain/reports/<surface>/` and report a "Since last run"
 * delta on subsequent runs - in both JSON (`delta` field) and human
 * output. A vault without the flag renders byte-identically and
 * writes nothing.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { writeSignal } from "../../src/core/brain/signal.ts";
import { runCli } from "../helpers/run-cli.ts";

let tmp: string;
let vault: string;
let configPath: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-cli-report-delta-"));
  vault = join(tmp, "vault");
  configPath = join(tmp, "config.yaml");
  for (const key of ["OPEN_SECOND_BRAIN_CONFIG", "OPEN_SECOND_BRAIN_REPORT_SNAPSHOTS"]) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  writeFileSync(
    configPath,
    `vault: ${vault}\nagent_name: claude\nreport_snapshots_enabled: true\n`,
  );
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const env = () => ({ OPEN_SECOND_BRAIN_CONFIG: configPath });

test("daily brief: first run no delta, second run reports the change", async () => {
  const first = await runCli(
    ["brain", "daily", "--date", "2026-06-04", "--vault", vault, "--json"],
    { env: env() },
  );
  expect(first.returncode).toBe(0);
  const firstParsed = JSON.parse(first.stdout) as { delta: { prior_date: string | null } };
  expect(firstParsed.delta.prior_date).toBeNull();
  expect(existsSync(join(vault, "Brain", "reports", "daily", "2026-06-04.json"))).toBe(true);

  // A new signal shifts the daily counters for the later date.
  writeSignal(vault, {
    topic: "delta-topic",
    signal: "positive",
    agent: "claude",
    principle: "Rule for delta-topic.",
    created_at: "2026-06-05T09:00:00Z",
    date: "2026-06-05",
    slug: "delta-1",
    scope: "writing",
  });
  const second = await runCli(
    ["brain", "daily", "--date", "2026-06-05", "--vault", vault, "--json"],
    { env: env() },
  );
  const secondParsed = JSON.parse(second.stdout) as {
    delta: { prior_date: string | null; changed: Array<{ path: string }> };
  };
  expect(secondParsed.delta.prior_date).toBe("2026-06-04");
  expect(secondParsed.delta.changed.length).toBeGreaterThan(0);
});

test("weekly and digest surfaces persist snapshots under Brain/reports/", async () => {
  const weekly = await runCli(
    ["brain", "weekly", "--week-end", "2026-06-05", "--vault", vault, "--json"],
    { env: env() },
  );
  expect(weekly.returncode).toBe(0);
  expect((JSON.parse(weekly.stdout) as { delta: unknown }).delta).toBeDefined();
  expect(existsSync(join(vault, "Brain", "reports", "weekly", "2026-06-05.json"))).toBe(true);

  const digest = await runCli(["brain", "digest", "--vault", vault, "--json"], { env: env() });
  expect(digest.returncode).toBe(0);
  expect((JSON.parse(digest.stdout) as { delta: unknown }).delta).toBeDefined();
  expect(existsSync(join(vault, "Brain", "reports", "digest"))).toBe(true);
});

test("human output renders a Since-last-run block", async () => {
  await runCli(["brain", "daily", "--date", "2026-06-04", "--vault", vault], { env: env() });
  const second = await runCli(["brain", "daily", "--date", "2026-06-05", "--vault", vault], {
    env: env(),
  });
  expect(second.stdout).toContain("Since last run");
});

test("disabled vault writes nothing and emits no delta", async () => {
  writeFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  const r = await runCli(["brain", "daily", "--date", "2026-06-04", "--vault", vault, "--json"], {
    env: env(),
  });
  expect(r.returncode).toBe(0);
  expect((JSON.parse(r.stdout) as Record<string, unknown>)["delta"]).toBeUndefined();
  expect(existsSync(join(vault, "Brain", "reports"))).toBe(false);
});
