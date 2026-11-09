/**
 * Vault resolution for the hooks (design D14 item 1, task 2.10): `null`
 * when no vault is configured or the machine config cannot be read, and
 * the hook target: the vault, the brain store with no vault, or nothing.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { resolveHookTarget, resolveHookVault } from "../../hooks/lib/hook-vault.ts";
import { noVaultRoot } from "../../src/core/platform-dirs.ts";
import { makeStoreEnv, type StoreEnv } from "../core/store/fixtures/store-env.ts";

let env: StoreEnv | null = null;
afterEach(() => {
  env?.cleanup();
  env = null;
});

describe("hook vault resolution", () => {
  test("the configured vault", () => {
    env = makeStoreEnv("osb-hook-vault-set-");
    expect(resolveHookVault()).toBe(env.vault);
  });

  test("no vault: null", () => {
    env = makeStoreEnv("osb-hook-vault-none-", { legacyTree: false, configureVault: false });
    expect(resolveHookVault()).toBeNull();
  });

  test("an unreadable machine config resolves to no vault instead of throwing", () => {
    env = makeStoreEnv("osb-hook-vault-bad-", { legacyTree: false, configureVault: false });
    const dirAsConfig = join(env.parent, "config-dir");
    mkdirSync(dirAsConfig);
    process.env["OPEN_SECOND_BRAIN_CONFIG"] = dirAsConfig;
    expect(resolveHookVault()).toBeNull();
  });
});

describe("hook target", () => {
  test("a configured vault: the vault part of the hook runs", () => {
    env = makeStoreEnv("osb-hook-target-vault-");
    expect(resolveHookTarget()).toEqual({ vault: env.vault, hasVault: true });
  });

  test("no vault but a brain store: the store-side part runs on the no-vault stand-in", () => {
    env = makeStoreEnv("osb-hook-target-store-", { legacyTree: false, configureVault: false });
    expect(resolveHookTarget()).toEqual({ vault: noVaultRoot(), hasVault: false });
  });

  test("neither a vault nor a store: null, the hook returns quietly", () => {
    env = makeStoreEnv("osb-hook-target-none-", {
      legacyTree: false,
      configureVault: false,
      partitions: [],
    });
    expect(resolveHookTarget()).toBeNull();
  });
});
