/**
 * `brain_storage` (storage-lifecycle, Lane 1 task 1.7).
 *
 * Claims pinned here:
 *
 *   1. The tool and `o2b brain storage` derive from one builder: driven
 *      on the same vault state, their reports are equal on every field
 *      except the two per-invocation identity fields (`usage.measuredAt`
 *      and `sample.runId`). No flag-or-property exclusion list is needed
 *      because the payload IS the shared source.
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
    // Only the per-invocation identity fields may differ: the stamp the
    // census took and the run id the sample was recorded under.
    expect(differingPaths(fromVerb, report).toSorted()).toEqual([
      "sample.runId",
      "usage.measuredAt",
    ]);
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
});
