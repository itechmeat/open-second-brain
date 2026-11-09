/**
 * The store-only write path (task 2.10, design D14 item 1): on a switched
 * machine a write lands in the store only and writes no byte under the
 * vault's `Brain/`; a store failure fails the operation with its reason
 * and remedy; an unswitched machine keeps the phase 1 behaviour.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";

import { appendRecord } from "../../../src/core/store/appender.ts";
import { readDualWriteStatus } from "../../../src/core/store/dual-write.ts";
import { ledgerRowRecord } from "../../../src/core/store/dual-write-records.ts";
import type { StoreRecord } from "../../../src/core/store/envelope.ts";
import { withOperationPrivacy } from "../../../src/core/store/operation-scope.ts";
import * as reader from "../../../src/core/store/reader.ts";
import { readPartition } from "../../../src/core/store/state-digest.ts";
import {
  DEVICE_SWITCHED_KIND,
  isStoreOnly,
  storeOnlyMode,
} from "../../../src/core/store/store-only.ts";
import { openStore } from "../../../src/core/store/store-open.ts";
import { STORE_ROOT_ENV } from "../../../src/core/store/constants.ts";
import {
  readStoreWriteStatus,
  routeWrite,
  StoreWriteError,
  storeWrite,
} from "../../../src/core/store/store-write.ts";
import { digestVaultTree } from "../../helpers/vault-digest.ts";
import { makeStoreEnv, type StoreEnv } from "./fixtures/store-env.ts";
import { storeOnlyModeInFreshProcess } from "../../helpers/fresh-process.ts";

let env: StoreEnv | undefined;

afterEach(() => {
  env?.cleanup();
  env = undefined;
});

function storeRecords(root: string, partition: "shared" | "private"): StoreRecord[] {
  return readPartition(join(root, partition)).flatMap((shard) => shard.records);
}

function rowsOf(root: string, partition: "shared" | "private"): unknown[] {
  return storeRecords(root, partition)
    .filter((r) => r.kind === "ledger-row")
    .map((r) => r.body["row"]);
}

/** As the migration would on this machine: this device's own switch record. */
function switchDevice(root: string, device: string): void {
  appendRecord(openStore({ root, device }), {
    partition: "shared",
    stream: "settings",
    kind: DEVICE_SWITCHED_KIND,
    agent: "o2b",
    body: { authority: "human", device },
  });
}

function legacyWrite(vault: string): () => string {
  return () => {
    const path = join(vault, "Brain", "legacy-row.txt");
    writeFileSync(path, "legacy\n");
    return path;
  };
}

function routeMetricsRow(): unknown {
  return routeWrite({
    legacy: () => null,
    store: () => ledgerRowRecord("metrics", { n: 1 }, "shared"),
    context: { vault: null },
  });
}

describe("the store-only predicate", () => {
  test("an unswitched machine with a legacy tree is not store-only", () => {
    env = makeStoreEnv("osb-store-only-");
    expect(storeOnlyMode({ vault: env.vault })).toMatchObject({
      storeOnly: false,
      reason: "legacy",
    });
  });

  test("this device's own switch record makes it store-only; another device's does not", () => {
    env = makeStoreEnv("osb-store-only-");
    switchDevice(env.storeRoot, "dev-b");
    expect(isStoreOnly({ vault: env.vault })).toBe(false);
    switchDevice(env.storeRoot, "dev-a");
    expect(storeOnlyMode({ vault: env.vault })).toMatchObject({
      storeOnly: true,
      reason: "device-switched",
    });
  });

  test("a fresh install with no legacy tree, or no vault at all, is store-only", () => {
    env = makeStoreEnv("osb-store-only-", { legacyTree: false });
    expect(storeOnlyMode({ vault: env.vault })).toMatchObject({
      storeOnly: true,
      reason: "no-legacy-tree",
    });
    expect(storeOnlyMode({ vault: null })).toMatchObject({ storeOnly: true, vault: null });
  });

  test("the answer reads the settings shards only, however much else the store holds", () => {
    // Every write of a machine not (yet) switched asks this, several times.
    // Reading the whole shared partition to find a switch record made one
    // write cost as much as the store: every continuity row verified, per
    // call. The ledger rows below must not be read; the switch record is
    // still found.
    env = makeStoreEnv("osb-store-only-");
    const store = openStore({ root: env.storeRoot, device: "dev-a" });
    for (const ledger of ["continuity", "metrics"]) {
      for (let n = 0; n < 3; n++) {
        appendRecord(store, {
          partition: "shared",
          stream: "ledgers",
          ledger,
          kind: "ledger-row",
          agent: "o2b",
          body: { row: { n } },
        });
      }
    }
    switchDevice(env.storeRoot, "dev-b");
    const read: string[] = [];
    const readShard = reader.readShard;
    const spy = spyOn(reader, "readShard").mockImplementation((path, options) => {
      read.push(path);
      return readShard(path, options);
    });
    try {
      expect(isStoreOnly({ vault: env.vault })).toBe(false);
    } finally {
      spy.mockRestore();
    }
    expect(read.length).toBeGreaterThan(0);
    expect(read.filter((path) => !path.split(sep).includes("settings"))).toEqual([]);
    switchDevice(env.storeRoot, "dev-a");
    expect(isStoreOnly({ vault: env.vault })).toBe(true);
  });

  test("a machine seen switched stays switched while its store cannot be read", () => {
    env = makeStoreEnv("osb-store-only-");
    switchDevice(env.storeRoot, "dev-a");
    expect(isStoreOnly({ vault: env.vault })).toBe(true);
    writeFileSync(join(env.storeRoot, "shared", "store.json"), "{ torn");
    expect(isStoreOnly({ vault: env.vault })).toBe(true);
    // A process that never saw the switch answers from the sticky marker.
    expect(storeOnlyModeInFreshProcess(env.vault)).toEqual({
      storeOnly: true,
      reason: "device-switched",
    });
  });
});

