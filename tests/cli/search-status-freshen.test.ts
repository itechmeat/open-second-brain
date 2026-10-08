/**
 * `o2b search status` shows freshen on read: the interval (or off), how
 * old the index is, what the last background run did, and an active
 * backoff - in the human output and under `freshen` in `--json`.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeFreshenState } from "../../src/core/search/freshen.ts";
import { runCli } from "../helpers/run-cli.ts";

let tmp: string;
let vault: string;
let configPath: string;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-status-freshen-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "notes"), { recursive: true });
  configPath = join(tmp, "config.yaml");
  writeFileSync(configPath, `vault: ${vault}\n`);
  writeFileSync(join(vault, "notes", "a.md"), "# A\n\nbody\n");
  await runCli(["search", "index"], { env: env("60") });
});

afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function env(interval: string): Record<string, string> {
  return {
    OPEN_SECOND_BRAIN_CONFIG: configPath,
    OPEN_SECOND_BRAIN_SEARCH_FRESHEN_INTERVAL_S: interval,
  };
}

test("status names the interval, the index age and that no background run happened yet", async () => {
  const out = await runCli(["search", "status"], { env: env("60") });
  expect(out.returncode).toBe(0);
  expect(out.stdout).toContain("freshen:             every 60s");
  expect(out.stdout).toMatch(/index_age:\s+\d+s/);
  expect(out.stdout).toContain("last_freshen:        (none)");
  expect(out.stdout).not.toContain("freshen_backoff");
});

test("an interval of 0 reads as off", async () => {
  const out = await runCli(["search", "status"], { env: env("0") });
  expect(out.stdout).toContain("freshen:             off");
});

test("a failed run shows its error and the active backoff, in text and JSON", async () => {
  const backoffUntil = new Date(Date.now() + 120_000).toISOString();
  writeFreshenState(join(vault, ".open-second-brain"), {
    failures: 2,
    backoffUntil,
    lastOutcome: "failed",
    lastRunAt: "2026-10-07T12:00:00.000Z",
    lastDurationMs: 40,
    lastError: "disk full",
    lastChanged: null,
  });
  const text = await runCli(["search", "status"], { env: env("60") });
  expect(text.stdout).toContain(
    "last_freshen:        failed 2026-10-07T12:00:00.000Z (2 in a row): disk full",
  );
  expect(text.stdout).toContain(`freshen_backoff:     until ${backoffUntil}`);

  const json = JSON.parse(
    (await runCli(["search", "status", "--json"], { env: env("60") })).stdout,
  );
  expect(json.freshen).toMatchObject({
    interval_s: 60,
    last_outcome: "failed",
    last_error: "disk full",
    failures: 2,
    backoff_until: backoffUntil,
  });
  expect(json.freshen.index_age_s).toBeGreaterThanOrEqual(0);
});

test("every freshen line keeps the 21-column value alignment of the status block", async () => {
  writeFreshenState(join(vault, ".open-second-brain"), {
    failures: 1,
    backoffUntil: new Date(Date.now() + 120_000).toISOString(),
    lastOutcome: "failed",
    lastRunAt: "2026-10-07T12:00:00.000Z",
    lastDurationMs: 40,
    lastError: "disk full",
    lastChanged: null,
  });
  const out = await runCli(["search", "status"], { env: env("60") });
  const lines = out.stdout.split("\n").filter((l) => /^(freshen|index_age|last_freshen)/.test(l));
  expect(lines).toHaveLength(4);
  for (const line of lines) {
    expect(line.slice(0, 21)).toMatch(/^[a-z_]+: +$/);
    expect(line[21]).not.toBe(" ");
  }
});

test("a completed run shows how many documents it changed", async () => {
  writeFreshenState(join(vault, ".open-second-brain"), {
    failures: 0,
    backoffUntil: null,
    lastOutcome: "completed",
    lastRunAt: "2026-10-07T12:00:00.000Z",
    lastDurationMs: 300,
    lastError: null,
    lastChanged: 3,
  });
  const out = await runCli(["search", "status"], { env: env("60") });
  expect(out.stdout).toContain(
    "last_freshen:        completed 2026-10-07T12:00:00.000Z (3 changed)",
  );
});
