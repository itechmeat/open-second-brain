/**
 * The maintenance lane's capacity gate (storage lifecycle, Lane 2): the
 * FIFTH gate, ordered after host pressure, active only when the vault's
 * `storage:` block configures `cap_bytes`.
 *
 * A critical tier skips the whole lane with its own verdict
 * (`skipped:capacity`), the reading rides the decision and the journal
 * the way the pressure reading does, an unmeasurable store leaves the
 * gate OPEN with the reason journalled (a vault that cannot be measured
 * must not look like one that paused), and `--force` bypasses it like
 * every other soft gate while the lease is never bypassed by anything.
 *
 * The usage sample is taken BEFORE the skip is returned: the forecast
 * series must keep accumulating exactly while producers are paused, so a
 * skipped run still appends its sample. A run the gate lets through
 * samples nothing here - the gate decision already measured, and a lane
 * pass that doubles every byte walk would tax every scheduled run for a
 * datum the storage report surfaces already collect.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  evaluateGates,
  runMaintenance,
  type CapacityGateDecision,
} from "../../../src/core/brain/maintenance/lane.ts";
import {
  listJournal,
  MAINTENANCE_VERDICT,
  type MaintenanceJournalEntry,
} from "../../../src/core/brain/maintenance/journal.ts";
import { acquireLease, currentLease } from "../../../src/core/brain/maintenance/lease.ts";
import {
  BRAIN_STORAGE_DEFAULTS,
  type ResolvedBrainStorageConfig,
} from "../../../src/core/brain/policy/blocks/storage.ts";
import {
  STORAGE_FORECAST_TIER,
  STORAGE_USAGE_METRIC_SURFACE,
} from "../../../src/core/brain/storage/forecast.ts";
import { listMetrics } from "../../../src/core/brain/metrics.ts";
import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { brainConfigPath } from "../../../src/core/brain/paths.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";
import { emitRecallTelemetry, RECALL_CHANNEL } from "../../../src/core/brain/recall-telemetry.ts";

const NOW = new Date("2026-06-05T03:30:00Z");
/** The metrics surface Lane 1's `sampleStorageUsage` appends one record per call under. */
const STORAGE_USAGE_SURFACE = STORAGE_USAGE_METRIC_SURFACE;
/**
 * A cap every real vault clears many times over: whatever the bootstrapped
 * fixture holds, its usage is far past 95 percent of this, and a tier past
 * 100 percent of cap is still `critical` - the top measured tier.
 */
const CRITICAL_CAP_BYTES = 1000;
/** A cap no test fixture approaches, so the tier stays below the warn band. */
const ROOMY_CAP_BYTES = 1_000_000_000_000;

let vault: string;
let configHome: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-maint-cap-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-maint-cap-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  mkdirSync(join(vault, "Brain"), { recursive: true });
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

/** Configure the vault-side capacity gate, the way the pressure test does. */
function configureCap(capBytes: number): void {
  appendFileSync(brainConfigPath(vault), `\nstorage:\n  cap_bytes: ${capBytes}\n`);
}

/** The resolved storage block a test names for the gate, defaults elsewhere. */
function capGate(capBytes: number): ResolvedBrainStorageConfig {
  return { ...BRAIN_STORAGE_DEFAULTS, cap_bytes: capBytes };
}

/**
 * A hand-built gate decision for the injected-reader tests. The lane must
 * treat whatever its reader returns as the decision of record, so these
 * fixtures are plain objects carrying only the fields the lane reads.
 */
function gateDecision(tier: string, skip: boolean, reason?: string): CapacityGateDecision {
  return {
    decision: skip ? "skip" : "run",
    tier,
    ...(reason !== undefined ? { reason } : {}),
  } as CapacityGateDecision;
}

function samples(): number {
  return listMetrics(vault, { surface: STORAGE_USAGE_SURFACE }).length;
}

function journalRows(verdict: string): ReadonlyArray<MaintenanceJournalEntry> {
  return listJournal(vault).filter((e) => e.verdict === verdict);
}

