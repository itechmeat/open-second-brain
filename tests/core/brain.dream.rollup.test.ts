/**
 * Count-triggered fact rollup ladder in the dream synthesize phase
 * (S3, t_c5263e27): below threshold the dream output stays byte-identical
 * (no ledger, no rollup in the report or log); at threshold one rollup
 * envelope fires, the counter reset lands in the report, and a rerun does
 * not re-fire.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dream } from "../../src/core/brain/dream.ts";
import { writePreference } from "../../src/core/brain/preference.ts";
import { writeSignal } from "../../src/core/brain/signal.ts";
import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { brainConfigPath } from "../../src/core/brain/paths.ts";
import { rollupLedgerPath } from "../../src/core/brain/paths.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";

let vault: string;
let configHome: string;
let configPath: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-rollup-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-rollup-cfg-"));
  configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

function seedPref(slug: string): void {
  writePreference(vault, {
    slug,
    topic: slug,
    principle: `Rule ${slug}`,
    created_at: "2026-04-01T00:00:00Z",
    unconfirmed_until: "2026-04-15T00:00:00Z",
    status: "confirmed",
    evidenced_by: [],
    confirmed_at: "2026-04-05T00:00:00Z",
    applied_count: 3,
    violated_count: 0,
    last_evidence_at: "2026-05-10T00:00:00Z",
    confidence: "medium",
  });
}

function setRollupThreshold(fact: number): void {
  // Append a rollup block to the vault's _brain.yaml so loadBrainConfig
  // picks up the override.
  const path = brainConfigPath(vault);
  const base = readFileSync(path, "utf8");
  atomicWriteFileSync(path, `${base}\nrollup:\n  fact_threshold: ${fact}\n`);
}

test("below threshold the dream output carries no rollup and writes no ledger", () => {
  // A couple of facts, far below the default threshold.
  seedPref("alpha");
  seedPref("beta");
  // A signal cluster to force an ordinary changed run.
  for (const n of ["s1", "s2", "s3"]) {
    writeSignal(vault, {
      topic: "capture-style",
      signal: "positive",
      agent: "claude",
      principle: "Prefer terse capture",
      created_at: "2026-05-14T10:00:00Z",
      date: "2026-05-14",
      slug: n,
    });
  }
  const res = dream(vault, { now: new Date("2026-05-14T20:00:00Z") });
  expect(res.changed).toBe(true);
  expect(res.rollups).toHaveLength(0);
  expect(existsSync(rollupLedgerPath(vault))).toBe(false);
  // The dream summary event carries no rollups key.
  const log = readFileSync(join(vault, "Brain", "log", "2026-05-14.md"), "utf8");
  expect(log).not.toContain("rollups");
});

test("a no-op run stays a no-op with the ladder wired in", () => {
  const res = dream(vault, { now: new Date("2026-05-14T20:00:00Z") });
  expect(res.changed).toBe(false);
  expect(res.rollups).toHaveLength(0);
  expect(existsSync(rollupLedgerPath(vault))).toBe(false);
});

test("reaching the threshold fires one rollup envelope and records the reset", () => {
  setRollupThreshold(2);
  seedPref("alpha");
  seedPref("beta");
  const res = dream(vault, { now: new Date("2026-05-14T20:00:00Z") });
  expect(res.changed).toBe(true);
  expect(res.rollups).toHaveLength(1);
  const entry = res.rollups[0]!;
  expect(entry.tier).toBe("fact");
  expect(entry.produces).toBe("rollup");
  expect(entry.toCount).toBe(2);
  expect(entry.envelope.status).toBe("needs-llm-step");
  // Counter ledger persisted and the reset recorded in the log.
  expect(existsSync(rollupLedgerPath(vault))).toBe(true);
  const log = readFileSync(join(vault, "Brain", "log", "2026-05-14.md"), "utf8");
  expect(log).toContain("rollups");

  // Rerun: the counter is consumed, so the rollup does not re-fire.
  const again = dream(vault, { now: new Date("2026-05-15T20:00:00Z") });
  expect(again.rollups).toHaveLength(0);
});
