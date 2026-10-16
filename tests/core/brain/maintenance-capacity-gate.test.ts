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
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { evaluateGates, runMaintenance } from "../../../src/core/brain/maintenance/lane.ts";
import { DERIVED_STORE_DIR } from "../../../src/core/brain/path-constants.ts";
import {
  appendJournal,
  listJournal,
  MAINTENANCE_VERDICT,
  type MaintenanceJournalEntry,
} from "../../../src/core/brain/maintenance/journal.ts";
import { acquireLease, currentLease } from "../../../src/core/brain/maintenance/lease.ts";
import { BRAIN_STORAGE_DEFAULTS } from "../../../src/core/brain/policy/blocks/storage.ts";
import { MAINTENANCE_CAPACITY_REMEDY } from "../../../src/core/brain/maintenance/lane.ts";
import {
  STORAGE_FORECAST_TIER,
  STORAGE_USAGE_METRIC_SURFACE,
} from "../../../src/core/brain/storage/forecast.ts";
import { evaluateIngestAdmission } from "../../../src/core/brain/storage/gate.ts";
import type { CapacityGateDecision } from "../../../src/core/brain/storage/gate.ts";
import type { ResolvedBrainStorageConfig } from "../../../src/core/brain/types.ts";
import { listMetrics } from "../../../src/core/brain/metrics.ts";
import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { brainConfigPath } from "../../../src/core/brain/paths.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";
import { emitRecallTelemetry, RECALL_CHANNEL } from "../../../src/core/brain/recall-telemetry.ts";
import { TRANSPORT_REACH } from "../../../src/core/graph/transport-reach.ts";
import { JSONRPC_VERSION, MCPServer, PROTOCOL_VERSION } from "../../../src/mcp/index.ts";
import { homeEnv } from "../../helpers/platform.ts";
import { runCli } from "../../helpers/run-cli.ts";

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