describe("evaluateGates: the capacity gate", () => {
  test("an unconfigured gate never fires and never measures", () => {
    let measurements = 0;
    const decision = evaluateGates(vault, {
      now: NOW,
      readCapacity: () => {
        measurements += 1;
        return gateDecision(STORAGE_FORECAST_TIER.critical, true);
      },
    });
    expect(decision.verdict).toBe(MAINTENANCE_VERDICT.run);
    expect(decision.capacity).toBeUndefined();
    expect(measurements).toBe(0);
  });

  test("a critical tier skips with the reading carried alongside", () => {
    const critical = gateDecision(STORAGE_FORECAST_TIER.critical, true);
    const decision = evaluateGates(vault, {
      now: NOW,
      capacity: capGate(CRITICAL_CAP_BYTES),
      readCapacity: () => critical,
    });
    expect(decision.verdict).toBe(MAINTENANCE_VERDICT.skippedCapacity);
    expect(decision.capacity).toEqual(critical);
  });

  test("a sub-critical tier leaves the gate open with the reading attached", () => {
    const ok = gateDecision(STORAGE_FORECAST_TIER.ok, false);
    const decision = evaluateGates(vault, {
      now: NOW,
      capacity: capGate(ROOMY_CAP_BYTES),
      readCapacity: () => ok,
    });
    expect(decision.verdict).toBe(MAINTENANCE_VERDICT.run);
    expect(decision.capacity).toEqual(ok);
  });

  test("an unmeasurable store leaves the gate open", () => {
    const unmeasurable = gateDecision(STORAGE_FORECAST_TIER.unmeasurable, false, "test-reason");
    const decision = evaluateGates(vault, {
      now: NOW,
      capacity: capGate(CRITICAL_CAP_BYTES),
      readCapacity: () => unmeasurable,
    });
    // A threshold that would skip on any real reading stays open, because
    // nothing was measured - the same honesty the pressure gate practices.
    expect(decision.verdict).toBe(MAINTENANCE_VERDICT.run);
    expect(decision.capacity).toEqual(unmeasurable);
  });

  test("an earlier closed gate wins and the capacity gate is never measured", () => {
    let measurements = 0;
    const decision = evaluateGates(vault, {
      now: NOW,
      window: { startHour: 10, endHour: 12, tz: "UTC" },
      capacity: capGate(CRITICAL_CAP_BYTES),
      readCapacity: () => {
        measurements += 1;
        return gateDecision(STORAGE_FORECAST_TIER.critical, true);
      },
    });
    expect(decision.verdict).toBe(MAINTENANCE_VERDICT.skippedWindow);
    expect(decision.capacity).toBeUndefined();
    expect(measurements).toBe(0);
  });

  test("a busy vault is answered before the byte walk", () => {
    for (let i = 0; i < 5; i++) {
      emitRecallTelemetry(vault, {
        host: "claude-code",
        channel: RECALL_CHANNEL.cli,
        mode: "search",
        status: "ok",
        durationMs: 12,
        resultCount: 3,
        createdAt: new Date(NOW.getTime() - 60_000).toISOString(),
      });
    }
    let measurements = 0;
    const decision = evaluateGates(vault, {
      now: NOW,
      busy: { minutes: 10, threshold: 5 },
      capacity: capGate(CRITICAL_CAP_BYTES),
      readCapacity: () => {
        measurements += 1;
        return gateDecision(STORAGE_FORECAST_TIER.critical, true);
      },
    });
    expect(decision.verdict).toBe(MAINTENANCE_VERDICT.skippedBusy);
    expect(measurements).toBe(0);
  });
});

