/**
 * The store-only predicate honours a rollback (task 2.6): a device that
 * switched reads store-only, and after its `device-unswitched` record and
 * the marker clearing it reads legacy again, in the same process too.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { processDirsEnv } from "../../../src/core/platform-dirs.ts";
import { storeOnlyMode } from "../../../src/core/store/store-only.ts";
import { withLocalLock } from "../../../src/core/store/local-lock.ts";
import { storesStateDir } from "../../../src/core/store/store-paths.ts";
import { runMigration } from "../../../src/core/store-migration/migrate.ts";
import { rollback } from "../../../src/core/store-migration/outcome.ts";
import { storeOnlyModeInFreshProcess } from "../../helpers/fresh-process.ts";
import { makeFleet, type Fleet } from "./fixtures/fleet.ts";

let fleet: Fleet | null = null;
afterEach(() => {
  fleet?.cleanup();
  fleet = null;
});

test("a rolled-back device is no longer store-only, and its sticky marker is gone", () => {
  fleet = makeFleet(["dev-a"]);
  const a = fleet.machine("dev-a");
  a.use();
  expect(runMigration(a.vault, { settleMs: 0 }).ok).toBe(true);
  expect(storeOnlyMode({ vault: a.vault })).toMatchObject({
    storeOnly: true,
    reason: "device-switched",
  });
  const marker = join(storesStateDir(processDirsEnv()), "store-only.json");
  expect(readFileSync(marker, "utf8")).toContain('"device": "dev-a"');

  rollback(a.vault);
  expect(storeOnlyMode({ vault: a.vault })).toMatchObject({ storeOnly: false, reason: "legacy" });
  expect(existsSync(marker) ? readFileSync(marker, "utf8") : "").not.toContain('"device": "dev-a"');
});

test("a rollback whose marker cannot be cleared fails instead of reporting success", () => {
  fleet = makeFleet(["dev-a"]);
  const a = fleet.machine("dev-a");
  a.use();
  expect(runMigration(a.vault, { settleMs: 0 }).ok).toBe(true);
  // A store-only answer makes the switch sticky in the marker.
  expect(storeOnlyMode({ vault: a.vault }).storeOnly).toBe(true);
  const marker = join(storesStateDir(processDirsEnv()), "store-only.json");
  const prior = process.env["OPEN_SECOND_BRAIN_LOCK_WAIT_MS"];
  process.env["OPEN_SECOND_BRAIN_LOCK_WAIT_MS"] = "50";
  try {
    // Another process holds the marker's lock past the wait budget.
    withLocalLock(marker, () => {
      expect(() => rollback(a.vault)).toThrow(/busy/);
    });
  } finally {
    if (prior === undefined) delete process.env["OPEN_SECOND_BRAIN_LOCK_WAIT_MS"];
    else process.env["OPEN_SECOND_BRAIN_LOCK_WAIT_MS"] = prior;
  }
  expect(readFileSync(marker, "utf8")).toContain('"device": "dev-a"');
  // Run again once the lock is free, the rollback finishes.
  rollback(a.vault);
  expect(readFileSync(marker, "utf8")).not.toContain('"device": "dev-a"');
});

/** Every shard file of the `settings` stream of `shared` on `root`. */
function settingsShards(root: string): string[] {
  const dir = join(root, "shared", "settings");
  return readdirSync(dir, { recursive: true })
    .map((rel) => join(dir, String(rel)))
    .filter((path) => path.endsWith(".jsonl"));
}

describe("the switch is sticky per machine", () => {
  for (const [label, spoil] of [
    ["absent", (path: string) => rmSync(path)],
    ["unreadable", (path: string) => writeFileSync(path, "{ torn\n")],
  ] as const) {
    test(`a fresh process stays store-only while the settings shard is ${label}`, () => {
      fleet = makeFleet(["dev-a"]);
      const a = fleet.machine("dev-a");
      a.use();
      expect(runMigration(a.vault, { settleMs: 0 }).ok).toBe(true);
      // No store-only question was asked yet: the migration itself must
      // have recorded the switch on this machine.
      const shards = settingsShards(a.storeRoot);
      expect(shards.length).toBeGreaterThan(0);
      for (const shard of shards) spoil(shard);
      expect(storeOnlyModeInFreshProcess(a.vault)).toEqual({
        storeOnly: true,
        reason: "device-switched",
      });
    });
  }

  test("a switched machine refuses a second migration while its settings shard is absent", () => {
    fleet = makeFleet(["dev-a"]);
    const a = fleet.machine("dev-a");
    a.use();
    expect(runMigration(a.vault, { settleMs: 0 }).ok).toBe(true);
    for (const shard of settingsShards(a.storeRoot)) rmSync(shard);
    expect(() => runMigration(a.vault, { settleMs: 0 })).toThrow(/already switched/);
  });
});
