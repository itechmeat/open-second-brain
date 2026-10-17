/**
 * Trigger scan + report adapters (Workspace Insight Suite, t_cd1fee79).
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { brainDirs } from "../../../src/core/brain/paths.ts";
import { writePreference } from "../../../src/core/brain/preference.ts";
import { BRAIN_PREFERENCE_STATUS } from "../../../src/core/brain/types.ts";
import {
  candidatesFromHealth,
  candidatesFromRetention,
} from "../../../src/core/brain/triggers/adapters.ts";
import { scanTriggers } from "../../../src/core/brain/triggers/scan.ts";
import {
  listTriggers,
  transitionTrigger,
  triggersDir,
} from "../../../src/core/brain/triggers/store.ts";
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
  batchInflation: [
    {
      ids: ["pref-c", "pref-d"],
      windowStart: "2026-05-01T00:00:00.000Z",
      windowEnd: "2026-05-01T00:10:00.000Z",
      count: 2,
      topics: ["a", "b"],
    },
  ],
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

test("candidatesFromHealth normalizes contradictions, stale claims, and batch inflation", () => {
  const candidates = candidatesFromHealth(HEALTH);
  expect(candidates).toHaveLength(3);
  const contradiction = candidates[0]!;
  expect(contradiction.kind).toBe("contradiction");
  expect(contradiction.urgency).toBe("high");
  // Cooldown key is order-independent: the pair sorts.
  expect(contradiction.cooldownKey).toBe("contradiction:pref-a:pref-b");
  expect(contradiction.sourceArtifacts).toContain("[[pref-a]]");
  const stale = candidates[1]!;
  expect(stale.kind).toBe("stale_claim");
  expect(stale.cooldownKey).toBe("stale_claim:pref-old");
  const inflation = candidates[2]!;
  expect(inflation.kind).toBe("batch_inflation");
  expect(inflation.urgency).toBe("low");
  expect(inflation.cooldownKey).toBe("batch_inflation:pref-c:pref-d");
  expect(inflation.sourceArtifacts).toEqual(["[[pref-c]]", "[[pref-d]]"]);
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

// ── Defect: a reach-narrowed scan must not resurrect a batch via its key ─────
//
// The batch_inflation key named the burst's OBSERVED endpoints, so a
// scan at narrower reach - which sees a subset of the burst's records -
// shifted the key and created a second trigger for the same finding,
// resurrecting a suppressed or dismissed twin. This is the real caller
// shape: `brain_trigger operation=scan` hands scanTriggers
// `readableAtContextReachOrUndefined(ctx)`.

const DAY_MS = 24 * 3600 * 1000;
const BURST_SIZE = 6;

function confirmedBurstMember(index: number): void {
  const dirs = brainDirs(vault);
  mkdirSync(dirs.preferences, { recursive: true });
  writePreference(
    vault,
    {
      slug: `zzburst-${index}`,
      topic: `zzburst-topic-${index}`,
      principle: `Keep burst preference ${index} distinct from its siblings.`,
      created_at: "2026-05-01T00:00:00Z",
      unconfirmed_until: "2026-05-08T00:00:00Z",
      status: BRAIN_PREFERENCE_STATUS.confirmed,
      evidenced_by: [],
      confirmed_at: `2026-05-02T0${index}:00:00Z`,
      applied_count: 1,
      violated_count: 0,
      last_evidence_at: "2026-05-02T00:00:00Z",
    },
    { overwrite: true },
  );
}

test("two scans at different reach resolve one batch to one cooldown entry", () => {
  for (let i = 0; i < BURST_SIZE; i++) confirmedBurstMember(i);

  // Full reach: one batch_inflation trigger over the whole burst.
  const full = scanTriggers(vault, { now: NOW });
  expect(full.created).toHaveLength(1);
  expect(full.created[0]!.kind).toBe("batch_inflation");
  expect(full.created[0]!.cooldownKey).toBe("batch_inflation:pref-zzburst-0:pref-zzburst-5");
  transitionTrigger(vault, full.created[0]!.id, "suppress", { now: NOW });

  // Narrowed reach: the earliest burst member is withheld. The narrowed
  // detector still sees a burst (5 >= minBurstSize 5), its endpoints
  // shifted - and the scan must resolve the sighting to the persisted
  // twin instead of resurrecting the finding under a new key.
  const narrowed = scanTriggers(vault, {
    now: new Date(NOW.getTime() + DAY_MS),
    readable: (rel) => !rel.includes("pref-zzburst-0.md"),
  });
  expect(narrowed.created).toHaveLength(0);
  expect(narrowed.skipped.map((s) => s.reason)).toEqual(["suppressed"]);
  expect(narrowed.skipped[0]!.cooldownKey).toBe("batch_inflation:pref-zzburst-0:pref-zzburst-5");
  // One cooldown entry: exactly one trigger file - the suppressed twin.
  expect(readdirSync(triggersDir(vault))).toHaveLength(1);
});

test("a narrowed first scan still writes the narrowed batch when no twin exists", () => {
  // Reach-stability must not silence a FIRST sighting: a narrowed scan
  // over a vault whose twin is absent writes the finding it observed,
  // grounded in the records it may read.
  for (let i = 0; i < BURST_SIZE; i++) confirmedBurstMember(i);
  const narrowed = scanTriggers(vault, {
    now: NOW,
    readable: (rel) => !rel.includes("pref-zzburst-0.md"),
  });
  expect(narrowed.created).toHaveLength(1);
  expect(narrowed.created[0]!.kind).toBe("batch_inflation");
});
