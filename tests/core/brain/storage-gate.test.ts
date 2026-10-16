/**
 * The capacity gate decision (`evaluateCapacityGate`).
 *
 * Claims pinned here:
 *
 *   1. The decision is computed from a FRESH `measureStorageUsage` call
 *      at decision time, never from the stored aggregate: mutating the
 *      vault between `sampleStorageUsage` and the decision changes the
 *      answer, in both directions.
 *   2. An unbounded store never skips and never measures; an
 *      unmeasurable store never skips and names the refused surfaces.
 *   3. Only the critical tier skips; warn and ok run, with the tier and
 *      reading attached either way.
 *   4. The gate reads its bounds through the resolved `storage:` config,
 *      so an operator cap is the only thing that can close it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { brainConfigPath } from "../../../src/core/brain/paths.ts";
import {
  STORAGE_FORECAST_TIER,
  sampleStorageUsage,
} from "../../../src/core/brain/storage/forecast.ts";
import { evaluateCapacityGate } from "../../../src/core/brain/storage/gate.ts";
import { measureStorageUsage } from "../../../src/core/brain/storage/usage.ts";
import { resolveStorage } from "../../../src/core/brain/policy.ts";
import { loadBrainConfig } from "../../../src/core/brain/policy.ts";
import { CHMOD_CANNOT_DENY } from "../../helpers/platform.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-storage-gate-"));
  bootstrapBrain(vault, {});
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

/** Append a storage block to the bootstrapped config. */
function configureCap(capBytes: number): void {
  appendFileSync(brainConfigPath(vault), `\nstorage:\n  cap_bytes: ${capBytes}\n`);
}

function resolvedCap(): number | null {
  return resolveStorage(loadBrainConfig(vault)).cap_bytes;
}

function writePages(name: string, totalBytes: number): void {
  mkdirSync(join(vault, "Brain", "sources"), { recursive: true });
  writeFileSync(join(vault, "Brain", "sources", name), "x".repeat(totalBytes), "utf8");
}

