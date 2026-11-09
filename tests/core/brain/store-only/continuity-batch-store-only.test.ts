/**
 * A continuity batch on a store-only machine (task 2.10): one privacy
 * verdict for the whole batch, so its rows land in one partition, and a
 * machine that holds only `shared` refuses a batch with a private record
 * before any row is appended. With no vault the batch writer still works,
 * and the store read keeps only the asked window.
 */
import { afterEach, describe, expect, test } from "bun:test";

import {
  appendContinuityRecords,
  listContinuityRecords,
} from "../../../../src/core/brain/continuity/store.ts";
import { makeStoreEnv, type StoreEnv } from "../../store/fixtures/store-env.ts";
import { ledgerRows, partitionRecords, switchDevice } from "./fixtures.ts";

let env: StoreEnv | undefined;
afterEach(() => {
  env?.cleanup();
  env = undefined;
});

const row = (n: number, createdAt: string, extra: { private?: boolean } = {}) => ({
  kind: "recall_telemetry" as const,
  createdAt,
  payload: { n },
  ...extra,
});

describe("a continuity batch once switched", () => {
  test("a batch with one private record lands whole in private", () => {
    env = makeStoreEnv("osb-continuity-batch-", { dualWrite: false });
    switchDevice(env.storeRoot);
    appendContinuityRecords(env.vault, [
      row(1, "2026-06-01T10:00:00.000Z"),
      row(2, "2026-06-01T10:00:01.000Z", { private: true }),
    ]);
    expect(ledgerRows(env.storeRoot, "shared", "continuity")).toEqual([]);
    expect(ledgerRows(env.storeRoot, "private", "continuity")).toHaveLength(2);
  });

  test("a machine without private refuses the batch before appending any row", () => {
    env = makeStoreEnv("osb-continuity-batch-shared-", {
      dualWrite: false,
      partitions: ["shared"],
    });
    switchDevice(env.storeRoot);
    expect(() =>
      appendContinuityRecords(env!.vault, [
        row(1, "2026-06-01T10:00:00.000Z"),
        row(2, "2026-06-01T10:00:01.000Z", { private: true }),
      ]),
    ).toThrow();
    expect(
      partitionRecords(env.storeRoot, "shared").filter((r) => r.kind === "ledger-row"),
    ).toEqual([]);
  });

  test("with no vault the batch is appended and read back in its window", () => {
    env = makeStoreEnv("osb-continuity-batch-novault-", {
      dualWrite: false,
      legacyTree: false,
      configureVault: false,
    });
    appendContinuityRecords(null, [
      row(1, "2026-05-31T10:00:00.000Z"),
      row(2, "2026-06-01T10:00:00.000Z"),
    ]);
    const inJune = listContinuityRecords(null, { since: "2026-06-01T00:00:00.000Z" });
    expect(inJune.map((r) => r.payload["n"])).toEqual([2]);
  });
});
