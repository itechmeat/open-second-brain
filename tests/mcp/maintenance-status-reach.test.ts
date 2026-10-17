/**
 * `brain_maintenance status` at the caller's reach (storage-lifecycle
 * self-review).
 *
 * A `skipped:capacity` journal row carries the reading behind the skip:
 * the whole-vault measured bytes, the configured cap and the percent of
 * one against the other. Those are the same local-reach facts the
 * storage report refuses to take below local reach and the ingest
 * admission refusal strips from its envelope - totals that move when a
 * page the caller may not read appears or goes, handed to a remote
 * caller as a growth oracle. The journal keeps them (it is the
 * operator's own record); the status answer renders them at local reach
 * only. The tier word and the unmeasurable reason stay at every reach:
 * they name a verdict, never a size.
 *
 * Claims pinned here:
 *
 *   1. Below local reach the status rows carry no capacity reading.
 *   2. At local reach the same rows carry it, so the operator's own
 *      surface loses nothing.
 *   3. A hand-built context that established nothing answers at the
 *      narrowest reach (fail closed): no reading.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { resetVaultIdentityPins } from "../../src/core/brain/vault-identity.ts";
import { MAINTENANCE_VERDICT, appendJournal } from "../../src/core/brain/maintenance/journal.ts";
import { TRANSPORT_REACH, type TransportReach } from "../../src/core/graph/transport-reach.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { ADMIN_TOOLS } from "../../src/mcp/brain/admin-tools.ts";
import type { ServerContext } from "../../src/mcp/tool-contract.ts";

const maintenance = ADMIN_TOOLS.find((tool) => tool.name === "brain_maintenance")!.handler;

let vault: string;
let configHome: string;
let ctx: ServerContext;

beforeEach(() => {
  resetVaultIdentityPins();
  vault = mkdtempSync(join(tmpdir(), "o2b-maint-status-reach-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-maint-status-reach-cfg-"));
  atomicWriteFileSync(join(configHome, "config.yaml"), `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath: join(configHome, "config.yaml") });
  ctx = { vault, configPath: join(configHome, "config.yaml"), repoRoot: null };
  appendJournal(vault, {
    ts: "2026-10-15T12:00:00Z",
    holder: "worker-a",
    verdict: MAINTENANCE_VERDICT.skippedCapacity,
    capacity_tier: "critical",
    capacity_percent: 96.4,
    capacity_measured_bytes: 482_113,
    capacity_cap_bytes: 500_000,
  });
});

afterEach(() => {
  resetVaultIdentityPins();
  rmSync(vault, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  rmSync(configHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

interface StatusRow {
  readonly verdict: string;
  readonly capacity_tier?: string;
  readonly capacity_percent?: number;
  readonly capacity_measured_bytes?: number;
  readonly capacity_cap_bytes?: number;
}

async function statusRows(reach: TransportReach): Promise<ReadonlyArray<StatusRow>> {
  const res = (await maintenance({ ...ctx, reach }, { operation: "status" })) as Record<
    string,
    unknown
  >;
  return res["journal"] as ReadonlyArray<StatusRow>;
}

describe("brain_maintenance status at the caller's reach", () => {
  test("below local reach the rows carry the verdict, never the reading", async () => {
    const rows = await statusRows(TRANSPORT_REACH.remote);
    const row = rows.find((e) => e.verdict === MAINTENANCE_VERDICT.skippedCapacity)!;
    expect(row).toBeDefined();
    expect(row.capacity_tier).toBe("critical");
    expect(row.capacity_percent).toBeUndefined();
    expect(row.capacity_measured_bytes).toBeUndefined();
    expect(row.capacity_cap_bytes).toBeUndefined();
  });

  test("at local reach the rows still carry the reading", async () => {
    const rows = await statusRows(TRANSPORT_REACH.local);
    const row = rows.find((e) => e.verdict === MAINTENANCE_VERDICT.skippedCapacity)!;
    expect(row.capacity_measured_bytes).toBe(482_113);
    expect(row.capacity_cap_bytes).toBe(500_000);
    expect(row.capacity_percent).toBe(96.4);
  });

  test("a context that established nothing answers at the narrowest reach", async () => {
    const rows = await statusRows(TRANSPORT_REACH.remote);
    const rendered = JSON.stringify(rows);
    expect(rendered).not.toContain("capacity_measured_bytes");
    expect(rendered).not.toContain("capacity_cap_bytes");
    expect(rendered).not.toContain("capacity_percent");
  });
});

describe("brain_maintenance status journal cursor pagination", () => {
  test("the input schema declares a described cursor property", () => {
    const schema = ADMIN_TOOLS.find((tool) => tool.name === "brain_maintenance")!.inputSchema as {
      properties: Record<string, { type?: string; maxLength?: number; description?: string }>;
    };
    expect(schema.properties["cursor"]).toMatchObject({ type: "string", maxLength: 32 });
    expect(schema.properties["cursor"]?.description).toBeTruthy();
  });

  test("the journal walks by cursor to exhaustion", async () => {
    for (const [index, holder] of ["worker-b", "worker-c", "worker-d"].entries()) {
      appendJournal(vault, {
        ts: `2026-10-15T12:0${index + 1}:00Z`,
        holder,
        verdict: MAINTENANCE_VERDICT.run,
      });
    }
    const total = 4;
    const limit = 2;
    // A server that never ends the walk would hang an unbounded loop;
    // ceil(total / limit) + 1 is one past the walk's own page count.
    const maxSteps = Math.ceil(total / limit) + 1;
    const walked: string[] = [];
    let cursor: string | null = null;
    for (let step = 0; step < maxSteps; step++) {
      const res = (await maintenance(
        { ...ctx },
        { operation: "status", limit, ...(cursor !== null ? { cursor } : {}) },
      )) as Record<string, unknown>;
      expect(res["journal_total"]).toBe(total);
      // Guard the walk protocol: an ignored cursor would loop forever.
      const next = res["next_cursor"];
      expect(next === null || typeof next === "string").toBe(true);
      walked.push(
        ...(res["journal"] as ReadonlyArray<Record<string, unknown>>).map(
          (entry) => entry["holder"] as string,
        ),
      );
      cursor = next as string | null;
      if (cursor === null) break;
    }
    // The walk ended because the server exhausted the set, not because
    // the step bound fired.
    expect(cursor).toBeNull();
    expect(walked.toSorted()).toEqual(["worker-a", "worker-b", "worker-c", "worker-d"]);
    expect(new Set(walked).size).toBe(4);
  });

  test("a malformed cursor is refused as invalid params", async () => {
    await expect(maintenance({ ...ctx }, { operation: "status", cursor: "!!!" })).rejects.toThrow(
      /malformed cursor/,
    );
  });
});