describe("routeWrite on a store-only machine", () => {
  test("the record lands in the store and no byte is written under Brain/", () => {
    env = makeStoreEnv("osb-store-write-");
    switchDevice(env.storeRoot, "dev-a");
    const before = digestVaultTree(join(env.vault, "Brain"));
    const routed = routeWrite({
      legacy: legacyWrite(env.vault),
      store: () => ledgerRowRecord("metrics", { n: 1 }, "shared"),
      context: { vault: env.vault },
    });
    expect(routed.mode).toBe("store");
    expect(digestVaultTree(join(env.vault, "Brain"))).toBe(before);
    expect(rowsOf(env.storeRoot, "shared")).toEqual([{ n: 1 }]);
  });

  test("the store write needs no dual-write flag", () => {
    env = makeStoreEnv("osb-store-write-", { dualWrite: false, legacyTree: false });
    routeWrite({
      legacy: () => {
        throw new Error("legacy must not run");
      },
      store: () => ledgerRowRecord("metrics", { n: 2 }, "shared"),
      context: { vault: null },
    });
    expect(rowsOf(env.storeRoot, "shared")).toEqual([{ n: 2 }]);
  });

  test("the operation scope still places every record of a private operation in private", () => {
    env = makeStoreEnv("osb-store-write-", { legacyTree: false });
    withOperationPrivacy(true, () =>
      routeWrite({
        legacy: () => null,
        store: () => [
          ledgerRowRecord("metrics", { n: 3 }, "shared"),
          ledgerRowRecord("idempotency", { k: "x" }, "shared"),
        ],
        context: { vault: null },
      }),
    );
    expect(rowsOf(env.storeRoot, "shared")).toEqual([]);
    expect(rowsOf(env.storeRoot, "private")).toHaveLength(2);
    expect(rowsOf(env.storeRoot, "private")).toContainEqual({ n: 3 });
    expect(rowsOf(env.storeRoot, "private")).toContainEqual({ k: "x" });
  });

  test("no store fails the operation with the init remedy", () => {
    env = makeStoreEnv("osb-store-write-", { legacyTree: false, partitions: [] });
    expect(routeMetricsRow).toThrow(StoreWriteError);
    try {
      routeMetricsRow();
    } catch (err) {
      expect((err as StoreWriteError).reason).toBe("no-store");
      expect((err as Error).message).toContain("o2b store init");
    }
  });

  test("no device id fails the operation with the device remedy", () => {
    env = makeStoreEnv("osb-store-write-", { legacyTree: false });
    process.env["O2B_DEVICE_ID"] = "";
    try {
      storeWrite(() => ledgerRowRecord("metrics", { n: 1 }, "shared"), { vault: null });
      throw new Error("expected a refusal");
    } catch (err) {
      expect(err).toBeInstanceOf(StoreWriteError);
      expect((err as StoreWriteError).reason).toBe("no-device");
      expect((err as Error).message).toContain("device_id");
    }
  });

  test("a store root inside the vault fails the operation with the store_root remedy", () => {
    env = makeStoreEnv("osb-store-write-", { legacyTree: false, partitions: [] });
    const inside = join(env.vault, "store");
    mkdirSync(inside, { recursive: true });
    process.env[STORE_ROOT_ENV] = inside;
    try {
      storeWrite(() => ledgerRowRecord("metrics", { n: 1 }, "shared"), { vault: env.vault });
      throw new Error("expected a refusal");
    } catch (err) {
      expect((err as StoreWriteError).reason).toBe("root-inside-vault");
      expect((err as Error).message).toContain("store_root");
    } finally {
      rmSync(inside, { recursive: true, force: true });
    }
  });

  test("a private record on a machine without the private partition fails the operation", () => {
    env = makeStoreEnv("osb-store-write-", { legacyTree: false, partitions: ["shared"] });
    try {
      storeWrite(() => ledgerRowRecord("metrics", { n: 1 }, "private"), { vault: null });
      throw new Error("expected a refusal");
    } catch (err) {
      expect((err as StoreWriteError).reason).toBe("partition-unavailable");
      expect((err as Error).message).toContain("does not hold the private partition");
      expect((err as Error).message.split("Sync ").length - 1).toBe(1);
      // The detail's own closing period is not doubled before the remedy.
      expect((err as Error).message).not.toContain("..");
    }
    expect(rowsOf(env.storeRoot, "shared")).toEqual([]);
  });

  test("a fail-open caller logs the failure and continues", () => {
    env = makeStoreEnv("osb-store-write-", { legacyTree: false, partitions: [] });
    const seen: string[] = [];
    const routed = routeWrite({
      legacy: () => null,
      store: () => ledgerRowRecord("metrics", { n: 1 }, "shared"),
      context: { vault: null },
      failOpen: true,
      onFailure: (error) => seen.push(error.reason),
    });
    expect(routed.mode).toBe("store");
    expect(routed.mode === "store" ? routed.failed?.reason : null).toBe("no-store");
    expect(seen).toEqual(["no-store"]);
    expect(readStoreWriteStatus()).toMatchObject({ failures: 1, last_reason: "no-store" });
  });
});

