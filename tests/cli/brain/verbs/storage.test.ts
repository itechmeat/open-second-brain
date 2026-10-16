/**
 * `o2b brain storage` (storage-lifecycle, Lane 1 task 1.7).
 *
 * Claims pinned here:
 *
 *   1. The report carries the per-surface census, the forecast and the
 *      usage sample this invocation records; an uncapped vault answers
 *      tier `unbounded` plainly - bytes are reported, no days-to-cap is
 *      invented, nothing refuses.
 *   2. Each invocation appends exactly one `storage_usage` sample.
 *   3. A cap positions the tier, and the stored trend travels into
 *      `slope_bytes_per_day` and `days_to_cap` beside the fresh census.
 *   4. An unreadable surface is refused by name (`unmeasured` with its
 *      reason), never reported as zero bytes, and the forecast answers
 *      `unmeasurable` rather than projecting from a partial census.
 *   5. A vault with no brain config fails by name (exit 1), it does not
 *      answer as an empty vault.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cmdBrainStorage } from "../../../../src/cli/brain/verbs/storage.ts";
import { bootstrapBrain } from "../../../../src/core/brain/init.ts";
import { resetVaultIdentityPins } from "../../../../src/core/brain/vault-identity.ts";
import { brainConfigPath } from "../../../../src/core/brain/paths.ts";
import {
  metricsDir,
  listMetrics,
  appendMetric,
  type MetricRecord,
} from "../../../../src/core/brain/metrics.ts";
import {
  STORAGE_USAGE_METRIC_SURFACE,
  STORAGE_FORECAST_TIER,
} from "../../../../src/core/brain/storage/forecast.ts";
import { measureStorageUsage } from "../../../../src/core/brain/storage/usage.ts";
import { atomicWriteFileSync } from "../../../../src/core/fs-atomic.ts";
import { runCli } from "../../../helpers/run-cli.ts";
import { CHMOD_CANNOT_DENY } from "../../../helpers/platform.ts";

let vault: string;
let configHome: string;
let savedConfigEnv: string | undefined;

beforeEach(() => {
  resetVaultIdentityPins();
  vault = mkdtempSync(join(tmpdir(), "o2b-cli-storage-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-cli-storage-cfg-"));
  atomicWriteFileSync(join(configHome, "config.yaml"), `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath: join(configHome, "config.yaml") });
  savedConfigEnv = process.env["OPEN_SECOND_BRAIN_CONFIG"];
  process.env["OPEN_SECOND_BRAIN_CONFIG"] = join(configHome, "config.yaml");
});

afterEach(() => {
  if (savedConfigEnv === undefined) delete process.env["OPEN_SECOND_BRAIN_CONFIG"];
  else process.env["OPEN_SECOND_BRAIN_CONFIG"] = savedConfigEnv;
  resetVaultIdentityPins();
  rmSync(vault, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  rmSync(configHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** The report shape an invocation prints, as the tests read it. */
interface StorageReportJson {
  measured: boolean;
  usage: {
    measuredAt: string;
    complete: boolean;
    surfaces: ReadonlyArray<{ surface: string; tier: string; bytes: number }>;
    bytesByTier: Record<string, number>;
    totalBytes: number;
    unmeasured: ReadonlyArray<{ surface: string; reason: string }>;
  };
  forecast: {
    tier: string;
    measuredBytes: number | null;
    capBytes: number | null;
    percentUsed: number | null;
    slopeBytesPerDay: number | null;
    daysToCap: number | null;
    unmeasured: ReadonlyArray<{ surface: string; reason: string }>;
    samplesUnreadable: boolean;
  };
  sample: { runId: string; appended: boolean; appendError?: string };
}

function writePage(name: string, totalBytes: number): void {
  mkdirSync(join(vault, "Brain", "sources"), { recursive: true });
  writeFileSync(join(vault, "Brain", "sources", name), "x".repeat(totalBytes), "utf8");
}

