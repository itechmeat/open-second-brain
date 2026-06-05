/**
 * Safeguard wiring (t_06784b8d): every long-running operation accepts
 * an optional Safeguard and aborts cleanly at a checkpoint once the
 * deadline passes. A tripped guard (deadline already exceeded at the
 * first checkpoint) must stop each operation with
 * SafeguardTimeoutError; an absent guard changes nothing.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dream } from "../../../src/core/brain/dream.ts";
import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { discoverBridges } from "../../../src/core/brain/link-graph/bridge-discovery.ts";
import { detectCommunities } from "../../../src/core/brain/link-graph/communities.ts";
import { runMaintenance } from "../../../src/core/brain/maintenance/lane.ts";
import { createSafeguard, SafeguardTimeoutError } from "../../../src/core/brain/safeguard.ts";
import { indexVault } from "../../../src/core/search/indexer.ts";
import { Store } from "../../../src/core/search/store.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";
import { makeConfig } from "../../helpers/search-fixtures.ts";

let tmp: string;
let vault: string;
let configPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-safeguard-wiring-"));
  vault = join(tmp, "vault");
  mkdirSync(vault, { recursive: true });
  configPath = join(tmp, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** A guard whose deadline has already passed at the first checkpoint. */
function trippedGuard(operation: string) {
  let calls = 0;
  return createSafeguard({
    operation,
    timeoutMs: 1,
    now: () => {
      calls += 1;
      return calls === 1 ? 0 : 1_000;
    },
  });
}

describe("indexVault", () => {
  test("aborts at a checkpoint under a tripped guard", async () => {
    writeFileSync(join(vault, "a.md"), "# A\n\nBody.\n");
    writeFileSync(join(vault, "b.md"), "# B\n\nBody.\n");
    const config = makeConfig({ vault, dbPath: join(tmp, "index.sqlite") });
    await expect(indexVault(config, { safeguard: trippedGuard("reindex") })).rejects.toThrow(
      SafeguardTimeoutError,
    );
  });

  test("absent guard indexes normally", async () => {
    writeFileSync(join(vault, "a.md"), "# A\n\nBody.\n");
    const config = makeConfig({ vault, dbPath: join(tmp, "index.sqlite") });
    const stats = await indexVault(config);
    expect(stats.added).toBe(1);
  });
});

describe("discoverBridges and detectCommunities", () => {
  test("both abort under a tripped guard", async () => {
    writeFileSync(join(vault, "a.md"), "# A\n\nSee [[b]].\n");
    writeFileSync(join(vault, "b.md"), "# B\n\nSee [[a]].\n");
    const config = makeConfig({ vault, dbPath: join(tmp, "index.sqlite") });
    await indexVault(config);
    const store = await Store.open(config, { mode: "read" });
    try {
      expect(() => discoverBridges(store, { safeguard: trippedGuard("bridges") })).toThrow(
        SafeguardTimeoutError,
      );
      expect(() => detectCommunities(store, { safeguard: trippedGuard("clusters") })).toThrow(
        SafeguardTimeoutError,
      );
    } finally {
      await store.close();
    }
  });
});

describe("dream", () => {
  test("aborts under a tripped guard", () => {
    bootstrapBrain(vault, { configPath });
    expect(() => dream(vault, { safeguard: trippedGuard("dream") })).toThrow(SafeguardTimeoutError);
  });
});

describe("maintenance lane", () => {
  test("a timed-out task is classified timed_out and the lane survives", async () => {
    bootstrapBrain(vault, { configPath });
    const result = await runMaintenance(vault, {
      now: new Date("2026-06-05T03:00:00Z"),
      holder: "test@1",
      force: true,
      tasks: [
        {
          name: "dream",
          run: async () => {
            trippedGuard("dream").checkpoint();
          },
        },
        {
          name: "reindex",
          run: async () => {},
        },
      ],
    });
    expect(result.verdict).toBe("run");
    const dreamTask = result.tasks.find((t) => t.name === "dream")!;
    expect(dreamTask.ok).toBe(false);
    expect(dreamTask.timed_out).toBe(true);
    const reindexTask = result.tasks.find((t) => t.name === "reindex")!;
    expect(reindexTask.ok).toBe(true);
    expect(reindexTask.timed_out).toBeUndefined();
  });

  test("oversized task error strings are capped with a marker", async () => {
    bootstrapBrain(vault, { configPath });
    const result = await runMaintenance(vault, {
      now: new Date("2026-06-05T03:00:00Z"),
      holder: "test@1",
      force: true,
      tasks: [
        {
          name: "dream",
          run: async () => {
            throw new Error("x".repeat(10_000));
          },
        },
      ],
    });
    const task = result.tasks[0]!;
    expect(task.ok).toBe(false);
    expect(task.error!.length).toBeLessThan(5_000);
    expect(task.error).toContain("truncated");
  });
});