describe("routeWrite on an unswitched machine", () => {
  test("the legacy write runs and the dual write follows the flag", () => {
    env = makeStoreEnv("osb-store-write-");
    const routed = routeWrite({
      legacy: legacyWrite(env.vault),
      store: () => ledgerRowRecord("metrics", { n: 4 }, "shared"),
      context: { vault: env.vault },
    });
    expect(routed).toMatchObject({ mode: "legacy" });
    expect(rowsOf(env.storeRoot, "shared")).toEqual([{ n: 4 }]);
  });

  test("with the flag off the store is never touched", () => {
    env = makeStoreEnv("osb-store-write-", { dualWrite: false });
    let built = false;
    routeWrite({
      legacy: legacyWrite(env.vault),
      store: () => {
        built = true;
        return ledgerRowRecord("metrics", { n: 5 }, "shared");
      },
      context: { vault: env.vault },
    });
    expect(built).toBe(false);
    expect(rowsOf(env.storeRoot, "shared")).toEqual([]);
  });

  test("a store failure is swallowed and counted, the legacy write wins", () => {
    env = makeStoreEnv("osb-store-write-", { partitions: [] });
    const routed = routeWrite({
      legacy: legacyWrite(env.vault),
      store: () => ledgerRowRecord("metrics", { n: 6 }, "shared"),
      context: { vault: env.vault },
    });
    expect(routed).toMatchObject({ mode: "legacy" });
    expect(readDualWriteStatus().skipped_no_store).toBeGreaterThanOrEqual(1);
  });
});

describe("the device a store-only write is made as", () => {
  test("comes from the machine config the write names, not the default one", () => {
    env = makeStoreEnv("osb-store-write-device-", { legacyTree: false });
    delete process.env["O2B_DEVICE_ID"];
    const configPath = join(env.parent, "other-config.yaml");
    writeFileSync(configPath, "device_id: dev-other\n");
    const [written] = storeWrite(() => ledgerRowRecord("metrics", { n: 1 }, "shared"), {
      vault: null,
      configPath,
    });
    expect(written?.record.device).toBe("dev-other");
  });

  test("an unreadable machine config is that cause, not a missing device id", () => {
    env = makeStoreEnv("osb-store-write-device-", { legacyTree: false });
    delete process.env["O2B_DEVICE_ID"];
    const configPath = join(env.parent, "config-dir.yaml");
    mkdirSync(configPath);
    let caught: unknown = null;
    try {
      storeWrite(() => ledgerRowRecord("metrics", { n: 1 }, "shared"), { vault: null, configPath });
    } catch (err) {
      caught = err;
    }
    expect((caught as StoreWriteError).reason).toBe("store-error");
  });
});

describe("the fail-open status file", () => {
  test("a last reason that is no failure kind reads as none", () => {
    env = makeStoreEnv("osb-store-write-status-", { legacyTree: false });
    const path = join(env.parent, "status.json");
    writeFileSync(path, JSON.stringify({ failures: 1, last_reason: "toString" }));
    expect(readStoreWriteStatus(path).last_reason).toBeNull();
  });
});
