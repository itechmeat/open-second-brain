/**
 * `o2b brain vitals` CLI surface: aggregate governance scorecard over
 * confirmed `Brain/preferences/` (domain diversity, connectivity
 * index, orphan preferences, gap pressure), plus the recorded
 * `vault_vitals` metric.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { writePreference } from "../../src/core/brain/preference.ts";
import { listMetrics } from "../../src/core/brain/metrics.ts";
import { runCli } from "../helpers/run-cli.ts";

let vault: string;

function pref(
  slug: string,
  scope: string,
  evidencedBy: string[],
  status: "confirmed" | "unconfirmed" = "confirmed",
): void {
  writePreference(vault, {
    slug,
    topic: slug,
    principle: `principle for ${slug}`,
    created_at: "2026-05-20T00:00:00Z",
    confirmed_at: status === "confirmed" ? "2026-05-21T00:00:00Z" : null,
    unconfirmed_until: "2026-06-03T00:00:00Z",
    status,
    scope,
    evidenced_by: evidencedBy,
    applied_count: evidencedBy.length,
    violated_count: 0,
    last_evidence_at: "2026-05-22T00:00:00Z",
    confidence: "low",
  });
}

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-cli-vitals-"));
  bootstrapBrain(vault);
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

test("no preferences: zeroed report, no crash", async () => {
  const r = await runCli(["brain", "vitals", "--vault", vault, "--json"]);
  expect(r.returncode).toBe(0);
  expect(JSON.parse(r.stdout)).toMatchObject({
    preferences_scanned: 0,
    domain_diversity: 0,
    connectivity_index: 0,
    gap_pressure: 0,
    orphan_preferences: [],
  });
});

test("single scope: zero diversity even with many preferences", async () => {
  pref("a", "coding", ["[[sig-1]]", "[[sig-2]]"]);
  pref("b", "coding", ["[[sig-3]]", "[[sig-4]]"]);
  const r = await runCli(["brain", "vitals", "--vault", vault, "--json"]);
  const parsed = JSON.parse(r.stdout) as { domain_diversity: number; preferences_scanned: number };
  expect(parsed.preferences_scanned).toBe(2);
  expect(parsed.domain_diversity).toBe(0);
});

test("evenly split scopes: diversity approaches 1", async () => {
  pref("a", "coding", ["[[sig-1]]", "[[sig-2]]"]);
  pref("b", "personal", ["[[sig-3]]", "[[sig-4]]"]);
  const r = await runCli(["brain", "vitals", "--vault", vault, "--json"]);
  const parsed = JSON.parse(r.stdout) as { domain_diversity: number };
  expect(parsed.domain_diversity).toBe(1);
});

test("connectivity_index averages evidenced_by length over confirmed prefs only", async () => {
  pref("a", "coding", ["[[sig-1]]", "[[sig-2]]", "[[sig-3]]"]); // 3
  pref("b", "coding", ["[[sig-4]]"]); // 1
  pref("c", "coding", ["[[sig-5]]", "[[sig-6]]"], "unconfirmed"); // excluded
  const r = await runCli(["brain", "vitals", "--vault", vault, "--json"]);
  const parsed = JSON.parse(r.stdout) as {
    connectivity_index: number;
    preferences_scanned: number;
  };
  expect(parsed.preferences_scanned).toBe(2); // unconfirmed excluded
  expect(parsed.connectivity_index).toBe(2); // (3 + 1) / 2
});

test("orphan_preferences below --orphan-threshold, default 2", async () => {
  pref("thin", "coding", ["[[sig-1]]"]); // 1 < 2 -> orphan
  pref("solid", "coding", ["[[sig-2]]", "[[sig-3]]"]); // 2 -> not orphan
  const r = await runCli(["brain", "vitals", "--vault", vault, "--json"]);
  const parsed = JSON.parse(r.stdout) as {
    orphan_preferences: Array<{ id: string; evidence_count: number }>;
  };
  expect(parsed.orphan_preferences).toHaveLength(1);
  expect(parsed.orphan_preferences[0]).toMatchObject({ id: "pref-thin", evidence_count: 1 });
});

test("--orphan-threshold overrides the default", async () => {
  pref("solid", "coding", ["[[sig-1]]", "[[sig-2]]", "[[sig-3]]"]); // 3
  const r = await runCli([
    "brain",
    "vitals",
    "--orphan-threshold",
    "4",
    "--vault",
    vault,
    "--json",
  ]);
  const parsed = JSON.parse(r.stdout) as { orphan_preferences: unknown[] };
  expect(parsed.orphan_preferences).toHaveLength(1); // 3 < 4 now counts
});

test("records one vault_vitals metric per run", async () => {
  pref("a", "coding", ["[[sig-1]]", "[[sig-2]]"]);
  await runCli(["brain", "vitals", "--vault", vault, "--json"]);
  const metrics = listMetrics(vault, { surface: "vault_vitals" });
  expect(metrics).toHaveLength(1);
  expect(metrics[0]!.payload).toMatchObject({
    preferences_scanned: 1,
    connectivity_index: 2,
  });
});

test("usage errors exit 2", async () => {
  const badThreshold = await runCli([
    "brain",
    "vitals",
    "--orphan-threshold",
    "0",
    "--vault",
    vault,
  ]);
  expect(badThreshold.returncode).toBe(2);
  const extraArg = await runCli(["brain", "vitals", "nope", "--vault", vault]);
  expect(extraArg.returncode).toBe(2);
});
