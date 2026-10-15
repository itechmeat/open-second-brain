/**
 * The storage forecast and the usage sampler (`forecastStorageUsage`,
 * `sampleStorageUsage`).
 *
 * Claims pinned here:
 *
 *   1. Over seeded `storage_usage` metric samples the forecast returns
 *      the linear slope (bytes per day), the days left to the cap and a
 *      tier, and the tier boundaries land EXACTLY on the default
 *      constants: 80 percent / 30 days warns, 95 percent / 7 days is
 *      critical.
 *   2. An absent `cap_bytes` is `unbounded`; an incomplete measurement is
 *      `unmeasurable` - a census that could not read a surface refuses
 *      the forecast by name instead of projecting from partial bytes.
 *   3. Fewer than two stored samples is the named `no_forecast` state:
 *      the stored aggregate is advisory, never tier-eligible on its own.
 *      A FRESH reading (`latestUsage`) is enforcement truth, so the
 *      percent tiers compute from it even with an empty history.
 *   4. `sampleStorageUsage` appends exactly one `storage_usage` metrics
 *      record per call, is idempotent per run id, and an append failure
 *      is reported by name, never thrown.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendMetric, listMetrics, metricsDir } from "../../../src/core/brain/metrics.ts";
import {
  STORAGE_CRITICAL_DAYS_DEFAULT,
  STORAGE_CRITICAL_PERCENT_DEFAULT,
  STORAGE_USAGE_METRIC_SURFACE,
  STORAGE_WARN_DAYS_DEFAULT,
  STORAGE_WARN_PERCENT_DEFAULT,
  forecastStorageUsage,
  sampleStorageUsage,
} from "../../../src/core/brain/storage/forecast.ts";
import { measureStorageUsage } from "../../../src/core/brain/storage/usage.ts";
import { CHMOD_CANNOT_DENY } from "../../helpers/platform.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-storage-forecast-"));
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

const CAP = 1000;
const NOW = new Date("2026-10-15T12:00:00Z");

/** Seed one `storage_usage` sample `daysAgo` days before the forecast instant. */
function seedSample(daysAgo: number, totalBytes: number): void {
  const t = new Date(Date.parse("2026-10-15T12:00:00Z") - daysAgo * 86_400_000);
  appendMetric(vault, {
    surface: STORAGE_USAGE_METRIC_SURFACE,
    runAt: t.toISOString().replace(".000Z", "Z"),
    payload: { run_id: `seed-${daysAgo}`, total_bytes: totalBytes, measured: true },
  });
}

