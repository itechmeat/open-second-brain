/**
 * Unit tests for the sub-modules extracted from dream.ts:
 * confidence computation, reconcile outcomes, and the apply-evidence
 * refresh scanner. Behavior is pinned by the existing dream suite;
 * these cases exercise each module in isolation.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BAND_RANK,
  computeConfidence,
  rebandConfidence,
} from "../../../src/core/brain/confidence.ts";
import { buildReconcileOutcomes } from "../../../src/core/brain/reconcile-outcomes.ts";
import { emptyPlan, filterWithinWindow } from "../../../src/core/brain/dream-plan.ts";
import { scanApplyEvidence } from "../../../src/core/brain/dream-refresh.ts";
import { DEFAULT_BRAIN_CONFIG } from "../../../src/core/brain/policy.ts";
import { appendLogEvent } from "../../../src/core/brain/log.ts";
import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";

const NOW = new Date("2026-06-09T12:00:00Z");

describe("confidence module", () => {
  test("computeConfidence returns zero value and low band without evidence", () => {
    const r = computeConfidence(0, 0, null, DEFAULT_BRAIN_CONFIG, NOW);
    expect(r.value).toBe(0);
    expect(r.band).toBe("low");
  });

  test("computeConfidence rewards fresh applied evidence", () => {
    const r = computeConfidence(10, 0, NOW.toISOString(), DEFAULT_BRAIN_CONFIG, NOW);
    expect(r.value).toBeGreaterThan(0.5);
    expect(BAND_RANK[r.band]).toBeGreaterThanOrEqual(BAND_RANK["medium"]);
  });

  test("rebandConfidence maps a raw value back onto the configured bands", () => {
    expect(rebandConfidence(0, DEFAULT_BRAIN_CONFIG).band).toBe("low");
    expect(rebandConfidence(1, DEFAULT_BRAIN_CONFIG).band).toBe("high");
  });
});

describe("dream-plan helpers", () => {
  test("filterWithinWindow keeps only signals inside the window", () => {
    const mk = (createdAt: string) => ({
      path: "/tmp/x.md",
      active: true,
      signal: { id: "sig-x", topic: "t", signal: "positive", created_at: createdAt },
    });
    const recent = mk("2026-06-08T12:00:00Z");
    const old = mk("2026-01-01T00:00:00Z");
    const filtered = filterWithinWindow(
      // Minimal structural records are enough for the window filter.
      [recent, old] as never,
      14,
      NOW,
    );
    expect(filtered).toHaveLength(1);
    expect((filtered[0] as { signal: { created_at: string } }).signal.created_at).toBe(
      "2026-06-08T12:00:00Z",
    );
  });
});

describe("buildReconcileOutcomes", () => {
  test("returns empty outcomes when the plan flags no contradictions", () => {
    const outcomes = buildReconcileOutcomes(
      { signals: [], preferences: [], retired: [], corrupted: [] },
      emptyPlan(),
      DEFAULT_BRAIN_CONFIG,
      NOW,
    );
    expect(outcomes.openQuestions).toEqual([]);
    expect(outcomes.autoResolved).toEqual([]);
  });
});

describe("scanApplyEvidence", () => {
  let vault: string;
  let configHome: string;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "o2b-refresh-vault-"));
    configHome = mkdtempSync(join(tmpdir(), "o2b-refresh-cfg-"));
    const configPath = join(configHome, "config.yaml");
    atomicWriteFileSync(configPath, `vault: ${vault}\n`);
    bootstrapBrain(vault, { configPath });
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
    rmSync(configHome, { recursive: true, force: true });
  });

  test("collects apply-evidence events and resolves merge aliases", () => {
    appendLogEvent(vault, {
      timestamp: "2026-06-09T10:00:00Z",
      agent: "tester",
      eventType: "apply-evidence",
      body: { preference: "[[pref-old-rule]]", result: "applied" },
    });
    appendLogEvent(vault, {
      timestamp: "2026-06-09T10:05:00Z",
      agent: "tester",
      eventType: "merge",
      body: { keep: "[[pref-new-rule]]", drop: "[[pref-old-rule]]" },
    });
    appendLogEvent(vault, {
      timestamp: "2026-06-09T10:10:00Z",
      agent: "tester",
      eventType: "apply-evidence",
      body: { preference: "[[pref-new-rule]]", result: "violated", outcome: "failure" },
    });

    const entries = scanApplyEvidence(vault);
    expect(entries).toHaveLength(2);
    // The merge alias folds the old slug into the surviving one.
    expect(entries.map((e) => e.pref_slug)).toEqual(["new-rule", "new-rule"]);
    expect(entries[0]?.result).toBe("applied");
    expect(entries[1]?.result).toBe("violated");
    expect(entries[1]?.outcome).toBe("failure");
  });
});
