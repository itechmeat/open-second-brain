/**
 * The snapshot gate on a machine switched to the brain store (task 2.10,
 * design D14 item 1): the archive and its `.snapshots/` folder are machine
 * state, so they land in the device-local state, no byte is written under
 * the vault, two snapshots taken in the same second still get distinct
 * run ids, and the listing finds both. The unswitched cases live in
 * `snapshot-gate-coverage.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";

import { listSnapshots } from "../../../src/core/brain/snapshot.ts";
import { takeSnapshot } from "../../../src/core/brain/snapshot-gate.ts";
import { BRAIN_SNAPSHOT_REASON } from "../../../src/core/brain/types.ts";
import { digestVaultTree } from "../../helpers/vault-digest.ts";
import { makeStoreEnv, type StoreEnv } from "../store/fixtures/store-env.ts";
import { switchDevice } from "./store-only/fixtures.ts";

const NOW = new Date("2026-11-06T12:00:00Z");

let env: StoreEnv;

beforeEach(() => {
  env = makeStoreEnv("osb-snapshot-store-only-");
  switchDevice(env.storeRoot);
});

afterEach(() => env.cleanup());

describe("snapshots on a switched machine", () => {
  test("land in the device-local state, never under the vault, and collide onto a new id", () => {
    const before = digestVaultTree(env.vault);
    const first = takeSnapshot(env.vault, BRAIN_SNAPSHOT_REASON.dream, { now: NOW });
    const second = takeSnapshot(env.vault, BRAIN_SNAPSHOT_REASON.dream, { now: NOW });
    expect(second.runId).not.toBe(first.runId);
    for (const snap of [first, second]) {
      expect(existsSync(snap.path)).toBe(true);
      expect(snap.path.startsWith(env.vault)).toBe(false);
      expect(snap.path.startsWith(env.parent)).toBe(true);
    }
    expect(digestVaultTree(env.vault)).toBe(before);
    const listed = listSnapshots(env.vault).snapshots.map((s) => s.run_id);
    expect(listed).toEqual(expect.arrayContaining([first.runId, second.runId]));
  });
});
