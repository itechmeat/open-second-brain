/**
 * Trigger scan + report adapters (Workspace Insight Suite, t_cd1fee79).
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  candidatesFromHealth,
  candidatesFromRetention,
} from "../../../src/core/brain/triggers/adapters.ts";
import { scanTriggers } from "../../../src/core/brain/triggers/scan.ts";
import { listTriggers } from "../../../src/core/brain/triggers/store.ts";
import type { SemanticHealthReport } from "../../../src/core/brain/health/reconcile.ts";
import type { RetentionReviewReport } from "../../../src/core/brain/retention.ts";

const NOW = new Date("2026-06-03T10:00:00Z");

const HEALTH: SemanticHealthReport = {
  verdict: "investigate",
  contradictions: [
    {
      aId: "pref-b",
      bId: "pref-a",
      scope: "writing",
      jaccard: 0.8,
      aSign: "positive",
      bSign: "negative",
    },
  ],
  conceptGaps: [],
  staleClaims: [{ id: "pref-old", lastEvidenceAt: "2026-01-01T00:00:00Z", ageDays: 120 }],
};

const RETENTION: RetentionReviewReport = {
  schema_version: 1,
  generated_at: NOW.toISOString(),
  summary: { keep: 1, improve: 0, park: 1, prune: 1 },
  recommendations: [
    {
      id: "pref-keep",
      artifact_type: "retired_preference",
      action: "keep",
      reason: "active",
      path: "a.md",
    },
    {
      id: "pref-park",
      artifact_type: "retired_preference",
      action: "park",
      reason: "old retired",
      path: "b.md",
    },
    {
      id: "sig-prune",
      artifact_type: "processed_signal",
      action: "prune",
      reason: "processed long ago",
      path: "c.md",
    },
  ],
};

test("candidatesFromHealth normalizes contradictions and stale claims", () => {
  const candidates = candidatesFromHealth(HEALTH);
  expect(candidates).toHaveLength(2);
  const contradiction = candidates[0]!;
  expect(contradiction.kind).toBe("contradiction");
  expect(contradiction.urgency).toBe("high");
  // Cooldown key is order-independent: the pair sorts.
  expect(contradiction.cooldownKey).toBe("contradiction:pref-a:pref-b");
  expect(contradiction.sourceArtifacts).toContain("[[pref-a]]");
  const stale = candidates[1]!;
  expect(stale.kind).toBe("stale_claim");
  expect(stale.cooldownKey).toBe("stale_claim:pref-old");
});

test("candidatesFromRetention keeps only park and prune actions", () => {
  const candidates = candidatesFromRetention(RETENTION);
  expect(candidates).toHaveLength(2);
  expect(candidates.map((c) => c.cooldownKey)).toEqual([
    "retention_action:pref-park:park",
    "retention_action:sig-prune:prune",
  ]);
  expect(candidates[1]!.urgency).toBe("medium");
});

// ── scanTriggers over a real (empty) vault ──────────────────────────────────

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-trigger-scan-"));
  mkdirSync(join(vault, "Brain"), { recursive: true });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

test("scanTriggers is fail-soft on a bare vault and persists extra candidates", () => {
  const result = scanTriggers(vault, {
    now: NOW,
    extraCandidates: candidatesFromHealth(HEALTH),
  });
  expect(result.created.length).toBeGreaterThanOrEqual(2);
  expect(listTriggers(vault, { now: NOW }).length).toBe(result.created.length);

  // Re-run: idempotent, everything active.
  const again = scanTriggers(vault, { now: NOW, extraCandidates: candidatesFromHealth(HEALTH) });
  expect(again.created).toHaveLength(0);
});
