/**
 * Quiet-window, lease-guarded maintenance lane (t_166d1226): a heavy
 * pass runs only inside the configured local-time window, only when
 * recent interactive query-rate is low, and only under an expiring
 * SQLite lease no second worker can grab; every attempt - including
 * gate refusals - lands in a bounded journal.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
  listJournal,
  MAINTENANCE_JOURNAL_CAP,
} from "../../../../src/core/brain/maintenance/journal.ts";
import { emitRecallTelemetry } from "../../../../src/core/brain/recall-telemetry.ts";
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
    expect(evaluateGates(vault, { now: NOW })).toBe("run");
  });

  test("outside the window skips", () => {
    expect(
      evaluateGates(vault, { now: NOW, window: { startHour: 10, endHour: 12, tz: "UTC" } }),
    ).toBe("skipped:window");
  });

  test("recent interactive queries above the threshold skip as busy", () => {
    for (let i = 0; i < 5; i++) {
      emitRecallTelemetry(vault, {
        host: "claude-code",
        mode: "search",
        status: "ok",
        durationMs: 12,
        resultCount: 3,
        createdAt: new Date(NOW.getTime() - 60_000).toISOString(),
      });
    }
    expect(evaluateGates(vault, { now: NOW, busy: { minutes: 10, threshold: 5 } })).toBe(
      "skipped:busy",
    );
    expect(evaluateGates(vault, { now: NOW, busy: { minutes: 10, threshold: 6 } })).toBe("run");
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
