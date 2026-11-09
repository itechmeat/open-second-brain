/**
 * Machine state follows the machine without losing a byte: what an older
 * release kept in a bare vault's own `.open-second-brain/` is found once
 * the state lives outside the vault (and the vault is not changed), state
 * kept with no vault before the store existed moves into the store's
 * folder, and a folder created after a first look still moves.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  forgetMachineStateCache,
  machineStatePath,
  machineStateRoot,
} from "../../../src/core/state/machine-state.ts";
import { initStore } from "../../../src/core/store/store-init.ts";
import { digestVaultTree } from "../../helpers/vault-digest.ts";
import { makeStoreEnv, type StoreEnv } from "../store/fixtures/store-env.ts";

let env: StoreEnv | undefined;
afterEach(() => {
  env?.cleanup();
  env = undefined;
  forgetMachineStateCache();
});

describe("state an older release kept in a bare vault", () => {
  test("is found in the relocated root, once, and the vault is only read", () => {
    env = makeStoreEnv("osb-state-seed-", { legacyTree: false });
    const inVault = join(env.vault, ".open-second-brain", "bootstrap.lock.json");
    mkdirSync(join(inVault, ".."), { recursive: true });
    writeFileSync(inVault, '{"schema_version":1,"entries":{}}\n');
    const before = digestVaultTree(env.vault);
    const path = machineStatePath(env.vault, ".open-second-brain", "bootstrap.lock.json");
    expect(path).not.toBe(inVault);
    expect(readFileSync(path, "utf8")).toBe('{"schema_version":1,"entries":{}}\n');
    expect(digestVaultTree(env.vault)).toBe(before);
    // Deleted from the live root: not brought back by a later process.
    rmSync(path);
    forgetMachineStateCache();
    expect(
      existsSync(machineStatePath(env.vault, ".open-second-brain", "bootstrap.lock.json")),
    ).toBe(false);
  });
});

describe("state kept with no vault before the store existed", () => {
  test("moves into the store's own folder once the store is there", () => {
    env = makeStoreEnv("osb-state-nostore-", {
      legacyTree: false,
      configureVault: false,
      partitions: [],
    });
    const before = machineStatePath(null, ".open-second-brain", "secrets", "secrets.json");
    mkdirSync(join(before, ".."), { recursive: true });
    writeFileSync(before, "kept");
    initStore({ root: env.storeRoot });
    forgetMachineStateCache();
    const after = machineStatePath(null, ".open-second-brain", "secrets", "secrets.json");
    expect(after).not.toBe(before);
    expect(readFileSync(after, "utf8")).toBe("kept");
    expect(existsSync(before)).toBe(false);
  });

  test("a folder that appears after a first look still moves in the same process", () => {
    env = makeStoreEnv("osb-state-late-", {
      legacyTree: false,
      configureVault: false,
      partitions: [],
    });
    const noStoreRoot = machineStateRoot(null);
    initStore({ root: env.storeRoot });
    forgetMachineStateCache();
    const live = machineStateRoot(null);
    expect(live).not.toBe(noStoreRoot);
    // Another process writes into the old folder after this one looked.
    mkdirSync(join(noStoreRoot, "x"), { recursive: true });
    writeFileSync(join(noStoreRoot, "x", "late.json"), "late");
    expect(readFileSync(join(machineStateRoot(null), "x", "late.json"), "utf8")).toBe("late");
  });
});