describe("evaluateCapacityGate", () => {
  test("an unbounded store runs without measuring", () => {
    const decision = evaluateCapacityGate(vault, { capBytes: resolvedCap() });
    expect(decision.decision).toBe("run");
    expect(decision.tier).toBe(STORAGE_FORECAST_TIER.unbounded);
    // No cap, no reading: the measurement was never taken.
    expect(decision.reading).toBeUndefined();
  });

  test("a bounded store far below the cap runs with its reading attached", () => {
    configureCap(10_000_000);
    writePages("AA-small.md", 100);
    const decision = evaluateCapacityGate(vault, { capBytes: resolvedCap() });
    expect(decision.decision).toBe("run");
    expect(decision.tier).toBe(STORAGE_FORECAST_TIER.ok);
    expect(decision.reading).toBeDefined();
    expect(decision.reading!.measuredBytes).toBe(measureStorageUsage(vault).totalBytes);
    expect(decision.reading!.percentUsed).toBeLessThan(1);
  });

  test("a store past the critical percent skips", () => {
    configureCap(1000);
    writePages("AA-big.md", 5000);
    const decision = evaluateCapacityGate(vault, { capBytes: resolvedCap() });
    expect(decision.decision).toBe("skip");
    expect(decision.tier).toBe(STORAGE_FORECAST_TIER.critical);
    expect(decision.reading!.percentUsed).toBeGreaterThan(95);
  });

  test("only the critical tier skips; the warn band runs", () => {
    // The bootstrapped skeleton lands inside the warn band of a 30 KB
    // cap: past 80 percent, short of 95.
    configureCap(30_000);
    const decision = evaluateCapacityGate(vault, { capBytes: resolvedCap() });
    expect(decision.tier).toBe(STORAGE_FORECAST_TIER.warn);
    expect(decision.decision).toBe("run");
  });

  test("the decision re-measures: the stored aggregate never decides", () => {
    // The bootstrapped skeleton sits near 30 KB, so 100 KB keeps the
    // base vault below every band while a grown page blows past it.
    const CAP = 100_000;
    configureCap(CAP);
    // Sample the small vault, then push it past the cap: the decision
    // must reflect the fresh bytes, not the sampled aggregate.
    sampleStorageUsage(vault, { runId: "before" });
    writePages("AA-grown.md", 150_000);
    const after = evaluateCapacityGate(vault, { capBytes: resolvedCap() });
    expect(after.decision).toBe("skip");
    expect(after.tier).toBe(STORAGE_FORECAST_TIER.critical);

    // And the other direction: a sampled-heavy vault that has been
    // emptied runs again.
    const heavy = mkdtempSync(join(tmpdir(), "o2b-storage-gate-heavy-"));
    try {
      bootstrapBrain(heavy, {});
      appendFileSync(brainConfigPath(heavy), `\nstorage:\n  cap_bytes: ${CAP}\n`);
      mkdirSync(join(heavy, "Brain", "sources"), { recursive: true });
      writeFileSync(join(heavy, "Brain", "sources", "AA-big.md"), "x".repeat(150_000), "utf8");
      sampleStorageUsage(heavy, { runId: "heavy" });
      rmSync(join(heavy, "Brain", "sources", "AA-big.md"));
      const emptied = evaluateCapacityGate(heavy, { capBytes: CAP });
      expect(emptied.decision).toBe("run");
    } finally {
      rmSync(heavy, { recursive: true, force: true });
    }
  });

  test.skipIf(CHMOD_CANNOT_DENY)(
    "an unmeasurable store never skips and names the refused surface",
    () => {
      configureCap(1000);
      mkdirSync(join(vault, "Brain", ".artifacts"), { recursive: true });
      chmodSync(join(vault, "Brain", ".artifacts"), 0o000);
      try {
        const decision = evaluateCapacityGate(vault, { capBytes: resolvedCap() });
        expect(decision.decision).toBe("run");
        expect(decision.tier).toBe(STORAGE_FORECAST_TIER.unmeasurable);
        expect(decision.reason).toContain("artifacts");
        // A refusal carries no percent: there is no number to attach.
        expect(decision.reading).toBeUndefined();
      } finally {
        chmodSync(join(vault, "Brain", ".artifacts"), 0o755);
      }
    },
  );

  test("threshold overrides move the skip line", () => {
    configureCap(1_000_000);
    writePages("AA-small.md", 100);
    const run = evaluateCapacityGate(vault, { capBytes: resolvedCap() });
    expect(run.decision).toBe("run");
    const skipped = evaluateCapacityGate(vault, {
      capBytes: resolvedCap(),
      criticalPercent: 1,
    });
    expect(skipped.decision).toBe("skip");
    expect(skipped.tier).toBe(STORAGE_FORECAST_TIER.critical);
  });

  test("a pausePercent passed in closes the gate one band before the refuse line", () => {
    // The bootstrapped skeleton sits in the warn band of a 30 KB cap.
    // Without a pause line the gate RUNS there (the interactive wall's
    // posture, pinned above); the lane hands its pause_percent in, and
    // the same reading then skips - background work backs off before
    // the wall, interactive ingest still works.
    configureCap(30_000);
    const decision = evaluateCapacityGate(vault, {
      capBytes: resolvedCap(),
      pausePercent: 80,
    });
    expect(decision.tier).toBe(STORAGE_FORECAST_TIER.warn);
    expect(decision.decision).toBe("skip");
    // The line rides the decision, so a report can show how far the
    // vault was from the pause.
    expect(decision.pausePercent).toBe(80);
  });

  test("a pausePercent below the tier line pauses an ok vault", () => {
    configureCap(1_000_000);
    writePages("AA-small.md", 100);
    const decision = evaluateCapacityGate(vault, {
      capBytes: resolvedCap(),
      pausePercent: 1,
    });
    expect(decision.tier).toBe(STORAGE_FORECAST_TIER.ok);
    expect(decision.decision).toBe("skip");
  });

  test("a pausePercent above the measured percent leaves the gate open", () => {
    configureCap(10_000_000);
    const decision = evaluateCapacityGate(vault, {
      capBytes: resolvedCap(),
      pausePercent: 50,
    });
    expect(decision.decision).toBe("run");
    expect(decision.pausePercent).toBe(50);
  });
});
