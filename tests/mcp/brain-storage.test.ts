/**
 * `brain_storage` (storage-lifecycle, Lane 1 task 1.7).
 *
 * Claims pinned here:
 *
 *   1. The tool and `o2b brain storage` derive from one builder: driven
 *      on the same vault state, their reports are equal on every field
 *      except the two per-invocation identity fields (`usage.measuredAt`
 *      and `sample.runId`), which are masked to a fixed marker - never
 *      value-compared, because their values ride the invoking clock and
 *      can collide when two calls share one tick. No flag-or-property
 *      exclusion list is needed because the payload IS the shared source.
 *   2. An uncapped vault answers tier `unbounded` - bytes reported, no
 *      invented cap, nothing refused.
 *   3. Each invocation appends exactly one `storage_usage` sample.
 *   4. An unmeasurable census is carried (`unmeasured` with reasons),
 *      never flattened into a zero or an invented projection.
 *   5. A vault with no brain config surfaces the named config error;
 *      the tool does not answer as an empty vault.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cmdBrainStorage } from "../../src/cli/brain/verbs/storage.ts";
import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { resetVaultIdentityPins } from "../../src/core/brain/vault-identity.ts";
import { brainConfigPath } from "../../src/core/brain/paths.ts";
import { metricsDir, listMetrics, type MetricRecord } from "../../src/core/brain/metrics.ts";
import { STORAGE_USAGE_METRIC_SURFACE } from "../../src/core/brain/storage/forecast.ts";
import { TRANSPORT_REACH } from "../../src/core/graph/transport-reach.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { STORAGE_TOOLS } from "../../src/mcp/brain/storage-tools.ts";
import type { ServerContext } from "../../src/mcp/tool-contract.ts";
import { CHMOD_CANNOT_DENY } from "../helpers/platform.ts";

const storage = STORAGE_TOOLS.find((tool) => tool.name === "brain_storage")!.handler;

let vault: string;
let configHome: string;
let savedConfigEnv: string | undefined;
let ctx: ServerContext;

beforeEach(() => {
  resetVaultIdentityPins();
  vault = mkdtempSync(join(tmpdir(), "o2b-mcp-storage-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-mcp-storage-cfg-"));
  atomicWriteFileSync(join(configHome, "config.yaml"), `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath: join(configHome, "config.yaml") });
  savedConfigEnv = process.env["OPEN_SECOND_BRAIN_CONFIG"];
  process.env["OPEN_SECOND_BRAIN_CONFIG"] = join(configHome, "config.yaml");
  ctx = {
    vault,
    configPath: join(configHome, "config.yaml"),
    repoRoot: null,
    reach: TRANSPORT_REACH.local,
  };
});

afterEach(() => {
  if (savedConfigEnv === undefined) delete process.env["OPEN_SECOND_BRAIN_CONFIG"];
  else process.env["OPEN_SECOND_BRAIN_CONFIG"] = savedConfigEnv;
  resetVaultIdentityPins();
  rmSync(vault, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  rmSync(configHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

interface ReportJson {
  measured: boolean;
  usage: Record<string, unknown>;
  forecast: Record<string, unknown>;
  sample: Record<string, unknown>;
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

/** The `brain_storage` report for the CLI surface, driven in-process. */
async function cliReport(): Promise<ReportJson> {
  let out = "";
  const original = process.stdout.write;
  process.stdout.write = ((chunk: Uint8Array | string): boolean => {
    out += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write;
  try {
    const code = await cmdBrainStorage(["--json"]);
    expect(code).toBe(0);
    return JSON.parse(out) as ReportJson;
  } finally {
    process.stdout.write = original;
  }
}

/** The usage samples recorded for this vault so far. */
function usageSamples(): MetricRecord[] {
  return listMetrics(vault, { surface: STORAGE_USAGE_METRIC_SURFACE });
}

/**
 * Every leaf path where `a` and `b` differ, as `dot.join`ed paths.
 * The parity claim is asserted over the full path set, so a field that
 * starts to drift between the two surfaces is named by the failure.
 */
function differingPaths(a: unknown, b: unknown, prefix = ""): string[] {
  if (typeof a === "object" && a !== null && typeof b === "object" && b !== null) {
    const ra = a as Record<string, unknown>;
    const rb = b as Record<string, unknown>;
    const keys = [...new Set([...Object.keys(ra), ...Object.keys(rb)])].toSorted();
    return keys.flatMap((key) =>
      differingPaths(ra[key], rb[key], `${prefix}${prefix ? "." : ""}${key}`),
    );
  }
  return Object.is(a, b) ? [] : [prefix];
}

/**
 * The leaf paths whose values are the invoking call's own identity: the
 * instant the census was taken and the run id the sample was recorded
 * under. A value comparison over them would make this claim depend on
 * the clock - two calls that straddle a tick differ, two that share one
 * collide - so the observed flake. Masking to a fixed marker, instead
 * of dropping the paths, keeps each field's PRESENCE part of the parity
 * claim while taking its value off the clock entirely.
 */
const INVOCATION_IDENTITY_PATHS: ReadonlyArray<string> = ["sample.runId", "usage.measuredAt"];
const MASKED_IDENTITY = "<invocation identity>";

/** A deep copy of `value` whose leaves at the invocation identity paths are masked. */
function maskPaths(value: unknown, prefix = ""): unknown {
  if (INVOCATION_IDENTITY_PATHS.includes(prefix)) return MASKED_IDENTITY;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(record).map(([key, child]) => [
        key,
        maskPaths(child, prefix === "" ? key : `${prefix}.${key}`),
      ]),
    );
  }
  return value;
}

