/**
 * `o2b search status` shows freshen on read: the interval (or off), how
 * old the index is, what the last background run did, and an active
 * backoff - in the human output and under `freshen` in `--json`. Beside
 * the age it reports the live measured behind count (t_e4438152):
 * documents the next incremental run would pick up, or "(not measured)"
 * when the walk could not run.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  EMPTY_FRESHEN_STATE,
  renderFreshenStatus,
  serializeFreshenStatus,
  writeFreshenState,
  type FreshenStatus,
} from "../../src/core/search/freshen.ts";
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
  expect(out.stdout).toContain("index_behind:        0 docs");
  expect(out.stdout).toContain("last_freshen:        (none)");
  expect(out.stdout).not.toContain("freshen_backoff");
});

test("a measured behind count is serialized as a number, an unmeasured one as null", () => {
  const measured: FreshenStatus = {
    intervalSeconds: 60,
    indexAgeSeconds: 5,
    state: EMPTY_FRESHEN_STATE,
    activeBackoffUntil: null,
    indexBehind: 12,
  };
  expect(renderFreshenStatus(measured)).toContain("index_behind:        12 docs");
  expect(serializeFreshenStatus(measured)["index_behind"]).toBe(12);

  const unmeasured: FreshenStatus = { ...measured, indexBehind: null };
  expect(renderFreshenStatus(unmeasured)).toContain("index_behind:        (not measured)");
  expect(serializeFreshenStatus(unmeasured)["index_behind"]).toBeNull();
});

test("status counts documents the index has not caught up with", async () => {
  writeFileSync(join(vault, "notes", "b.md"), "# B\n\nbrand new body\n");
  const out = await runCli(["search", "status"], { env: env("60") });
  expect(out.stdout).toContain("index_behind:        1 doc");
  const json = JSON.parse(
    (await runCli(["search", "status", "--json"], { env: env("60") })).stdout,
  );
  expect(json.freshen.index_behind).toBe(1);
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
  const lines = out.stdout
    .split("\n")
    .filter((l) => /^(freshen|index_age|index_behind|last_freshen)/.test(l));
  expect(lines).toHaveLength(5);
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