describe("forecastStorageUsage", () => {
  test("returns the linear slope, days to cap and tier over seeded samples", () => {
    seedSample(2, 100);
    seedSample(1, 200);
    seedSample(0, 300);
    // Cap 5000 keeps the reading clear of every boundary: 6 percent
    // used, 47 days to the cap.
    const forecast = forecastStorageUsage(vault, { capBytes: 5000 });
    expect(forecast.tier).toBe("ok");
    expect(forecast.slopeBytesPerDay).toBe(100);
    expect(forecast.measuredBytes).toBe(300);
    expect(forecast.percentUsed).toBe(6);
    expect(forecast.daysToCap).toBe(47);
    expect(forecast.capBytes).toBe(5000);
  });

  test("exactly the warn percent warns and exactly the critical percent is critical", () => {
    expect(STORAGE_WARN_PERCENT_DEFAULT).toBe(80);
    expect(STORAGE_CRITICAL_PERCENT_DEFAULT).toBe(95);
    expect(STORAGE_WARN_DAYS_DEFAULT).toBe(30);
    expect(STORAGE_CRITICAL_DAYS_DEFAULT).toBe(7);

    // A gentle slope keeps the days boundary out of the decision: 20
    // days to the cap at 10 bytes per day.
    seedSample(1, 790);
    seedSample(0, 800);
    expect(forecastStorageUsage(vault, { capBytes: CAP }).tier).toBe("warn");

    seedSample(-1, 950);
    // 95 percent used, and 5 days to the cap - critical on both counts.
    expect(forecastStorageUsage(vault, { capBytes: CAP }).tier).toBe("critical");
  });

  test("the percent boundaries are inclusive with no trend to decide instead", () => {
    // The tier fixtures above sit inside the days bands too, so a
    // comparison flipped exclusive would still answer warn/critical
    // through the days path and the percent boundary would go unpinned.
    // A FLAT history has slope 0 and no daysToCap, so the percent
    // comparison alone decides: exactly 80 warns, exactly 95 is critical.
    seedSample(1, 800);
    seedSample(0, 800);
    const warn = forecastStorageUsage(vault, { capBytes: CAP });
    expect(warn.slopeBytesPerDay).toBe(0);
    expect(warn.daysToCap).toBe(null);
    expect(warn.percentUsed).toBe(80);
    expect(warn.tier).toBe("warn");

    rmSync(metricsDir(vault), { recursive: true, force: true });
    seedSample(1, 950);
    seedSample(0, 950);
    const critical = forecastStorageUsage(vault, { capBytes: CAP });
    expect(critical.daysToCap).toBe(null);
    expect(critical.percentUsed).toBe(95);
    expect(critical.tier).toBe("critical");
  });

  test("a history that cannot be listed answers samplesUnreadable, never no-samples", () => {
    // A metrics directory replaced by a plain file makes the ledger
    // listing throw; the forecast must NAME the unreadable history on
    // the result instead of flattening it into "no samples ever
    // recorded" - the two say opposite things about the vault's past.
    seedSample(1, 400);
    seedSample(0, 500);
    rmSync(metricsDir(vault), { recursive: true, force: true });
    writeFileSync(metricsDir(vault), "not a directory\n", "utf8");
    const forecast = forecastStorageUsage(vault, { capBytes: CAP });
    expect(forecast.samplesUnreadable).toBe(true);
    expect(forecast.tier).toBe("no_forecast");
  });

  test("a percent-only warn never outranks a critical days horizon", () => {
    // 280 of 350 bytes is exactly 80 percent (warn by percent), and a
    // slope of 10 bytes per day puts the cap exactly 7 days out
    // (critical by days). The critical comparison runs first, so the
    // days horizon decides the tier.
    seedSample(1, 270);
    seedSample(0, 280);
    const forecast = forecastStorageUsage(vault, { capBytes: 350 });
    expect(forecast.percentUsed).toBe(80);
    expect(forecast.daysToCap).toBe(7);
    expect(forecast.tier).toBe("critical");
  });

  test("exactly the warn days to cap warns", () => {
    // current 300, slope 10 per day: 30 days to 600, at the boundary.
    seedSample(1, 290);
    seedSample(0, 300);
    const warn = forecastStorageUsage(vault, { capBytes: 600 });
    expect(warn.slopeBytesPerDay).toBe(10);
    expect(warn.daysToCap).toBe(30);
    expect(warn.tier).toBe("warn");
  });

  test("exactly the critical days to cap is critical", () => {
    // current 300, slope 50 per day: 7 days to 650, at the boundary.
    seedSample(1, 250);
    seedSample(0, 300);
    const critical = forecastStorageUsage(vault, { capBytes: 650 });
    expect(critical.slopeBytesPerDay).toBe(50);
    expect(critical.daysToCap).toBe(7);
    expect(critical.tier).toBe("critical");
  });

  test("an absent cap is unbounded", () => {
    seedSample(1, 900);
    seedSample(0, 990);
    const forecast = forecastStorageUsage(vault, { capBytes: null });
    expect(forecast.tier).toBe("unbounded");
    expect(forecast.percentUsed).toBe(null);
    expect(forecast.daysToCap).toBe(null);
  });

  test("fewer than two stored samples is the named no-forecast state", () => {
    expect(forecastStorageUsage(vault, { capBytes: CAP }).tier).toBe("no_forecast");
    seedSample(0, 500);
    expect(forecastStorageUsage(vault, { capBytes: CAP }).tier).toBe("no_forecast");
  });

  test("a fresh reading is tier-eligible even with an empty history", () => {
    const usage = measureStorageUsage(vault);
    const forecast = forecastStorageUsage(vault, { capBytes: 100, latestUsage: usage });
    expect(forecast.measuredBytes).toBe(usage.totalBytes);
    expect(forecast.tier).toBe("ok");
    // One fresh reading is no trend.
    expect(forecast.slopeBytesPerDay).toBe(null);
    expect(forecast.daysToCap).toBe(null);
  });

  test("the freshest reading wins over the stored aggregate", () => {
    // Flat history at 90 percent: the stored aggregate alone warns.
    seedSample(1, 900);
    seedSample(0, 900);
    expect(forecastStorageUsage(vault, { capBytes: CAP }).tier).toBe("warn");
    // The fresh census of the same vault counts only the metric records
    // themselves - a fraction of the stored total - and answers ok.
    const usage = measureStorageUsage(vault);
    expect(usage.totalBytes).toBeLessThan(900);
    const forecast = forecastStorageUsage(vault, { capBytes: CAP, latestUsage: usage });
    expect(forecast.measuredBytes).toBe(usage.totalBytes);
    expect(forecast.tier).toBe("ok");
  });

  test("a shrinking vault never forecasts past the cap", () => {
    seedSample(1, 500);
    seedSample(0, 400);
    const forecast = forecastStorageUsage(vault, { capBytes: CAP });
    expect(forecast.slopeBytesPerDay).toBe(-100);
    expect(forecast.daysToCap).toBe(null);
    expect(forecast.tier).toBe("ok");
  });

  test.skipIf(CHMOD_CANNOT_DENY)("an incomplete measurement is unmeasurable", () => {
    seedSample(1, 100);
    seedSample(0, 200);
    mkdirSync(join(vault, "Brain", ".artifacts"), { recursive: true });
    chmodSync(join(vault, "Brain", ".artifacts"), 0o000);
    try {
      const usage = measureStorageUsage(vault);
      expect(usage.complete).toBe(false);
      const forecast = forecastStorageUsage(vault, { capBytes: CAP, latestUsage: usage });
      expect(forecast.tier).toBe("unmeasurable");
      expect(forecast.unmeasured).toHaveLength(1);
    } finally {
      chmodSync(join(vault, "Brain", ".artifacts"), 0o755);
    }
  });

  test("the forecast is deterministic for identical inputs", () => {
    seedSample(1, 100);
    seedSample(0, 200);
    const a = forecastStorageUsage(vault, { capBytes: CAP });
    const b = forecastStorageUsage(vault, { capBytes: CAP });
    expect(b).toEqual(a);
  });
});

