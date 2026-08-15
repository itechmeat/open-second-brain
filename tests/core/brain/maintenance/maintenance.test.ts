/**
 * Quiet-window, lease-guarded maintenance lane (t_166d1226): a heavy
 * pass runs only inside the configured local-time window, only when
 * recent interactive query-rate is low, and only under an expiring
 * SQLite lease no second worker can grab; every attempt - including
 * gate refusals - lands in a bounded journal.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  acquireLease,
  currentLease,
  releaseLease,
} from "../../../../src/core/brain/maintenance/lease.ts";
import {
  dailyWindowContains,
  evaluateGates,
  runMaintenance,
} from "../../../../src/core/brain/maintenance/lane.ts";
import {
  appendJournal,
  consecutiveTaskFailures,
  listJournal,
  MAINTENANCE_JOURNAL_CAP,
  MAINTENANCE_VERDICT,
  sweepJournal,
} from "../../../../src/core/brain/maintenance/journal.ts";
import {
  HOST_PRESSURE,
  HOST_PRESSURE_UNMEASURABLE_REASON,
  type HostPressureReading,
} from "../../../../src/core/brain/maintenance/host-pressure.ts";
import { MAINTENANCE_FAILURE_STREAK_LIMIT_DEFAULT } from "../../../../src/core/brain/policy/blocks/maintenance.ts";
import { brainConfigPath } from "../../../../src/core/brain/paths.ts";
import {
  emitRecallTelemetry,
  RECALL_CHANNEL,
} from "../../../../src/core/brain/recall-telemetry.ts";
import { bootstrapBrain } from "../../../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../../../src/core/fs-atomic.ts";

const NOW = new Date("2026-06-05T03:30:00Z");

let vault: string;
let configHome: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-maint-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-maint-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  mkdirSync(join(vault, "Brain"), { recursive: true });
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

describe("lease", () => {
  test("a live lease blocks a second worker; expiry frees it", () => {
    expect(acquireLease(vault, { holder: "worker-a", ttlMs: 60_000, now: NOW })).toBe(true);
    expect(acquireLease(vault, { holder: "worker-b", ttlMs: 60_000, now: NOW })).toBe(false);
    expect(currentLease(vault, { now: NOW })?.holder).toBe("worker-a");

    const afterExpiry = new Date(NOW.getTime() + 61_000);
    expect(acquireLease(vault, { holder: "worker-b", ttlMs: 60_000, now: afterExpiry })).toBe(true);
    expect(currentLease(vault, { now: afterExpiry })?.holder).toBe("worker-b");
  });

  test("release only honors the holder", () => {
    acquireLease(vault, { holder: "worker-a", ttlMs: 60_000, now: NOW });
    expect(releaseLease(vault, { holder: "worker-b" })).toBe(false);
    expect(releaseLease(vault, { holder: "worker-a" })).toBe(true);
    expect(currentLease(vault, { now: NOW })).toBeNull();
  });
});

describe("dailyWindowContains", () => {
  test("plain window and midnight wrap, timezone-aware", () => {
    // 03:30 UTC.
    expect(dailyWindowContains(NOW, { startHour: 2, endHour: 6, tz: "UTC" })).toBe(true);
    expect(dailyWindowContains(NOW, { startHour: 4, endHour: 6, tz: "UTC" })).toBe(false);
    // Wrap: 22-04 contains 03:30.
    expect(dailyWindowContains(NOW, { startHour: 22, endHour: 4, tz: "UTC" })).toBe(true);
    // 03:30 UTC = 06:30 in UTC+3.
    expect(dailyWindowContains(NOW, { startHour: 6, endHour: 8, tz: "Europe/Moscow" })).toBe(true);
  });
});

describe("evaluateGates", () => {
  test("no window configured and a quiet vault runs", () => {
    expect(evaluateGates(vault, { now: NOW }).verdict).toBe(MAINTENANCE_VERDICT.run);
  });

  test("outside the window skips", () => {
    expect(
      evaluateGates(vault, { now: NOW, window: { startHour: 10, endHour: 12, tz: "UTC" } }).verdict,
    ).toBe(MAINTENANCE_VERDICT.skippedWindow);
  });

  test("recent interactive queries above the threshold skip as busy", () => {
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
    expect(evaluateGates(vault, { now: NOW, busy: { minutes: 10, threshold: 5 } }).verdict).toBe(
      MAINTENANCE_VERDICT.skippedBusy,
    );
    expect(evaluateGates(vault, { now: NOW, busy: { minutes: 10, threshold: 6 } }).verdict).toBe(
      MAINTENANCE_VERDICT.run,
    );
  });
});

describe("the host-pressure gate", () => {
  const measured = (percent: number): HostPressureReading => ({
    state: HOST_PRESSURE.measured,
    percent,
    load_average_1m: percent / 25,
    cpu_count: 4,
  });
  const unmeasurable: HostPressureReading = {
    state: HOST_PRESSURE.unmeasurable,
    reason: HOST_PRESSURE_UNMEASURABLE_REASON.platformBlind,
  };

  test("an unconfigured gate never fires and never measures", () => {
    let measurements = 0;
    const decision = evaluateGates(vault, {
      now: NOW,
      readPressure: () => {
        measurements += 1;
        return measured(999);
      },
    });
    expect(decision.verdict).toBe(MAINTENANCE_VERDICT.run);
    expect(decision.pressure).toBeUndefined();
    expect(measurements).toBe(0);
  });

  test("pressure at or above the configured percentage skips", () => {
    const decision = evaluateGates(vault, {
      now: NOW,
      pressure: { percent: 70 },
      readPressure: () => measured(70),
    });
    expect(decision.verdict).toBe(MAINTENANCE_VERDICT.skippedPressure);
    expect(decision.pressure).toEqual(measured(70));
  });

  test("pressure below the configured percentage leaves the gate open", () => {
    const decision = evaluateGates(vault, {
      now: NOW,
      pressure: { percent: 70 },
      readPressure: () => measured(69),
    });
    expect(decision.verdict).toBe(MAINTENANCE_VERDICT.run);
  });

  test("an unmeasurable host leaves the gate open and says so", () => {
    const decision = evaluateGates(vault, {
      now: NOW,
      pressure: { percent: 1 },
      readPressure: () => unmeasurable,
    });
    // A threshold of 1% would skip on any real reading; the gate is open
    // because nothing was read, which is a different fact from "quiet".
    expect(decision.verdict).toBe(MAINTENANCE_VERDICT.run);
    expect(decision.pressure).toEqual(unmeasurable);
  });

  test("an earlier closed gate wins and the host is never probed", () => {
    let measurements = 0;
    const decision = evaluateGates(vault, {
      now: NOW,
      window: { startHour: 10, endHour: 12, tz: "UTC" },
      pressure: { percent: 70 },
      readPressure: () => {
        measurements += 1;
        return measured(99);
      },
    });
    expect(decision.verdict).toBe(MAINTENANCE_VERDICT.skippedWindow);
    expect(measurements).toBe(0);
  });
});

describe("runMaintenance", () => {
  test("runs registered tasks stale-first under the lease and journals everything", async () => {
    const order: string[] = [];
    const result = await runMaintenance(vault, {
      now: NOW,
      holder: "worker-a",
      tasks: [
        { name: "dream", run: async () => void order.push("dream") },
        { name: "reindex", run: async () => void order.push("reindex") },
      ],
    });
    expect(result.verdict).toBe("run");
    expect(result.tasks.map((t) => t.name)).toEqual(["dream", "reindex"]);
    expect(result.tasks.every((t) => t.ok)).toBe(true);
    expect(order).toEqual(["dream", "reindex"]);
    expect(currentLease(vault, { now: NOW })).toBeNull(); // released

    const journal = listJournal(vault);
    expect(journal.some((e) => e.verdict === "run" && e.task === "dream")).toBe(true);

    // Second run: dream succeeded later than nothing - both ran, so
    // stale-first keeps prior order; make reindex stale by failing it.
    const failing = await runMaintenance(vault, {
      now: new Date(NOW.getTime() + 120_000),
      holder: "worker-a",
      tasks: [
        {
          name: "reindex",
          run: async () => {
            throw new Error("disk full");
          },
        },
      ],
    });
    expect(failing.tasks[0]!.ok).toBe(false);
    expect(listJournal(vault).some((e) => e.task === "reindex" && e.ok === false)).toBe(true);
  });

  test("gate refusals are journaled; --force bypasses window but never the lease", async () => {
    const window = { startHour: 10, endHour: 12, tz: "UTC" as const };
    const skipped = await runMaintenance(vault, {
      now: NOW,
      holder: "worker-a",
      window,
      tasks: [{ name: "dream", run: async () => {} }],
    });
    expect(skipped.verdict).toBe("skipped:window");
    expect(listJournal(vault).some((e) => e.verdict === "skipped:window")).toBe(true);

    acquireLease(vault, { holder: "other-worker", ttlMs: 600_000, now: NOW });
    const forced = await runMaintenance(vault, {
      now: NOW,
      holder: "worker-a",
      window,
      force: true,
      tasks: [{ name: "dream", run: async () => {} }],
    });
    expect(forced.verdict).toBe("skipped:lease");
  });

  test("the journal is bounded", () => {
    expect(MAINTENANCE_JOURNAL_CAP).toBeGreaterThanOrEqual(100);
  });
});

describe("the host-pressure gate through the lane", () => {
  /** Configure the fourth gate in the vault the lane reads. */
  function configurePressureGate(percent: number): void {
    appendFileSync(brainConfigPath(vault), `\nmaintenance:\n  host_pressure_percent: ${percent}\n`);
  }

  test("a loaded host skips with its own verdict and journals the reading", async () => {
    configurePressureGate(70);
    const result = await runMaintenance(vault, {
      now: NOW,
      holder: "worker-a",
      readPressure: () => ({
        state: HOST_PRESSURE.measured,
        percent: 180,
        load_average_1m: 7.2,
        cpu_count: 4,
      }),
      tasks: [
        {
          name: "dream",
          run: async () => {
            throw new Error("the gate should have refused before this ran");
          },
        },
      ],
    });
    expect(result.verdict).toBe(MAINTENANCE_VERDICT.skippedPressure);
    expect(result.tasks).toEqual([]);
    const row = listJournal(vault).find((e) => e.verdict === MAINTENANCE_VERDICT.skippedPressure);
    expect(row?.pressure_percent).toBe(180);
  });

  test("an unmeasurable host journals a SECOND kind of line and still runs", async () => {
    configurePressureGate(1);
    const ran: string[] = [];
    const result = await runMaintenance(vault, {
      now: NOW,
      holder: "worker-a",
      readPressure: () => ({
        state: HOST_PRESSURE.unmeasurable,
        reason: HOST_PRESSURE_UNMEASURABLE_REASON.platformBlind,
      }),
      tasks: [{ name: "dream", run: async () => void ran.push("dream") }],
    });
    expect(result.verdict).toBe(MAINTENANCE_VERDICT.run);
    expect(ran).toEqual(["dream"]);

    const journal = listJournal(vault);
    const notice = journal.find((e) => e.verdict === MAINTENANCE_VERDICT.pressureUnmeasurable);
    expect(notice?.pressure_reason).toBe(HOST_PRESSURE_UNMEASURABLE_REASON.platformBlind);
    // Two different lines, never one: the notice that the gate could not
    // evaluate is not the same row as the work that then went ahead, and
    // neither is a `skipped:pressure`.
    expect(journal.some((e) => e.verdict === MAINTENANCE_VERDICT.skippedPressure)).toBe(false);
    expect(journal.some((e) => e.verdict === MAINTENANCE_VERDICT.run && e.task === "dream")).toBe(
      true,
    );
    expect(notice?.task).toBeUndefined();
  });
});