describe("brain_storage", () => {
  test("the tool and the verb derive from one source", async () => {
    const fromVerb = await cliReport();
    // The verb's sample appended one metrics record; dropping the ledger
    // returns the vault to the state the verb's census measured, so the
    // tool's census sees the same bytes.
    rmSync(metricsDir(vault), { recursive: true, force: true });
    const fromTool = (await storage(ctx, {})) as { format: string } & ReportJson;
    // `format` is the transport's rendering hint, not report content.
    const { format, ...report } = fromTool;
    void format;
    // The two per-invocation identity fields are masked, not excluded
    // from the diff: masking keeps their presence in the claim while
    // taking their values off the clock, so two calls that share a tick
    // and two that straddle one prove the same thing.
    expect(differingPaths(maskPaths(fromVerb), maskPaths(report))).toEqual([]);
  });

  test("an uncapped vault answers unbounded, measured", async () => {
    writePage("AA-page.md", 20_000);
    const res = (await storage(ctx, {})) as ReportJson;
    expect(res.measured).toBe(true);
    expect(res.forecast["tier"]).toBe("unbounded");
    expect(res.forecast["capBytes"]).toBeNull();
    expect(res.forecast["percentUsed"]).toBeNull();
    expect(res.forecast["daysToCap"]).toBeNull();
    expect((res.usage as { complete: boolean }).complete).toBe(true);
    expect(res.sample["appended"]).toBe(true);
  });

  test("each invocation appends exactly one usage sample", async () => {
    expect(usageSamples()).toHaveLength(0);
    await storage(ctx, {});
    expect(usageSamples()).toHaveLength(1);
    await storage(ctx, {});
    expect(usageSamples()).toHaveLength(2);
  });

  test.skipIf(CHMOD_CANNOT_DENY)("an unmeasurable census is carried, not flattened", async () => {
    writePage("AA-page.md", 9_000);
    configureCap(10_000);
    mkdirSync(join(vault, "Brain", ".artifacts"), { recursive: true });
    chmodSync(join(vault, "Brain", ".artifacts"), 0o000);
    try {
      const res = (await storage(ctx, {})) as ReportJson;
      const usage = res.usage as {
        complete: boolean;
        unmeasured: ReadonlyArray<Record<string, string>>;
        surfaces: ReadonlyArray<{ surface: string }>;
      };
      expect(usage.complete).toBe(false);
      expect(usage.unmeasured).toEqual([{ surface: "artifacts", reason: "surface_unreadable" }]);
      expect(usage.surfaces.map((s) => s.surface)).not.toContain("artifacts");
      const forecast = res.forecast as {
        tier: string;
        unmeasured: ReadonlyArray<{ surface: string }>;
      };
      expect(forecast.tier).toBe("unmeasurable");
      expect(forecast.unmeasured.map((u) => u.surface)).toEqual(["artifacts"]);
    } finally {
      chmodSync(join(vault, "Brain", ".artifacts"), 0o755);
    }
  });

  test("a server's own config moves the measured store with its search_db_path", async () => {
    // The process env still names the default config; only the server's
    // configPath points the store elsewhere, so a census that ignored it
    // would measure the absent default store as zero.
    const altDb = join(configHome, "alt-index.sqlite");
    writeFileSync(altDb, "x".repeat(12_345), "utf8");
    const altConfig = join(configHome, "alt.yaml");
    atomicWriteFileSync(altConfig, `vault: ${vault}\nsearch_db_path: ${altDb}\n`);
    const res = (await storage({ ...ctx, configPath: altConfig }, {})) as ReportJson;
    const surfaces = (res.usage as { surfaces: ReadonlyArray<{ surface: string; bytes: number }> })
      .surfaces;
    expect(surfaces.find((s) => s.surface === "derived_store")?.bytes).toBe(12_345);
  });

  test("a vault with no brain config surfaces the named config error", async () => {
    const bare = mkdtempSync(join(tmpdir(), "o2b-mcp-storage-bare-"));
    try {
      const bareCtx: ServerContext = {
        vault: bare,
        configPath: null,
        repoRoot: null,
        reach: TRANSPORT_REACH.local,
      };
      expect(async () => storage(bareCtx, {})).toThrow(/config file does not exist/);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  test("the tool declares a bounded, described schema", () => {
    const def = STORAGE_TOOLS.find((tool) => tool.name === "brain_storage")!;
    expect(def.inputSchema["additionalProperties"]).toBe(false);
    expect(def.previewBudget).toBeDefined();
  });

  test("the description states the sample side effect beside the read-only claim", () => {
    const def = STORAGE_TOOLS.find((tool) => tool.name === "brain_storage")!;
    // A bare "Read-only." would contradict the one append every local
    // call makes: the description names both halves of the contract.
    expect(def.description).toContain("Read-only over vault content");
    expect(def.description).toContain("appends one usage sample");
    expect(def.description.length).toBeLessThanOrEqual(300);
  });
});
