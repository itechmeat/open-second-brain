/**
 * CLI smoke tests for `o2b brain health-baseline` - the acknowledge-before
 * watermark setter over `health.silence_before` in `_brain.yaml`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../helpers/run-cli.ts";
import { loadBrainConfig, resolveHealth } from "../../src/core/brain/policy.ts";
import { writePreference } from "../../src/core/brain/preference.ts";
import { BRAIN_PREFERENCE_STATUS } from "../../src/core/brain/types.ts";

let tmp: string;
let vault: string;
let configPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-health-baseline-cli-"));
  vault = join(tmp, "vault");
  for (const d of ["preferences", "retired", "inbox", "processed", "log"]) {
    mkdirSync(join(vault, "Brain", d), { recursive: true });
  }
  writeFileSync(
    join(vault, "Brain", "_brain.yaml"),
    "schema_version: 1\n\nhealth:\n  concept_gap_min_frequency: 3\n",
  );
  configPath = join(tmp, "config.yaml");
  writeFileSync(configPath, `vault: ${vault}\nagent_name: test\n`);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const env = () => ({ OPEN_SECOND_BRAIN_CONFIG: configPath });

describe("o2b brain health-baseline", () => {
  test("get on a fresh vault reports no baseline", async () => {
    const r = await runCli(["brain", "health-baseline", "get"], { env: env() });
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("no health baseline set");
  });

  test("set records the value and preserves the sibling health key", async () => {
    const set = await runCli(["brain", "health-baseline", "set", "2026-01-01"], { env: env() });
    expect(set.returncode).toBe(0);

    const get = await runCli(["brain", "health-baseline", "get"], { env: env() });
    expect(get.stdout).toContain("2026-01-01");

    // The written config still parses and keeps the neighbouring knob.
    const resolved = resolveHealth(loadBrainConfig(vault));
    expect(resolved.silence_before).toBe("2026-01-01");
    expect(resolved.concept_gap_min_frequency).toBe(3);
  });

  test("set now stores a full ISO timestamp", async () => {
    const set = await runCli(["brain", "health-baseline", "set", "now"], { env: env() });
    expect(set.returncode).toBe(0);
    const resolved = resolveHealth(loadBrainConfig(vault));
    expect(resolved.silence_before).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("clear removes the watermark", async () => {
    await runCli(["brain", "health-baseline", "set", "2026-01-01"], { env: env() });
    const clear = await runCli(["brain", "health-baseline", "clear"], { env: env() });
    expect(clear.returncode).toBe(0);
    expect(resolveHealth(loadBrainConfig(vault)).silence_before).toBeNull();
    // The other health key must survive the clear.
    expect(resolveHealth(loadBrainConfig(vault)).concept_gap_min_frequency).toBe(3);
  });

  test("an invalid date is a usage error (exit 2), no write", async () => {
    const r = await runCli(["brain", "health-baseline", "set", "2026-13-99"], { env: env() });
    expect(r.returncode).toBe(2);
    expect(resolveHealth(loadBrainConfig(vault)).silence_before).toBeNull();
  });

  test("--json set emits the baseline", async () => {
    const r = await runCli(["brain", "health-baseline", "set", "2026-01-01", "--json"], {
      env: env(),
    });
    expect(r.returncode).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ ok: true, baseline: "2026-01-01" });
  });

  test("the watermark suppresses an old batch-inflation burst in brain health", async () => {
    for (let i = 0; i < 6; i++) {
      writePreference(
        vault,
        {
          slug: `batch-${i}`,
          topic: `topic-${i}`,
          principle: `rule number ${i} for the batch`,
          created_at: "2026-01-01T00:00:00Z",
          unconfirmed_until: "2026-01-08T00:00:00Z",
          confirmed_at: "2026-01-01T00:00:00Z",
          status: BRAIN_PREFERENCE_STATUS.confirmed,
          evidenced_by: [],
          content_hash: "0".repeat(64),
        },
        { overwrite: true },
      );
    }

    const before = await runCli(["brain", "health"], { env: env() });
    expect(before.stdout).toContain("batch-inflation");

    await runCli(["brain", "health-baseline", "set", "2026-06-01"], { env: env() });

    const after = await runCli(["brain", "health"], { env: env() });
    expect(after.stdout).not.toContain("[batch-inflation]");
    expect(after.stdout).toContain("suppressed:");
    expect(after.stdout).toContain("baseline 2026-06-01");
    // A file on disk was left untouched by the surfacing filter.
    expect(readFileSync(join(vault, "Brain", "preferences", "pref-batch-0.md"), "utf8")).toContain(
      "rule number 0",
    );
  });
});
