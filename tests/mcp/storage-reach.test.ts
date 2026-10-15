/**
 * `brain_storage` at the caller's reach (storage-lifecycle, Lane 1
 * task 1.7).
 *
 * The usage census is a whole-vault byte figure: it counts every page,
 * withheld pages included, so its totals move when a page the caller may
 * not read appears or goes, and no filtered form of it exists. Below
 * local reach the number is therefore not taken at all - the
 * `link_integrity` model (`brain_hygiene`): the report answers
 * `measured: false` with the named reason, and no usage sample is
 * recorded, because the sample would require taking the very census the
 * reach refusal withholds.
 *
 * Claims pinned here:
 *
 *   1. A remote caller gets the named reach refusal, never bytes.
 *   2. A remote call records no usage sample.
 *   3. A hand-built context that established nothing answers at the
 *      narrowest reach (fail closed): refused, not measured.
 *   4. At local reach the same tool measures.
 *   5. The doctor's storage-capacity check answers by the same rule
 *      through `brain_doctor`: below local reach the fullness is
 *      uncertain by name and no tier issue - either would carry the
 *      census in its message - is emitted; at local reach it measures.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { resetVaultIdentityPins } from "../../src/core/brain/vault-identity.ts";
import {
  STORAGE_CAPACITY_CRITICAL_CODE,
  STORAGE_CAPACITY_UNMEASURED_CODE,
  STORAGE_CAPACITY_WARN_CODE,
} from "../../src/core/brain/doctor/storage-capacity.ts";
import { listMetrics, type MetricRecord } from "../../src/core/brain/metrics.ts";
import { STORAGE_USAGE_METRIC_SURFACE } from "../../src/core/brain/storage/forecast.ts";
import { brainConfigPath } from "../../src/core/brain/paths.ts";
import { TRANSPORT_REACH } from "../../src/core/graph/transport-reach.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { HEALTH_TOOLS } from "../../src/mcp/brain/health-tools.ts";
import { STORAGE_REACH_REASON, STORAGE_TOOLS } from "../../src/mcp/brain/storage-tools.ts";
import type { ServerContext } from "../../src/mcp/tool-contract.ts";

const storage = STORAGE_TOOLS.find((tool) => tool.name === "brain_storage")!.handler;
const doctor = HEALTH_TOOLS.find((tool) => tool.name === "brain_doctor")!.handler;

let vault: string;
let configHome: string;
let ctx: ServerContext;

beforeEach(() => {
  resetVaultIdentityPins();
  vault = mkdtempSync(join(tmpdir(), "o2b-storage-reach-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-storage-reach-cfg-"));
  atomicWriteFileSync(join(configHome, "config.yaml"), `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath: join(configHome, "config.yaml") });
  ctx = { vault, configPath: join(configHome, "config.yaml"), repoRoot: null };
});

afterEach(() => {
  resetVaultIdentityPins();
  rmSync(vault, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  rmSync(configHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function usageSamples(): MetricRecord[] {
  return listMetrics(vault, { surface: STORAGE_USAGE_METRIC_SURFACE });
}

describe("brain_storage at the caller's reach", () => {
  test("below local reach the census is not taken and the refusal is named", async () => {
    const res = (await storage({ ...ctx, reach: TRANSPORT_REACH.remote }, {})) as Record<
      string,
      unknown
    >;
    expect(res["measured"]).toBe(false);
    expect(res["reason"]).toBe(STORAGE_REACH_REASON);
    expect(String(res["detail"])).toContain("local reach");
  });

  test("the refusal carries no vault bytes and no vault path", async () => {
    const res = (await storage({ ...ctx, reach: TRANSPORT_REACH.remote }, {})) as Record<
      string,
      unknown
    >;
    const rendered = JSON.stringify(res);
    expect(rendered).not.toContain("total_bytes");
    expect(rendered).not.toContain(vault);
    expect(res["usage"]).toBeUndefined();
    expect(res["forecast"]).toBeUndefined();
    expect(res["sample"]).toBeUndefined();
  });

  test("a refused call records no usage sample", async () => {
    await storage({ ...ctx, reach: TRANSPORT_REACH.remote }, {});
    expect(usageSamples()).toHaveLength(0);
  });

  test("a context that established nothing answers at the narrowest reach", async () => {
    // No `reach` field: a hand-built context proved nothing about who is
    // asking, so the tool must not treat it as local.
    const res = (await storage(ctx, {})) as Record<string, unknown>;
    expect(res["measured"]).toBe(false);
    expect(res["reason"]).toBe(STORAGE_REACH_REASON);
    expect(usageSamples()).toHaveLength(0);
  });

  test("at local reach the same tool measures and samples", async () => {
    const res = (await storage({ ...ctx, reach: TRANSPORT_REACH.local }, {})) as Record<
      string,
      unknown
    >;
    expect(res["measured"]).toBe(true);
    expect(usageSamples()).toHaveLength(1);
  });
});

describe("the doctor's storage-capacity check at the caller's reach", () => {
  function configureCappedVaultPastCritical(): void {
    writeFileSync(
      brainConfigPath(vault),
      "schema_version: 1\n\nstorage:\n  cap_bytes: 10000\n",
      "utf8",
    );
    mkdirSync(join(vault, "Brain", "sources"), { recursive: true });
    writeFileSync(join(vault, "Brain", "sources", "AA-page.md"), "x".repeat(20_000), "utf8");
  }

  test("below local reach the fullness is uncertain by name, never measured", async () => {
    configureCappedVaultPastCritical();
    const res = (await doctor({ ...ctx, reach: TRANSPORT_REACH.remote }, {})) as Record<
      string,
      unknown
    >;
    const rendered = JSON.stringify(res);
    // Neither tier issue is emitted: each would carry the whole-vault
    // census in its message prose.
    expect(rendered).not.toContain(STORAGE_CAPACITY_WARN_CODE);
    expect(rendered).not.toContain(STORAGE_CAPACITY_CRITICAL_CODE);
    const unmeasured = ((res["uncertain"] as ReadonlyArray<Record<string, unknown>>) ?? []).filter(
      (entry) => entry["code"] === STORAGE_CAPACITY_UNMEASURED_CODE,
    );
    expect(unmeasured).toHaveLength(1);
    expect(String(unmeasured[0]!["message"])).toContain("reach");
  });

  test("at local reach the same tool reports the tier it measures", async () => {
    configureCappedVaultPastCritical();
    const res = (await doctor({ ...ctx, reach: TRANSPORT_REACH.local }, {})) as Record<
      string,
      unknown
    >;
    const rendered = JSON.stringify(res);
    expect(rendered).toContain(STORAGE_CAPACITY_CRITICAL_CODE);
  });
});
