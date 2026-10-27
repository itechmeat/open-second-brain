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
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { resetVaultIdentityPins } from "../../src/core/brain/vault-identity.ts";
import { MAINTENANCE_VERDICT, appendJournal } from "../../src/core/brain/maintenance/journal.ts";
import { TRANSPORT_REACH, type TransportReach } from "../../src/core/graph/transport-reach.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { resolveSearchConfig } from "../../src/core/search/index.ts";
import { ADMIN_TOOLS } from "../../src/mcp/brain/admin-tools.ts";
import { HEALTH_TOOLS } from "../../src/mcp/brain/health-tools.ts";
import type { ServerContext } from "../../src/mcp/tool-contract.ts";

const maintenance = ADMIN_TOOLS.find((tool) => tool.name === "brain_maintenance")!.handler;
const brainStatus = HEALTH_TOOLS.find((tool) => tool.name === "brain_status")!.handler;

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

describe("brain_status store group at the caller's reach (t_cfe2ce5d)", () => {
  interface StoreGroup {
    readonly writerLock: string;
    readonly writerLockReason: string | null;
    readonly writerLockAgeMs: number | null;
    readonly writerLockOwner: string | null;
    readonly writerLockPath: string | null;
    readonly thisCaller: string;
  }

  async function statusStore(reach: TransportReach): Promise<StoreGroup> {
    const res = (await brainStatus({ ...ctx, reach }, {})) as Record<string, unknown>;
    return res["store"] as StoreGroup;
  }

  test("the payload carries the store group at both reaches, with the state fields intact", async () => {
    for (const reach of [TRANSPORT_REACH.local, TRANSPORT_REACH.remote]) {
      const store = await statusStore(reach);
      expect(store.writerLock).toBe("free");
      expect(store.writerLockReason).toBeNull();
      expect(store.writerLockOwner).toBeNull();
      expect(store.thisCaller).toBe("read-only");
    }
  });

  test("the lock path is withheld below local reach", async () => {
    const local = await statusStore(TRANSPORT_REACH.local);
    // The lock rides the resolved index path, which is inside the vault here.
    expect(typeof local.writerLockPath).toBe("string");

    const remote = await statusStore(TRANSPORT_REACH.remote);
    // The path may live outside the vault (the resolved index path is a
    // host path), so below local reach it reads null while every state
    // field stays - the same split `state_files.search_index` boolean makes.
    expect(remote.writerLockPath).toBeNull();
    expect(remote.writerLock).toBe("free");
  });

  test("below local reach a failed lock probe keeps the errno but not the host path", async () => {
    // A lock path that cannot even be stat'd: a symlink loop where the
    // lock directory would sit. `isWriterLockHeld`'s contract names this
    // throw shape (ELOOP, beside the EACCES the audit quotes) and the
    // snapshot reads it `unknown` with the reason carrying the fs error -
    // whose message embeds the full host path.
    const lockPath = `${resolveSearchConfig({ vault, configPath: ctx.configPath ?? undefined }).dbPath}.lock`;
    mkdirSync(dirname(lockPath), { recursive: true });
    symlinkSync(lockPath, lockPath);

    // At local reach the reason is the operator's own diagnostic: the
    // errno and the path the probe failed on, verbatim.
    const local = await statusStore(TRANSPORT_REACH.local);
    expect(local.writerLock).toBe("unknown");
    expect(local.writerLockReason).toContain("ELOOP");
    expect(local.writerLockReason).toContain(lockPath);

    // Below local reach the errno keeps - "I could not find out, and
    // here is why" - while the host path goes the way every other error
    // leaving the process goes: through the redactor.
    const remote = await statusStore(TRANSPORT_REACH.remote);
    expect(remote.writerLock).toBe("unknown");
    expect(remote.writerLockReason).toContain("ELOOP");
    expect(remote.writerLockReason).not.toContain(lockPath);
    expect(remote.writerLockReason).not.toContain(tmpdir());
    expect(remote.writerLockPath).toBeNull();
  });
});