describe("sampleStorageUsage", () => {
  test("appends exactly one storage_usage record per call", () => {
    const usage = measureStorageUsage(vault);
    const result = sampleStorageUsage(vault, { runId: "run-1", now: NOW });
    expect(result.appended).toBe(true);
    expect(result.runId).toBe("run-1");
    expect(result.usage.totalBytes).toBe(usage.totalBytes);
    const records = listMetrics(vault, { surface: STORAGE_USAGE_METRIC_SURFACE });
    expect(records).toHaveLength(1);
    expect(records[0]!.surface).toBe(STORAGE_USAGE_METRIC_SURFACE);
    expect(records[0]!.payload["total_bytes"]).toBe(usage.totalBytes);
    expect(records[0]!.payload["measured"]).toBe(true);
  });

  test("is idempotent per run id and appends again for a new one", () => {
    sampleStorageUsage(vault, { runId: "run-1", now: NOW });
    const repeat = sampleStorageUsage(vault, { runId: "run-1", now: NOW });
    expect(repeat.appended).toBe(false);
    expect(listMetrics(vault, { surface: STORAGE_USAGE_METRIC_SURFACE })).toHaveLength(1);
    const next = sampleStorageUsage(vault, { runId: "run-2", now: NOW });
    expect(next.appended).toBe(true);
    expect(listMetrics(vault, { surface: STORAGE_USAGE_METRIC_SURFACE })).toHaveLength(2);
  });

  test("a pre-measured census is recorded instead of walking the vault again", () => {
    // The census a gate already took, before the vault grew: the sampler
    // must record THESE bytes, not take a second census that would
    // measure the growth.
    const usage = measureStorageUsage(vault, { now: NOW });
    mkdirSync(join(vault, "Brain", "sources"), { recursive: true });
    writeFileSync(join(vault, "Brain", "sources", "AA-grown.md"), "x".repeat(50_000), "utf8");
    const result = sampleStorageUsage(vault, { runId: "run-1", now: NOW, usage });
    expect(result.usage).toBe(usage);
    expect(result.appended).toBe(true);
    const records = listMetrics(vault, { surface: STORAGE_USAGE_METRIC_SURFACE });
    expect(records).toHaveLength(1);
    expect(records[0]!.payload["total_bytes"]).toBe(usage.totalBytes);
  });

  test("an append failure is reported by name, never thrown", () => {
    // Brain/metrics exists as a regular file, so creating the metrics
    // directory fails and the append cannot land.
    mkdirSync(join(vault, "Brain"), { recursive: true });
    writeFileSync(join(vault, "Brain", "metrics"), "not a directory", "utf8");
    const result = sampleStorageUsage(vault, { runId: "run-1", now: NOW });
    expect(result.appended).toBe(false);
    expect(result.appendError).toContain("EEXIST");
    expect(result.appendError).toContain("metrics");
  });
});