describe("the consecutive-failure streak", () => {
  const TASK = "reindex";

  /** Run the lane once with the streak-tracked task failing or succeeding. */
  function laneRun(succeeds: boolean, force = false) {
    return runMaintenance(vault, {
      now: NOW,
      holder: "worker-a",
      ...(force ? { force: true } : {}),
      tasks: [
        {
          name: TASK,
          run: async () => {
            if (!succeeds) throw new Error("disk full");
          },
        },
      ],
    });
  }

  test("the streak counts journaled failures back to the newest success", async () => {
    expect(consecutiveTaskFailures(vault, TASK)).toBe(0);
    await laneRun(false);
    expect(consecutiveTaskFailures(vault, TASK)).toBe(1);
    await laneRun(false);
    expect(consecutiveTaskFailures(vault, TASK)).toBe(2);
    // A different task's failures are not this task's streak.
    await runMaintenance(vault, {
      now: NOW,
      holder: "worker-a",
      tasks: [
        {
          name: "dream",
          run: async () => {
            throw new Error("unrelated");
          },
        },
      ],
    });
    expect(consecutiveTaskFailures(vault, TASK)).toBe(2);
  });

  test("the limit refuses the task by name and states the streak", async () => {
    for (let i = 0; i < MAINTENANCE_FAILURE_STREAK_LIMIT_DEFAULT; i++) {
      // eslint-disable-next-line no-await-in-loop
      await laneRun(false);
    }
    const refused = await laneRun(false);
    expect(refused.verdict).toBe(MAINTENANCE_VERDICT.run);
    const task = refused.tasks[0]!;
    expect(task.refused).toBe(true);
    expect(task.ok).toBe(false);
    expect(task.failure_streak).toBe(MAINTENANCE_FAILURE_STREAK_LIMIT_DEFAULT);
    expect(task.error).toContain(String(MAINTENANCE_FAILURE_STREAK_LIMIT_DEFAULT));
    expect(task.error).toContain("--force");

    const row = listJournal(vault).find((e) => e.verdict === MAINTENANCE_VERDICT.refusedStreak);
    expect(row?.task).toBe(TASK);
    expect(row?.streak).toBe(MAINTENANCE_FAILURE_STREAK_LIMIT_DEFAULT);
    // A refusal is not an attempt: it must not deepen the streak it reports.
    expect(consecutiveTaskFailures(vault, TASK)).toBe(MAINTENANCE_FAILURE_STREAK_LIMIT_DEFAULT);
  });

  test("a single success resets the streak", async () => {
    for (let i = 0; i < MAINTENANCE_FAILURE_STREAK_LIMIT_DEFAULT; i++) {
      // eslint-disable-next-line no-await-in-loop
      await laneRun(false);
    }
    expect((await laneRun(false)).tasks[0]!.refused).toBe(true);

    // --force is the way past a refusal, and the success it produces is
    // what clears the streak for the next unforced run.
    const forced = await laneRun(true, true);
    expect(forced.tasks[0]!.ok).toBe(true);
    expect(consecutiveTaskFailures(vault, TASK)).toBe(0);

    const after = await laneRun(false);
    expect(after.tasks[0]!.refused).toBeUndefined();
    expect(after.tasks[0]!.ok).toBe(false);
    expect(consecutiveTaskFailures(vault, TASK)).toBe(1);
  });

  test("--force runs a task the streak would have refused", async () => {
    for (let i = 0; i < MAINTENANCE_FAILURE_STREAK_LIMIT_DEFAULT; i++) {
      // eslint-disable-next-line no-await-in-loop
      await laneRun(false);
    }
    const forced = await laneRun(false, true);
    expect(forced.tasks[0]!.refused).toBeUndefined();
    expect(forced.tasks[0]!.ok).toBe(false);
  });

  test("retrying one task runs it while every other gate still applies", async () => {
    for (let i = 0; i < MAINTENANCE_FAILURE_STREAK_LIMIT_DEFAULT; i++) {
      // eslint-disable-next-line no-await-in-loop
      await laneRun(false);
    }
    // Named: the refused task runs, and only that one - the second task's
    // own refusal is untouched by a retry that does not name it.
    const tasks = [
      { name: TASK, run: async () => void 0 },
      {
        name: "dream",
        run: async () => {
          throw new Error("should not have been reached");
        },
      },
    ];
    appendJournal(vault, {
      ts: NOW.toISOString(),
      holder: "worker-a",
      verdict: MAINTENANCE_VERDICT.refusedStreak,
      task: "dream",
      streak: MAINTENANCE_FAILURE_STREAK_LIMIT_DEFAULT,
    });

    const retried = await runMaintenance(vault, {
      now: NOW,
      holder: "worker-a",
      retryTasks: [TASK],
      tasks,
    });
    expect(retried.tasks.find((t) => t.name === TASK)?.ok).toBe(true);
    expect(retried.tasks.find((t) => t.name === "dream")?.refused).toBe(true);

    // A retry is not a force: the window gate still closes on the same run.
    const gated = await runMaintenance(vault, {
      now: NOW,
      holder: "worker-a",
      retryTasks: [TASK],
      window: { startHour: 10, endHour: 12, tz: "UTC" },
      tasks: [
        {
          name: TASK,
          run: async () => {
            throw new Error("the window gate should have refused before this ran");
          },
        },
      ],
    });
    expect(gated.verdict).toBe(MAINTENANCE_VERDICT.skippedWindow);
    expect(gated.tasks).toEqual([]);
  });

  test("the streak survives the journal cap, because the refusal row carries it", async () => {
    for (let i = 0; i < MAINTENANCE_FAILURE_STREAK_LIMIT_DEFAULT; i++) {
      // eslint-disable-next-line no-await-in-loop
      await laneRun(false);
    }
    expect((await laneRun(false)).tasks[0]!.refused).toBe(true);

    // The journal is a ring buffer. Trim it to the newest line - the same
    // rewrite `sweepJournal` performs under the lease, only sooner - so
    // every `run/ok:false` row that produced the streak is gone.
    sweepJournal(vault, 1);
    const kept = listJournal(vault);
    expect(kept.length).toBe(1);
    expect(kept[0]?.verdict).toBe(MAINTENANCE_VERDICT.refusedStreak);
    expect(kept.some((e) => e.verdict === MAINTENANCE_VERDICT.run)).toBe(false);

    // The refusal row records the count it refused on, so the streak does
    // not silently reset itself as its evidence rolls off the cap.
    expect(consecutiveTaskFailures(vault, TASK)).toBe(MAINTENANCE_FAILURE_STREAK_LIMIT_DEFAULT);
    expect((await laneRun(false)).tasks[0]!.refused).toBe(true);

    // And a success still clears it: the walk stops at the newest row that
    // is not a failure, which is newer than any carried refusal.
    const forced = await laneRun(true, true);
    expect(forced.tasks[0]!.ok).toBe(true);
    expect(consecutiveTaskFailures(vault, TASK)).toBe(0);
  });
});
