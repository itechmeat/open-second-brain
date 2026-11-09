/**
 * The migration dry run (task 2.2) over a fixture vault with the real
 * legacy layout shapes: it lists the device roster, counts per surface
 * with the partition each item would land in, every unparseable item and
 * every unmapped entry, and it writes nothing.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";

import {
  planMigrationDryRun,
  type MigrationDryRun,
  type SurfaceReport,
} from "../../../src/core/store-migration/dry-run.ts";
import { makeLegacyVault, type LegacyVaultFixture } from "./fixtures/legacy-vault.ts";
import { makeMigrationBench, type MigrationBench } from "./fixtures/migration-env.ts";
import { digestVaultTree } from "../../helpers/vault-digest.ts";

let fx: LegacyVaultFixture;
let plan: MigrationDryRun;

function surface(id: string): SurfaceReport {
  const found = plan.surfaces.find((s) => s.id === id);
  if (found === undefined) throw new Error(`no surface ${id} in the report`);
  return found;
}

describe("planMigrationDryRun", () => {
  beforeEach(() => {
    fx = makeLegacyVault();
    plan = planMigrationDryRun(fx.vault);
  });
  afterEach(() => fx.cleanup());

  test("names every device in legacy shard names, and the roster of the last 30 days", () => {
    expect(plan.devices.cohort.map((d) => d.device)).toEqual(["dev-a", "dev-b", "dev-c"]);
    expect(plan.devices.roster).toEqual(["dev-a", "dev-b"]);
    expect(plan.devices.cohort.find((d) => d.device === "dev-c")?.in_roster).toBe(false);
    expect(plan.devices.unsharded_files).toBe(1);
  });

  test("counts log events per partition and reports the malformed line with its path", () => {
    const log = surface("brain_log");
    expect(log.items).toBe(5);
    expect(log.partitions).toEqual({ shared: 4, private: 1, "private-when-held": 0 });
    expect(log.unparseable).toBe(1);
    expect(plan.unparseable).toContainEqual({
      surface: "brain_log",
      path: "Brain/log/2026-11-01.dev-b.jsonl",
      line: 2,
      reason: "not JSON",
    });
    expect(log.planned).toContain("stream log (log-event)");
  });

  test("routes private pages and the records that name them to private", () => {
    expect(surface("preferences").partitions).toEqual({
      shared: 2,
      private: 1,
      "private-when-held": 0,
    });
    expect(surface("pinned_context").partitions?.private).toBe(1);
    expect(surface("pref_audit").partitions?.private).toBe(1);
    expect(surface("signals").items).toBe(3);
  });

  test("states the planned destination of non-stream surfaces", () => {
    expect(surface("secret_custody").destination.to).toBe("backup");
    expect(surface("secret_custody").present).toBe(true);
    expect(surface("search_index").destination.to).toBe("device-local");
    expect(surface("log_day_pages").destination.to).toBe("drop");
    expect(surface("log_day_pages").items).toBe(1);
    expect(surface("hook_audit").partitions?.["private-when-held"]).toBe(1);
  });

  test("lists every entry no mapping covers and fails the plan", () => {
    expect(plan.unmapped).toEqual([
      { path: "Brain/log/2026-11-01.sync-conflict-20261101-120000-ABC.jsonl", type: "file" },
      { path: "Brain/log/stray.txt", type: "file" },
      { path: "Brain/procedures/index.bin", type: "file" },
    ]);
    expect(plan.ok).toBe(false);
    expect(plan.totals.unmapped).toBe(3);
  });

  test("operating-system metadata files are never unmapped entries", () => {
    for (const rel of [
      "Brain/.DS_Store",
      "Brain/inbox/.DS_Store",
      "Brain/procedures/Thumbs.db",
      "Brain/log/desktop.ini",
      "Brain/empty-lane/.gitkeep",
    ]) {
      fx.write(rel, "meta");
    }
    expect(planMigrationDryRun(fx.vault).unmapped.map((u) => u.path)).toEqual([
      "Brain/log/2026-11-01.sync-conflict-20261101-120000-ABC.jsonl",
      "Brain/log/stray.txt",
      "Brain/procedures/index.bin",
    ]);
  });

  test("a writer's atomic temp file is never an unmapped entry", () => {
    // `.<target>.<pid>.<ms>.<hex>.tmp`: an atomic write in flight while the
    // migration walks the tree; the delta pass imports what it becomes.
    fx.write("Brain/inbox/.sig-2026-11-06-wc-15.md.5662.1794166644414.b6642d26b8a8f8.tmp", "x");
    expect(planMigrationDryRun(fx.vault).unmapped.map((u) => u.path)).toEqual([
      "Brain/log/2026-11-01.sync-conflict-20261101-120000-ABC.jsonl",
      "Brain/log/stray.txt",
      "Brain/procedures/index.bin",
    ]);
  });

  test("passes once every entry has a destination", () => {
    const clean = makeLegacyVault("osb-legacy-clean-");
    try {
      for (const rel of [
        "Brain/log/2026-11-01.sync-conflict-20261101-120000-ABC.jsonl",
        "Brain/log/stray.txt",
        "Brain/procedures/index.bin",
      ]) {
        rmSync(join(clean.vault, ...rel.split("/")), { recursive: true });
      }
      const result = planMigrationDryRun(clean.vault);
      expect(result.unmapped).toEqual([]);
      expect(result.ok).toBe(true);
    } finally {
      clean.cleanup();
    }
  });

  test("record lanes become lane entries, standing rules included", () => {
    const lanes = surface("record_lanes");
    expect(lanes.destination).toMatchObject({ to: "stream", kind: "lane-entry" });
    expect(lanes.items).toBe(2); // procedures/deploy, obligations/archive/obl-old
    expect(lanes.partitions).toEqual({ shared: 1, private: 1, "private-when-held": 0 });
    expect(surface("standing_rules").items).toBe(2);
    expect(surface("exact_state").items).toBe(1);
  });
});

describe("the dry run writes nothing", () => {
  let bench: MigrationBench;
  beforeEach(() => {
    // Every root a run could write under one parent: the vault, HOME, the
    // config, the device-local state and data dirs, and the store.
    bench = makeMigrationBench("osb-dry-run-");
  });
  afterEach(() => bench.cleanup());

  test("the vault, the device-local state, the data dir, the config and the store are unchanged", () => {
    // Hashed before the FIRST call: nothing a first run creates is in it.
    const before = digestVaultTree(bench.fx.parent, { mtime: true });
    const first = planMigrationDryRun(bench.vault);
    expect(first.ok).toBe(true);
    expect(first.surfaces.length).toBeGreaterThan(0);
    expect(digestVaultTree(bench.fx.parent, { mtime: true })).toBe(before);
  });
});