function configureCap(capBytes: number): void {
  writeFileSync(
    brainConfigPath(vault),
    `schema_version: 1\n\nstorage:\n  cap_bytes: ${capBytes}\n`,
    "utf8",
  );
}

/** Seed one `storage_usage` sample at a fixed time and total. */
function seedSample(runAt: string, totalBytes: number, runId: string): void {
  mkdirSync(metricsDir(vault), { recursive: true });
  appendMetric(vault, {
    surface: STORAGE_USAGE_METRIC_SURFACE,
    runAt,
    payload: { run_id: runId, total_bytes: totalBytes, measured: true, unmeasured: [] },
  });
}

/** The usage samples recorded for this vault so far. */
function usageSamples(): MetricRecord[] {
  return listMetrics(vault, { surface: STORAGE_USAGE_METRIC_SURFACE });
}

// ---- captured-output driving ----------------------------------------------

/** Everything the verb wrote to stdout and stderr during `drive`. */
interface Captured {
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Run the verb in-process with both output streams captured. The stream
 * methods are restored before this returns, even when the verb throws.
 */
async function drive(argv: ReadonlyArray<string>): Promise<{ captured: Captured; code: number }> {
  let out = "";
  let err = "";
  const originalOut = process.stdout.write;
  const originalErr = process.stderr.write;
  const append =
    (sink: (chunk: string) => void) =>
    (chunk: Uint8Array | string): boolean => {
      sink(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    };
  process.stdout.write = append((c) => (out += c)) as typeof process.stdout.write;
  process.stderr.write = append((c) => (err += c)) as typeof process.stderr.write;
  try {
    // The captured strings are read only after the verb has run, so the
    // object is built after the await - building it inline would snapshot
    // the buffers while they are still empty.
    const code = await cmdBrainStorage([...argv]);
    return { captured: { stdout: out, stderr: err }, code };
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
}

async function runJsonReport(): Promise<{ code: number; report: StorageReportJson }> {
  const { captured, code } = await drive(["--json"]);
  return { code, report: JSON.parse(captured.stdout) as StorageReportJson };
}

describe("o2b brain storage", () => {
  test("an uncapped vault reports the census and the unbounded tier plainly", async () => {
    writePage("AA-page.md", 50_000);
    // No writes happen between this measure and the verb's own census,
    // so the totals must agree exactly.
    const expected = measureStorageUsage(vault);

    const { code, report } = await runJsonReport();

    expect(code).toBe(0);
    expect(report.measured).toBe(true);
    expect(report.usage.totalBytes).toBe(expected.totalBytes);
    expect(report.usage.surfaces.map((s) => s.surface)).toEqual(
      expected.surfaces.map((s) => s.surface),
    );
    expect(report.forecast.tier).toBe(STORAGE_FORECAST_TIER.unbounded);
    expect(report.forecast.capBytes).toBeNull();
    expect(report.forecast.percentUsed).toBeNull();
    expect(report.forecast.daysToCap).toBeNull();
    expect(report.sample.appended).toBe(true);
  });

  test("each invocation appends exactly one usage sample", async () => {
    expect(usageSamples()).toHaveLength(0);
    await cmdBrainStorage(["--json"]);
    const afterFirst = usageSamples();
    expect(afterFirst).toHaveLength(1);
    await cmdBrainStorage(["--json"]);
    const afterSecond = usageSamples();
    expect(afterSecond).toHaveLength(2);
    expect(afterSecond[0]!.payload["run_id"]).not.toBe(afterSecond[1]!.payload["run_id"]);
  });

  test("a cap positions the tier and the stored trend travels", async () => {
    writePage("AA-page.md", 50_000);
    // Measure only after every fixture write: the cap rewrite replaces
    // the bootstrap config template, which would otherwise shift the
    // census between the measure and the verb's own.
    configureCap(1_000_000);
    const total = measureStorageUsage(vault).totalBytes;
    // Cap at twice the stable total: the fresh reading sits around half
    // the cap (never near the 80/95 percent bands), so the tier comes
    // from the horizon. A day-based trend needs three distinct days and
    // the verb's own fresh census supersedes the newest seeded day inside
    // the fit, which flattens the seeded rise to a fraction of the daily
    // step; twice the cap keeps the resulting horizon a few days inside
    // warn's 30 - and past critical's 7 - on every machine.
    const cap = Math.floor(total * 2.0);
    configureCap(cap);
    seedSample("2026-10-14T00:00:00.000Z", total - total / 10, "seed-older");
    seedSample("2026-10-15T00:00:00.000Z", total, "seed-newer");
    seedSample("2026-10-16T00:00:00.000Z", total + total / 20, "seed-newest");

    const { code, report } = await runJsonReport();

    expect(code).toBe(0);
    const forecast = report.forecast;
    expect(forecast.tier).toBe(STORAGE_FORECAST_TIER.warn);
    expect(forecast.capBytes).toBe(cap);
    expect(forecast.measuredBytes).not.toBeNull();
    // The percent and the days answer from the fresh census; the seeded
    // samples and the report's own sample are the only bytes that moved,
    // so the numeric identities are asserted relationally.
    expect(Math.abs((forecast.percentUsed! * cap) / 100 - forecast.measuredBytes!)).toBeLessThan(1);
    expect(
      Math.abs(forecast.measuredBytes! + forecast.daysToCap! * forecast.slopeBytesPerDay! - cap),
    ).toBeLessThan(1);
    // The slope is the seeded trend, not sample noise.
    expect(forecast.slopeBytesPerDay!).toBeGreaterThan(total / 30);
    expect(forecast.slopeBytesPerDay!).toBeLessThan(total / 10);
  });

  test.skipIf(CHMOD_CANNOT_DENY)(
    "an unreadable surface is refused by name, never reported as zero",
    async () => {
      writePage("AA-page.md", 9_000);
      configureCap(10_000);
      mkdirSync(join(vault, "Brain", ".artifacts"), { recursive: true });
      writeFileSync(join(vault, "Brain", ".artifacts", "tool-result.json"), "{}", "utf8");
      chmodSync(join(vault, "Brain", ".artifacts"), 0o000);
      try {
        const { code, report } = await runJsonReport();
        expect(code).toBe(0);
        expect(report.usage.complete).toBe(false);
        expect(report.usage.unmeasured).toEqual([
          { surface: "artifacts", reason: "surface_unreadable" },
        ]);
        expect(report.usage.surfaces.map((s) => s.surface)).not.toContain("artifacts");
        expect(report.forecast.tier).toBe(STORAGE_FORECAST_TIER.unmeasurable);
        expect(report.forecast.unmeasured.map((u) => u.surface)).toEqual(["artifacts"]);
      } finally {
        chmodSync(join(vault, "Brain", ".artifacts"), 0o755);
      }
    },
  );

  test("a vault with no brain config fails by name", async () => {
    const bare = mkdtempSync(join(tmpdir(), "o2b-cli-storage-bare-"));
    try {
      const { captured, code } = await drive(["--json", "--vault", bare]);
      expect(code).toBe(1);
      expect(captured.stderr).toContain("config file does not exist");
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  test("the text report names the unbounded tier and the sample", async () => {
    const { captured, code } = await drive([]);
    expect(code).toBe(0);
    expect(captured.stdout).toContain("unbounded");
    expect(captured.stdout).toContain("sample: appended as");
  });

  test("the dispatcher routes `brain storage` to the verb", async () => {
    const r = await runCli(["brain", "storage", "--json"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: join(configHome, "config.yaml") },
    });
    expect(r.returncode).toBe(0);
    const report = JSON.parse(r.stdout) as StorageReportJson;
    expect(report.measured).toBe(true);
    expect(report.forecast.tier).toBe(STORAGE_FORECAST_TIER.unbounded);
  });
});
