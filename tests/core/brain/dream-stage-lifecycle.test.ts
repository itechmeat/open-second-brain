/**
 * Staged dream pipeline, lifecycle half (t_ae8a8ec0): validate
 * recomputes the dry-run plan and compares it to the staged
 * proposals - identical means the vault has not drifted; apply
 * re-validates and then runs the SAME engine live (no second
 * promotion path), records a `dream_stage` metric, and archives the
 * bundle; a drifted bundle aborts without writes; discard removes
 * the bundle.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyDreamBundle,
  discardDreamBundle,
  listDreamBundles,
  stageDream,
  validateDreamBundle,
} from "../../../src/core/brain/dream-stage.ts";
import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { listMetrics } from "../../../src/core/brain/metrics.ts";
import { writeSignal } from "../../../src/core/brain/signal.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";

const STAGED_AT = new Date("2026-06-05T12:00:00Z");
const LATER = new Date("2026-06-05T14:00:00Z");

let tmp: string;
let vault: string;
let configPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-dream-lifecycle-"));
  vault = join(tmp, "vault");
  configPath = join(tmp, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function seedSignal(topic: string, slug: string): void {
  writeSignal(vault, {
    topic,
    signal: "positive",
    agent: "claude",
    principle: `Rule for ${topic}.`,
    created_at: "2026-06-01T10:00:00Z",
    date: "2026-06-01",
    slug,
    scope: "writing",
  });
}

describe("validateDreamBundle", () => {
  test("passes on an unchanged vault", () => {
    seedSignal("lifecycle", "lifecycle-1");
    seedSignal("lifecycle", "lifecycle-2");
    seedSignal("lifecycle", "lifecycle-3");
    const { runId } = stageDream(vault, { now: STAGED_AT });
    const verdict = validateDreamBundle(vault, runId, { now: LATER });
    expect(verdict.valid).toBe(true);
    expect(verdict.drift).toEqual([]);
  });

  test("fails with a drift report after a new signal lands", () => {
    seedSignal("lifecycle", "lifecycle-1");
    seedSignal("lifecycle", "lifecycle-2");
    seedSignal("lifecycle", "lifecycle-3");
    const { runId } = stageDream(vault, { now: STAGED_AT });
    seedSignal("newcomer", "newcomer-1");
    seedSignal("newcomer", "newcomer-2");
    seedSignal("newcomer", "newcomer-3");
    const verdict = validateDreamBundle(vault, runId, { now: LATER });
    expect(verdict.valid).toBe(false);
    expect(verdict.drift.length).toBeGreaterThan(0);
    expect(verdict.drift.join("\n")).toContain("new_unconfirmed");
  });

  test("an unknown run id reports a missing bundle", () => {
    const verdict = validateDreamBundle(vault, "stage-nope", { now: LATER });
    expect(verdict.valid).toBe(false);
    expect(verdict.drift.join("\n")).toContain("bundle");
  });
});

describe("applyDreamBundle", () => {
  test("a valid bundle applies exactly the staged plan and archives", () => {
    seedSignal("apply-topic", "apply-1");
    seedSignal("apply-topic", "apply-2");
    seedSignal("apply-topic", "apply-3");
    const { runId, plan } = stageDream(vault, { now: STAGED_AT });
    expect(plan.new_unconfirmed).toEqual(["pref-apply-topic"]);

    const outcome = applyDreamBundle(vault, runId, { now: LATER });
    expect(outcome.applied).toBe(true);
    expect(outcome.summary!.new_unconfirmed).toEqual(["pref-apply-topic"]);
    expect(existsSync(join(vault, "Brain", "preferences", "pref-apply-topic.md"))).toBe(true);

    // Bundle archived: gone from staged/, present under applied/.
    expect(existsSync(join(vault, "Brain", "dream", "staged", runId))).toBe(false);
    expect(existsSync(join(vault, "Brain", "dream", "applied", runId))).toBe(true);
    const bundles = listDreamBundles(vault);
    expect(bundles.find((b) => b.runId === runId)!.status).toBe("applied");

    // Run-level dream_stage metric recorded.
    const metrics = listMetrics(vault, { surface: "dream_stage" });
    expect(metrics.length).toBeGreaterThanOrEqual(1);
    expect(metrics[0]!.payload["action"]).toBe("apply");
  });

  test("a drifted bundle aborts without writes", () => {
    seedSignal("abort-topic", "abort-1");
    seedSignal("abort-topic", "abort-2");
    seedSignal("abort-topic", "abort-3");
    const { runId } = stageDream(vault, { now: STAGED_AT });
    seedSignal("drift-topic", "drift-1");
    seedSignal("drift-topic", "drift-2");
    seedSignal("drift-topic", "drift-3");

    const outcome = applyDreamBundle(vault, runId, { now: LATER });
    expect(outcome.applied).toBe(false);
    expect(outcome.validation.valid).toBe(false);
    // Neither the staged topic nor the drift topic got promoted.
    expect(existsSync(join(vault, "Brain", "preferences", "pref-abort-topic.md"))).toBe(false);
    expect(existsSync(join(vault, "Brain", "preferences", "pref-drift-topic.md"))).toBe(false);
    // Bundle stays staged for inspection.
    expect(existsSync(join(vault, "Brain", "dream", "staged", runId))).toBe(true);
  });
});

describe("discardDreamBundle", () => {
  test("removes a staged bundle and reports absence honestly", () => {
    seedSignal("discard-topic", "discard-1");
    seedSignal("discard-topic", "discard-2");
    seedSignal("discard-topic", "discard-3");
    const { runId } = stageDream(vault, { now: STAGED_AT });
    expect(discardDreamBundle(vault, runId)).toBe(true);
    expect(existsSync(join(vault, "Brain", "dream", "staged", runId))).toBe(false);
    expect(discardDreamBundle(vault, runId)).toBe(false);
  });
});