/** The lease database the lane must not create before its gates decide. */
function leaseDb(vault: string): string {
  return join(vault, DERIVED_STORE_DIR, "maintenance.sqlite");
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
    // The reading rides the row the way the pressure percent does: the
    // measured bytes, the configured cap, and the percent between them.
    expect(row?.capacity_cap_bytes).toBe(CRITICAL_CAP_BYTES);
    expect(row?.capacity_measured_bytes).toBeGreaterThan(0);
    expect(row?.capacity_percent).toBe((row!.capacity_measured_bytes! / CRITICAL_CAP_BYTES) * 100);
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

  test("a gated run that proceeds records the gate's census as its sample too", async () => {
    // The M5 blind spot: the lane used to sample only on skips, so on a
    // vault where nobody runs the storage report the trend never existed
    // and the day-based tiers could never fire. Every run where the gate
    // evaluated - skip or proceed - now records its census, one walk,
    // never two.
    configureCap(ROOMY_CAP_BYTES);
    const before = samples();
    const result = await runMaintenance(vault, {
      now: NOW,
      holder: "worker-a",
      tasks: [{ name: "dream", run: async () => {} }],
    });
    expect(result.verdict).toBe(MAINTENANCE_VERDICT.run);
    expect(samples()).toBe(before + 1);
    const recorded = listMetrics(vault, { surface: STORAGE_USAGE_SURFACE });
    expect(recorded[recorded.length - 1]!.payload["measured"]).toBe(true);
  });

  test("a run where the capacity gate never evaluated samples nothing", async () => {
    // No cap configured: the gate never measured, so there is no census
    // to record and the lane must not invent one with a second walk.
    const before = samples();
    await runMaintenance(vault, {
      now: NOW,
      holder: "worker-a",
      tasks: [{ name: "dream", run: async () => {} }],
    });
    expect(samples()).toBe(before);
  });

  test("the skip's sample records the gate's census, not a second walk", async () => {
    configureCap(CRITICAL_CAP_BYTES);
    // A decision whose census names a byte total the real vault cannot
    // produce: if the lane sampled by re-measuring, the recorded sample
    // would carry the vault's real size instead - a second full walk
    // behind every skipped run.
    const census: CapacityGateDecision = {
      decision: "skip",
      tier: STORAGE_FORECAST_TIER.critical,
      reading: {
        measuredBytes: 777,
        capBytes: CRITICAL_CAP_BYTES,
        percentUsed: (777 / CRITICAL_CAP_BYTES) * 100,
        daysToCap: null,
        slopeBytesPerDay: null,
        measuredAt: NOW.toISOString(),
      },
      census: {
        measuredAt: NOW.toISOString(),
        complete: true,
        surfaces: [],
        bytesByTier: { derived: 0, "vault-content": 777 },
        totalBytes: 777,
        unmeasured: [],
      },
    };
    const before = samples();
    await runMaintenance(vault, {
      now: NOW,
      holder: "worker-a",
      readCapacity: () => census,
      tasks: [{ name: "dream", run: async () => {} }],
    });
    const recorded = listMetrics(vault, { surface: STORAGE_USAGE_SURFACE });
    expect(recorded).toHaveLength(before + 1);
    expect(recorded[0]!.payload["total_bytes"]).toBe(777);
  });

  test("a capacity-skipped run never touches the lease", async () => {
    configureCap(CRITICAL_CAP_BYTES);
    const result = await runMaintenance(vault, {
      now: NOW,
      holder: "worker-a",
      tasks: [{ name: "dream", run: async () => {} }],
    });
    expect(result.verdict).toBe(MAINTENANCE_VERDICT.skippedCapacity);
    // The fifth gate's order, pinned on disk: the capacity gate decides
    // BEFORE the lease is acquired, so a skipped run never even creates
    // the lease database. Lease acquisition moved ahead of the gate and
    // this file would come into existence behind every skip.
    expect(existsSync(leaseDb(vault))).toBe(false);
    expect(existsSync(`${leaseDb(vault)}-wal`)).toBe(false);
    // The verdict row is the gate's own, never a lease loss.
    expect(journalRows(MAINTENANCE_VERDICT.skippedLease)).toEqual([]);
  });

  test("a sub-critical vault runs", async () => {
    configureCap(ROOMY_CAP_BYTES);
    const before = samples();
    const result = await runMaintenance(vault, {
      now: NOW,
      holder: "worker-a",
      tasks: [{ name: "dream", run: async () => {} }],
    });
    expect(result.verdict).toBe(MAINTENANCE_VERDICT.run);
    expect(result.tasks[0]?.ok).toBe(true);
    // The gate evaluated, so the census was recorded (the sample-every-
    // gated-run rule above) - that is the ONE sample a proceeding run
    // costs, and no skip row exists.
    expect(samples()).toBe(before + 1);
    expect(journalRows(MAINTENANCE_VERDICT.skippedCapacity)).toEqual([]);
  });

  test("the warn band pauses the lane, with the report and journal row to show it", async () => {
    // The M5 backpressure band: background work pauses one band BEFORE
    // the wall. The bootstrapped skeleton sits inside the warn band of a
    // 30 KB cap - a tier the lane used to run straight through, because
    // only critical skipped and critical was reserved for the ingest
    // refusal.
    configureCap(30_000);
    const ran: string[] = [];
    const result = await runMaintenance(vault, {
      now: NOW,
      holder: "worker-a",
      tasks: [{ name: "dream", run: async () => void ran.push("dream") }],
    });
    expect(result.verdict).toBe(MAINTENANCE_VERDICT.skippedCapacity);
    expect(ran).toEqual([]);
    expect(result.capacity?.tier).toBe(STORAGE_FORECAST_TIER.warn);
    expect(result.capacity?.capacity_percent).not.toBeNull();
    expect(result.capacity?.pause_percent).toBe(BRAIN_STORAGE_DEFAULTS.warn_percent);
    const row = journalRows(MAINTENANCE_VERDICT.skippedCapacity)[0];
    expect(row?.capacity_tier).toBe(STORAGE_FORECAST_TIER.warn);
    // The census a paused run recorded (measured: true) is what the
    // trend fits while producers are backed off.
    const recorded = listMetrics(vault, { surface: STORAGE_USAGE_SURFACE });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.payload["measured"]).toBe(true);
  });

  test("a configured pause_percent below the warn band pauses earlier", async () => {
    // 20 percent of 100 KB measured: the tier is ok (far below the warn
    // band) and the operator's pause_percent: 15 pauses the lane anyway
    // - interactive ingest is untouched at this tier.
    configureCap(100_000);
    appendFileSync(brainConfigPath(vault), "  pause_percent: 15\n");
    mkdirSync(join(vault, "Brain", "sources"), { recursive: true });
    writeFileSync(join(vault, "Brain", "sources", "AA-page.md"), "x".repeat(20_000), "utf8");
    const result = await runMaintenance(vault, {
      now: NOW,
      holder: "worker-a",
      tasks: [{ name: "dream", run: async () => {} }],
    });
    expect(result.verdict).toBe(MAINTENANCE_VERDICT.skippedCapacity);
    expect(result.capacity?.tier).toBe(STORAGE_FORECAST_TIER.ok);
    expect(result.capacity?.pause_percent).toBe(15);
    expect(result.capacity?.capacity_percent).toBeGreaterThan(15);
  });

  test("an ingest refusal stays critical-only while the lane pauses at warn", async () => {
    // The two walls diverge on purpose: the SAME warn-band vault that
    // pauses the lane (the test above) does not refuse an interactive
    // write - evaluateIngestAdmission carries no pause line.
    configureCap(30_000);
    const admission = evaluateIngestAdmission(vault, { now: NOW });
    expect(admission.decision).not.toBeNull();
    expect(admission.decision!.tier).toBe(STORAGE_FORECAST_TIER.warn);
    expect(admission.decision!.decision).toBe("run");
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

/** The capacity block both lane front doors attach to a skipped run. */
interface CapacityReportJson {
  readonly tier: string;
  readonly remedy: string;
  readonly capacity_percent: number | null;
  readonly measured_bytes: number | null;
  readonly cap_bytes: number | null;
  readonly pause_percent: number | null;
}

describe("lane surfaces carry the capacity verdict", () => {
  test("the remedy names pruning the snapshot recovery points", () => {
    // M6: both reclamation verbs the remedy prescribes archive all of
    // Brain/ into Brain/.snapshots - a COUNTED surface - before they
    // free anything, so at 96 percent the "remedy" can first grow the
    // vault. The remedy names the retention knob, or an operator
    // following it blind reads pure shrink where there is a swap.
    expect(MAINTENANCE_CAPACITY_REMEDY).toContain("Brain/.snapshots");
    expect(MAINTENANCE_CAPACITY_REMEDY).toContain("snapshots.retention_count");
  });

  function seedSkipRow(): void {
    appendJournal(vault, {
      ts: NOW.toISOString(),
      holder: "worker-a",
      verdict: MAINTENANCE_VERDICT.skippedCapacity,
      capacity_tier: STORAGE_FORECAST_TIER.critical,
    });
  }

  test("status parses and renders a skipped:capacity row on both surfaces", async () => {
    seedSkipRow();
    const cli = await runCli(["brain", "maintenance", "status", "--vault", vault], {
      env: { OPEN_SECOND_BRAIN_CONFIG: join(configHome, "config.yaml"), ...homeEnv(configHome) },
    });
    expect(cli.returncode).toBe(0);
    expect(cli.stdout).toContain(MAINTENANCE_VERDICT.skippedCapacity);
  });

  test("a skipped-capacity run reports the tier and the remedy on the CLI", async () => {
    configureCap(CRITICAL_CAP_BYTES);
    const cli = await runCli(["brain", "maintenance", "run", "--vault", vault, "--json"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: join(configHome, "config.yaml"), ...homeEnv(configHome) },
    });
    expect(cli.returncode).toBe(0);
    const payload = JSON.parse(cli.stdout) as {
      verdict: string;
      capacity?: CapacityReportJson;
    };
    expect(payload.verdict).toBe(MAINTENANCE_VERDICT.skippedCapacity);
    expect(payload.capacity?.tier).toBe(STORAGE_FORECAST_TIER.critical);
    expect(payload.capacity?.remedy.length).toBeGreaterThan(0);
    // The gate's full reading rides the report, not the tier alone.
    expect(payload.capacity?.cap_bytes).toBe(CRITICAL_CAP_BYTES);
    expect(payload.capacity?.measured_bytes).toBeGreaterThan(0);
    expect(payload.capacity?.capacity_percent).toBe(
      (payload.capacity!.measured_bytes! / CRITICAL_CAP_BYTES) * 100,
    );
    // The pause line the lane decided on rides beside the reading.
    expect(payload.capacity?.pause_percent).toBe(BRAIN_STORAGE_DEFAULTS.warn_percent);
  });

  test("a skipped-capacity run reports the tier and the remedy over MCP", async () => {
    configureCap(CRITICAL_CAP_BYTES);
    const server = new MCPServer(
      { vault, configPath: join(configHome, "config.yaml") },
      { reach: TRANSPORT_REACH.local },
    );
    await server.handleRequest({
      jsonrpc: JSONRPC_VERSION,
      id: 1,
      method: "initialize",
      params: { protocolVersion: PROTOCOL_VERSION },
    });
    const res = (await server.handleRequest({
      jsonrpc: JSONRPC_VERSION,
      id: 2,
      method: "tools/call",
      params: { name: "brain_maintenance", arguments: { operation: "run" } },
    })) as { result?: { structuredContent?: Record<string, unknown> } };
    const payload = (res.result?.structuredContent ?? {}) as {
      verdict?: string;
      capacity?: CapacityReportJson;
    };
    expect(payload.verdict).toBe(MAINTENANCE_VERDICT.skippedCapacity);
    expect(payload.capacity?.tier).toBe(STORAGE_FORECAST_TIER.critical);
    expect(payload.capacity?.remedy.length).toBeGreaterThan(0);
    expect(payload.capacity?.cap_bytes).toBe(CRITICAL_CAP_BYTES);
    expect(payload.capacity?.measured_bytes).toBeGreaterThan(0);
    expect(payload.capacity?.capacity_percent).toBe(
      (payload.capacity!.measured_bytes! / CRITICAL_CAP_BYTES) * 100,
    );
    expect(payload.capacity?.pause_percent).toBe(BRAIN_STORAGE_DEFAULTS.warn_percent);
  });
});
