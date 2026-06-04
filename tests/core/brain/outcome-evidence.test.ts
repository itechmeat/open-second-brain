/**
 * Outcome-tied apply-evidence (t_d478df53): an optional
 * success|failure|unknown outcome rides on apply-evidence events, and
 * the dream refresh stages an explainable regression finding with a
 * confidence penalty for preferences whose recent applied events
 * co-occur with failures - a rule that looks confirmed but is
 * actively hurting. Demotion is staged, never silent retirement;
 * absent outcomes keep every existing number byte-identical.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendApplyEvidence } from "../../../src/core/brain/apply-evidence.ts";
import { dream, OUTCOME_REGRESSION_PENALTY } from "../../../src/core/brain/dream.ts";
import { collectEvidenceForSlug } from "../../../src/core/brain/evidence.ts";
import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { readLogDay } from "../../../src/core/brain/log-jsonl.ts";
import { preferencePath } from "../../../src/core/brain/paths.ts";
import { parsePreference, writePreference } from "../../../src/core/brain/preference.ts";
import { BRAIN_CONFIDENCE, BRAIN_PREFERENCE_STATUS } from "../../../src/core/brain/types.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";

let vault: string;
let configHome: string;
let configPath: string;

const NOW = new Date("2026-06-04T20:00:00Z");

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-outcome-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-outcome-cfg-"));
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
    topic: `topic-${slug}`,
    principle: `Rule for ${slug}`,
    created_at: "2026-05-01T00:00:00Z",
    unconfirmed_until: "2026-05-08T00:00:00Z",
    status: BRAIN_PREFERENCE_STATUS.confirmed,
    evidenced_by: [`[[sig-2026-05-01-${slug}]]`],
    confirmed_at: "2026-05-02T00:00:00Z",
    applied_count: 0,
    violated_count: 0,
    last_evidence_at: null,
    confidence: BRAIN_CONFIDENCE.low,
    confidence_value: null,
    pinned: false,
  });
}

function evidence(slug: string, day: number, outcome?: "success" | "failure" | "unknown"): void {
  appendApplyEvidence(
    vault,
    {
      pref_id: `pref-${slug}`,
      artifact: `[[Brain/notes/work-${day}.md]]`,
      result: "applied",
      agent: "claude",
      ...(outcome !== undefined ? { outcome } : {}),
    },
    { now: new Date(`2026-06-0${day}T10:00:00Z`) },
  );
}

describe("appendApplyEvidence outcome field", () => {
  test("success and failure persist; unknown and absent do not", () => {
    seedPref("alpha");
    evidence("alpha", 1, "failure");
    evidence("alpha", 2, "success");
    evidence("alpha", 3, "unknown");
    evidence("alpha", 4);
    const days = ["2026-06-01", "2026-06-02", "2026-06-03", "2026-06-04"];
    const outcomes = days.map((d) => {
      const { entries } = readLogDay(vault, d);
      return entries.find((e) => e.eventType === "apply-evidence")?.body["outcome"];
    });
    expect(outcomes).toEqual(["failure", "success", undefined, undefined]);
  });

  test("an invalid outcome throws", () => {
    seedPref("beta");
    expect(() =>
      appendApplyEvidence(vault, {
        pref_id: "pref-beta",
        artifact: "[[x]]",
        result: "applied",
        agent: "claude",
        outcome: "exploded" as never,
      }),
    ).toThrow(/outcome/);
  });

  test("collectEvidenceForSlug surfaces the outcome on rows", () => {
    seedPref("gamma");
    evidence("gamma", 1, "failure");
    evidence("gamma", 2);
    const rows = collectEvidenceForSlug(vault, "gamma", { sinceIso: "" });
    expect(rows.applied.find((r) => r.outcome === "failure")).toBeDefined();
    expect(rows.applied.find((r) => r.outcome === undefined)).toBeDefined();
  });
});

describe("dream outcome regression", () => {
  test("repeated applied-with-failure stages a regression and penalizes confidence", () => {
    seedPref("hurting");
    seedPref("control");
    // Identical evidence cadence; only the outcomes differ.
    for (const day of [1, 2, 3]) {
      evidence("hurting", day, "failure");
      evidence("control", day);
    }
    const res = dream(vault, { now: NOW });
    expect(res.outcome_regressions).toHaveLength(1);
    const regression = res.outcome_regressions[0]!;
    expect(regression.id).toBe("pref-hurting");
    expect(regression.failures).toBe(3);
    expect(regression.successes).toBe(0);

    const hurting = parsePreference(preferencePath(vault, "hurting"));
    const control = parsePreference(preferencePath(vault, "control"));
    // Staged, never silently retired.
    expect(hurting.status).toBe(BRAIN_PREFERENCE_STATUS.confirmed);
    expect(hurting.confidence_value).not.toBeNull();
    expect(control.confidence_value).not.toBeNull();
    expect(hurting.confidence_value!).toBeCloseTo(
      control.confidence_value! * OUTCOME_REGRESSION_PENALTY,
      4,
    );
  });

  test("successes outweighing failures stay un-flagged", () => {
    seedPref("mixed");
    evidence("mixed", 1, "failure");
    evidence("mixed", 2, "success");
    evidence("mixed", 3, "success");
    const res = dream(vault, { now: NOW });
    expect(res.outcome_regressions).toHaveLength(0);
  });

  test("a single failure never flags", () => {
    seedPref("once");
    evidence("once", 1, "failure");
    evidence("once", 2);
    const res = dream(vault, { now: NOW });
    expect(res.outcome_regressions).toHaveLength(0);
  });

  test("outcome-free vaults keep outcome_regressions empty and rerun as no-op", () => {
    seedPref("plain");
    evidence("plain", 1);
    const first = dream(vault, { now: NOW });
    expect(first.outcome_regressions).toEqual([]);
    const rerun = dream(vault, { now: NOW });
    expect(rerun.changed).toBe(false);
    expect(rerun.outcome_regressions).toEqual([]);
  });

  test("a regression run is idempotent on rerun", () => {
    seedPref("hurting");
    for (const day of [1, 2]) evidence("hurting", day, "failure");
    dream(vault, { now: NOW });
    const rerun = dream(vault, { now: NOW });
    expect(rerun.changed).toBe(false);
  });
});
