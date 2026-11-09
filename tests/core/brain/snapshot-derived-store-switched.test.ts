/**
 * Snapshots on a switched machine: the archive of the tree lives in the
 * device-local state, the live search index it covers is the one the
 * search layer opens for the real vault, and status counts the archives
 * where they are.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { createSnapshot } from "../../../src/core/brain/snapshot.ts";
import { takeSnapshot } from "../../../src/core/brain/snapshot-gate.ts";
import { computeBrainStatus } from "../../../src/core/brain/status.ts";
import { BRAIN_SNAPSHOT_REASON } from "../../../src/core/brain/types.ts";
import { resolveConfiguredIndexPath } from "../../../src/core/search/paths.ts";
import { makeStoreEnv, type StoreEnv } from "../store/fixtures/store-env.ts";
import { switchDevice } from "./store-only/fixtures.ts";

let env: StoreEnv;

beforeEach(() => {
  env = makeStoreEnv("osb-snapshot-derived-switched-");
  switchDevice(env.storeRoot);
});

afterEach(() => env.cleanup());

test("the live index of the real vault is the one archived", () => {
  const live = resolveConfiguredIndexPath(env.vault);
  mkdirSync(dirname(live), { recursive: true });
  const db = new Database(live);
  db.run("CREATE TABLE t (x INTEGER)");
  db.close();
  const result = createSnapshot(env.vault, "derived-switched", {
    reason: BRAIN_SNAPSHOT_REASON.dream,
    now: new Date("2026-11-06T12:00:00Z"),
    derivedStore: { include: true, maxBytes: 64 * 1024 * 1024 },
  });
  expect(result.path.startsWith(env.vault)).toBe(false);
  expect(result.derived_store.included).toBe(true);
  expect(result.derived_store.source_path).toBe(live);
});

test("status counts the snapshots the switched machine took", () => {
  takeSnapshot(env.vault, BRAIN_SNAPSHOT_REASON.dream, { now: new Date("2026-11-06T12:00:00Z") });
  expect(computeBrainStatus(env.vault).counts.snapshots).toBe(1);
});
