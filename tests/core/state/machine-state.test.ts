/**
 * The machine-state resolver (task 2.10, design D14 items 6 and 13): an
 * unswitched machine keeps its state in the vault, a switched machine (or
 * one with no vault) in `<device state>/migration/local`, the folder the
 * migration copies the device-local surfaces into, and the migration's
 * backup-class copies are restored there once.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { VaultEscapeError } from "../../../src/core/path-safety.ts";
import {
  deviceLocalStateRoot,
  forgetMachineStateCache,
  freshVaultStateRoot,
  isMachineStateRelocated,
  machineStatePath,
  machineStateRoot,
} from "../../../src/core/state/machine-state.ts";
import { migrationDir } from "../../../src/core/store-migration/journal.ts";
import { appendRecord } from "../../../src/core/store/appender.ts";
import { DEVICE_SWITCHED_KIND, isStoreOnly } from "../../../src/core/store/store-only.ts";
import { openStore } from "../../../src/core/store/store-open.ts";
import { initStore } from "../../../src/core/store/store-init.ts";
import { makeStoreEnv, type StoreEnv } from "../store/fixtures/store-env.ts";

let env: StoreEnv | undefined;

afterEach(() => {
  env?.cleanup();
  env = undefined;
  forgetMachineStateCache();
});

function switchDevice(e: StoreEnv): void {
  appendRecord(openStore({ root: e.storeRoot, device: "dev-a" }), {
    partition: "shared",
    stream: "settings",
    kind: DEVICE_SWITCHED_KIND,
    agent: "o2b",
    body: { authority: "human", vault_id: null, device: "dev-a" },
  });
}

describe("machineStateRoot", () => {
  test("an unswitched machine keeps its state in the vault", () => {
    env = makeStoreEnv("osb-machine-state-");
    expect(isMachineStateRelocated(env.vault)).toBe(false);
    expect(machineStateRoot(env.vault)).toBe(env.vault);
    expect(machineStatePath(env.vault, ".open-second-brain", "secrets")).toBe(
      join(env.vault, ".open-second-brain", "secrets"),
    );
  });

  test("a switched machine keeps it in the migration's device-local folder", () => {
    env = makeStoreEnv("osb-machine-state-");
    switchDevice(env);
    const store = openStore({ root: env.storeRoot, device: "dev-a" });
    const local = join(migrationDir(store), "local");
    expect(isMachineStateRelocated(env.vault)).toBe(true);
    expect(machineStateRoot(env.vault)).toBe(local);
    expect(deviceLocalStateRoot()).toBe(local);
    expect(machineStatePath(env.vault, "Brain", ".state", "frozen.json")).toBe(
      join(local, "Brain", ".state", "frozen.json"),
    );
  });

  test("a machine with no vault keeps it in the device-local folder too", () => {
    env = makeStoreEnv("osb-machine-state-", { legacyTree: false, configureVault: false });
    const store = openStore({ root: env.storeRoot, device: "dev-a" });
    expect(machineStateRoot(null)).toBe(join(migrationDir(store), "local"));
  });

  test("with no store yet, the folder of all stores holds it", () => {
    env = makeStoreEnv("osb-machine-state-", {
      legacyTree: false,
      configureVault: false,
      partitions: [],
    });
    expect(machineStateRoot(null)).toBe(
      join(env.parent, "state", "open-second-brain", "stores", "migration", "local"),
    );
  });

  test("a vault with no legacy tree is store-only and keeps no state in the vault", () => {
    // One rule with the store-only predicate (`store/store-only.ts`): a
    // bare vault writes to the store only, so its machine state is
    // device-local too, in a folder of its own.
    env = makeStoreEnv("osb-machine-state-", { legacyTree: false });
    expect(isStoreOnly({ vault: env.vault })).toBe(true);
    expect(isMachineStateRelocated(env.vault)).toBe(true);
    const root = machineStateRoot(env.vault);
    expect(root).toBe(freshVaultStateRoot(env.vault));
    expect(root.startsWith(env.vault)).toBe(false);
    const store = openStore({ root: env.storeRoot, device: "dev-a" });
    expect(root.startsWith(join(migrationDir(store), ".."))).toBe(true);
  });

  test("two bare vaults on one machine keep separate state", () => {
    env = makeStoreEnv("osb-machine-state-", { legacyTree: false });
    const other = join(env.parent, "other-vault");
    mkdirSync(other);
    expect(machineStateRoot(other)).not.toBe(machineStateRoot(env.vault));
  });

  test("a bare vault's state moves into the store's folder once the store exists", () => {
    env = makeStoreEnv("osb-machine-state-", { legacyTree: false, partitions: [] });
    const before = machineStatePath(env.vault, ".open-second-brain", "secrets", "keyfile");
    mkdirSync(join(before, ".."), { recursive: true });
    writeFileSync(before, "key");
    initStore({ root: env.storeRoot, partitions: ["shared", "private"] });
    forgetMachineStateCache();
    const after = machineStatePath(env.vault, ".open-second-brain", "secrets", "keyfile");
    expect(after).not.toBe(before);
    expect(readFileSync(after, "utf8")).toBe("key");
    expect(existsSync(before)).toBe(false);
  });

  test("a bare vault's state moves into the switched folder once the machine is switched", () => {
    env = makeStoreEnv("osb-machine-state-", { legacyTree: false });
    const before = machineStatePath(env.vault, ".open-second-brain", "hook-state", "s.json");
    mkdirSync(join(before, ".."), { recursive: true });
    writeFileSync(before, "{}");
    switchDevice(env);
    forgetMachineStateCache();
    const after = machineStatePath(env.vault, ".open-second-brain", "hook-state", "s.json");
    const store = openStore({ root: env.storeRoot, device: "dev-a" });
    expect(after).toBe(
      join(migrationDir(store), "local", ".open-second-brain", "hook-state", "s.json"),
    );
    expect(readFileSync(after, "utf8")).toBe("{}");
    expect(existsSync(before)).toBe(false);
  });

  test("a segment that climbs out of the root throws", () => {
    env = makeStoreEnv("osb-machine-state-");
    switchDevice(env);
    expect(() => machineStatePath(env!.vault, "..", "..", "escape")).toThrow(VaultEscapeError);
  });
});

describe("backup-class restore", () => {
  function backedUp(e: StoreEnv, rel: string, text: string): void {
    const store = openStore({ root: e.storeRoot, device: "dev-a" });
    const path = join(migrationDir(store), "backup", "files", ...rel.split("/"));
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, text);
  }

  test("the backed-up files are restored into the live folder once", () => {
    env = makeStoreEnv("osb-machine-state-");
    backedUp(env, ".open-second-brain/secrets/store.json", "secret");
    backedUp(env, ".open-second-brain/install.lock.json", "lock");
    switchDevice(env);

    const secret = machineStatePath(env.vault, ".open-second-brain", "secrets", "store.json");
    expect(readFileSync(secret, "utf8")).toBe("secret");
    const lock = machineStatePath(env.vault, ".open-second-brain", "install.lock.json");
    expect(readFileSync(lock, "utf8")).toBe("lock");

    // A file the machine deletes later is not brought back by the next process.
    rmSync(lock);
    forgetMachineStateCache();
    machineStatePath(env.vault, ".open-second-brain", "install.lock.json");
    expect(existsSync(lock)).toBe(false);
  });

  test("a live copy is never overwritten by its backup", () => {
    env = makeStoreEnv("osb-machine-state-");
    backedUp(env, ".open-second-brain/install.lock.json", "old");
    switchDevice(env);
    const live = join(deviceLocalStateRoot(), ".open-second-brain", "install.lock.json");
    mkdirSync(join(live, ".."), { recursive: true });
    writeFileSync(live, "new");
    forgetMachineStateCache();
    expect(
      readFileSync(machineStatePath(env.vault, ".open-second-brain", "install.lock.json"), "utf8"),
    ).toBe("new");
  });
});