describe("the capacity gate through the lane", () => {
  test("a critical vault skips with its own verdict and journals the tier", async () => {
    configureCap(CRITICAL_CAP_BYTES);
    const result = await runMaintenance(vault, {
      now: NOW,
      holder: "worker-a",
      tasks: [
        {
          name: "dream",
          run: async () => {
            throw new Error("the capacity gate should have refused before this ran");
          },
        },
      ],
    });
    expect(result.verdict).toBe(MAINTENANCE_VERDICT.skippedCapacity);
    expect(result.tasks).toEqual([]);
    const row = journalRows(MAINTENANCE_VERDICT.skippedCapacity)[0];
    expect(row?.holder).toBe("worker-a");
    expect(row?.capacity_tier).toBe(STORAGE_FORECAST_TIER.critical);
  });

  test("the sample is taken before the skip returns", async () => {
    configureCap(CRITICAL_CAP_BYTES);
    const before = samples();
    await runMaintenance(vault, {
      now: NOW,
      holder: "worker-a",
      tasks: [{ name: "dream", run: async () => {} }],
    });
    // Exactly one: the skip's own sample, not one per task or per gate.
    expect(samples()).toBe(before + 1);
  });

  test("a sub-critical vault runs and samples nothing", async () => {
    configureCap(ROOMY_CAP_BYTES);
    const before = samples();
    const result = await runMaintenance(vault, {
      now: NOW,
      holder: "worker-a",
      tasks: [{ name: "dream", run: async () => {} }],
    });
    expect(result.verdict).toBe(MAINTENANCE_VERDICT.run);
    expect(result.tasks[0]?.ok).toBe(true);
    expect(samples()).toBe(before);
  });

  test("a vault without a cap never measures", async () => {
    const before = samples();
    const result = await runMaintenance(vault, {
      now: NOW,
      holder: "worker-a",
      tasks: [{ name: "dream", run: async () => {} }],
    });
    expect(result.verdict).toBe(MAINTENANCE_VERDICT.run);
    expect(samples()).toBe(before);
    expect(journalRows(MAINTENANCE_VERDICT.skippedCapacity)).toEqual([]);
  });

  test("an unmeasurable store journals a notice on its own line and still runs", async () => {
    configureCap(CRITICAL_CAP_BYTES);
    const ran: string[] = [];
    const result = await runMaintenance(vault, {
      now: NOW,
      holder: "worker-a",
      readCapacity: () =>
        gateDecision(STORAGE_FORECAST_TIER.unmeasurable, false, "test-unreadable"),
      tasks: [{ name: "dream", run: async () => void ran.push("dream") }],
    });
    expect(result.verdict).toBe(MAINTENANCE_VERDICT.run);
    expect(ran).toEqual(["dream"]);

    const journal = listJournal(vault);
    const notice = journal.find((e) => e.verdict === MAINTENANCE_VERDICT.capacityUnmeasurable);
    // Two different lines, never one: the notice that the gate could not
    // evaluate is not the row of the work that then went ahead.
    expect(notice?.capacity_reason).toBe("test-unreadable");
    expect(notice?.task).toBeUndefined();
    expect(journal.some((e) => e.verdict === MAINTENANCE_VERDICT.skippedCapacity)).toBe(false);
    expect(journal.some((e) => e.verdict === MAINTENANCE_VERDICT.run && e.task === "dream")).toBe(
      true,
    );
  });

  test("--force bypasses the capacity gate, and the lease is never bypassed", async () => {
    configureCap(CRITICAL_CAP_BYTES);
    const forced = await runMaintenance(vault, {
      now: NOW,
      holder: "worker-a",
      force: true,
      tasks: [{ name: "dream", run: async () => {} }],
    });
    expect(forced.verdict).toBe(MAINTENANCE_VERDICT.run);
    expect(forced.tasks[0]?.ok).toBe(true);
    expect(journalRows(MAINTENANCE_VERDICT.skippedCapacity)).toEqual([]);

    acquireLease(vault, { holder: "other-worker", ttlMs: 600_000, now: NOW });
    const held = await runMaintenance(vault, {
      now: NOW,
      holder: "worker-a",
      force: true,
      tasks: [{ name: "dream", run: async () => {} }],
    });
    expect(held.verdict).toBe(MAINTENANCE_VERDICT.skippedLease);
    expect(currentLease(vault, { now: NOW })?.holder).toBe("other-worker");
  });
});

// The lane surfaces (CLI verb and brain_maintenance) carry the verdict in
// task 2.2's commit; the surface tests land there.
