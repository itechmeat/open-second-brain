/**
 * Recall telemetry away from the legacy tree (task 2.10, design D14 items
 * 1 and 16): on a switched machine a telemetry record reaches the store and
 * reads back through `listRecallTelemetry`, with no byte under the vault;
 * with no vault at all `emitRecallTelemetry(null, ...)` writes the store and
 * the record reads back the same. The unswitched cases live in
 * `recall-telemetry.test.ts`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { listContinuityRecords } from "../../../src/core/brain/continuity/store.ts";
import {
  emitRecallTelemetry,
  listRecallTelemetry,
  RECALL_CHANNEL,
} from "../../../src/core/brain/recall-telemetry.ts";
import { digestVaultTree } from "../../helpers/vault-digest.ts";
import { makeStoreEnv, type StoreEnv } from "../store/fixtures/store-env.ts";
import { partitionRecords, switchDevice } from "./store-only/fixtures.ts";

let env: StoreEnv | null = null;
afterEach(() => {
  env?.cleanup();
  env = null;
});

const INPUT = {
  host: "test",
  channel: RECALL_CHANNEL.cli,
  mode: "search" as const,
  status: "empty" as const,
  durationMs: 3,
  resultCount: 0,
  gaps: ["otter husbandry"],
  createdAt: "2026-11-05T09:00:00.000Z",
};

function storeRecordCount(e: StoreEnv): number {
  return (
    partitionRecords(e.storeRoot, "shared").length + partitionRecords(e.storeRoot, "private").length
  );
}

describe("recall telemetry on a switched machine", () => {
  test("lands in the store, reads back, and writes no byte under the vault", () => {
    env = makeStoreEnv("osb-recall-switched-");
    switchDevice(env.storeRoot);
    const before = digestVaultTree(env.vault);
    const records = storeRecordCount(env);
    const written = emitRecallTelemetry(env.vault, INPUT);
    expect(storeRecordCount(env)).toBe(records + 1);
    expect(listRecallTelemetry(env.vault).map((r) => r.id)).toEqual([written.id]);
    expect(listRecallTelemetry(env.vault)[0]!.payload["gaps"]).toEqual(["otter husbandry"]);
    expect(digestVaultTree(env.vault)).toBe(before);
  });
});

describe("recall telemetry with no vault", () => {
  test("emitRecallTelemetry(null) writes the store and reads back", () => {
    env = makeStoreEnv("osb-recall-novault-", { legacyTree: false, configureVault: false });
    const records = storeRecordCount(env);
    const written = emitRecallTelemetry(null, INPUT);
    expect(storeRecordCount(env)).toBe(records + 1);
    expect(listContinuityRecords(null, { kind: "recall_telemetry" }).map((r) => r.id)).toEqual([
      written.id,
    ]);
    expect(existsSync(join(env.vault, "Brain"))).toBe(false);
  });
});
