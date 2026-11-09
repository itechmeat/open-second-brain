/**
 * The state inventory and the state migration plan only read: on a
 * store-only machine they write nothing to the device-local state, and the
 * plan of a switched machine reports no device-local surface as moved out
 * of the vault by an override.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  forgetMachineStateCache,
  machineStatePath,
} from "../../../src/core/state/machine-state.ts";
import { planStateMigration } from "../../../src/core/state/migrate.ts";
import { inventoryStateSurfaces } from "../../../src/core/state/surfaces.ts";
import { switchDevice } from "../brain/fixtures/memory-twins.ts";
import { digestVaultTree } from "../../helpers/vault-digest.ts";
import { makeStoreEnv, type StoreEnv } from "../store/fixtures/store-env.ts";

let env: StoreEnv | undefined;
afterEach(() => {
  env?.cleanup();
  env = undefined;
  forgetMachineStateCache();
});

describe("the state inventory", () => {
  test("writes nothing to the device-local state of a bare vault", () => {
    env = makeStoreEnv("osb-inventory-ro-", { legacyTree: false });
    const kept = join(env.vault, ".open-second-brain", "secrets", "secrets.json");
    mkdirSync(join(kept, ".."), { recursive: true });
    writeFileSync(kept, "{}");
    const state = join(env.parent, "state");
    mkdirSync(state, { recursive: true });
    const before = digestVaultTree(state);
    inventoryStateSurfaces({
      vault: env.vault,
      env: process.env,
      config: {},
      configPath: env.configPath,
    });
    expect(digestVaultTree(state)).toBe(before);
  });
});

describe("the state migration plan of a switched machine", () => {
  test("names no device-local surface as placed outside the vault by an override", () => {
    env = makeStoreEnv("osb-plan-switched-", { dualWrite: false });
    switchDevice(env);
    forgetMachineStateCache();
    // A device-local surface that exists, in the device-local state.
    const secrets = machineStatePath(env.vault, ".open-second-brain", "secrets", "secrets.json");
    mkdirSync(join(secrets, ".."), { recursive: true });
    writeFileSync(secrets, "{}");
    const plan = planStateMigration({
      vault: env.vault,
      destination: join(env.parent, "elsewhere"),
      env: process.env,
      config: {},
      configPath: env.configPath,
    });
    expect(plan.external.filter((e) => e.reason.includes("an override placed it"))).toEqual([]);
  });
});
