/**
 * Test helper for the store-only write path and the read facades: one
 * named temp parent per test holding a HOME, a device-local state base, a
 * machine config, a vault with a legacy `Brain/` tree and a store root,
 * with every environment variable it sets restored in teardown.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../../../src/core/brain/init.ts";
import { STORE_DUAL_WRITE_ENV, STORE_ROOT_ENV } from "../../../../src/core/store/constants.ts";
import { initStore } from "../../../../src/core/store/store-init.ts";

const ENV_KEYS = [
  STORE_DUAL_WRITE_ENV,
  STORE_ROOT_ENV,
  "O2B_DEVICE_ID",
  "HOME",
  "XDG_STATE_HOME",
  "LOCALAPPDATA",
  "OPEN_SECOND_BRAIN_CONFIG",
  "VAULT_DIR",
] as const;

export interface StoreEnv {
  readonly parent: string;
  readonly vault: string;
  readonly storeRoot: string;
  readonly configPath: string;
  cleanup(): void;
}

export interface StoreEnvOptions {
  /** Bootstrap a legacy `Brain/` tree in the vault (default true). */
  readonly legacyTree?: boolean;
  /** Configure the vault in the machine config (default true). */
  readonly configureVault?: boolean;
  /** Partitions `o2b store init` creates (default both); `[]` for no store. */
  readonly partitions?: ReadonlyArray<"shared" | "private">;
  /** Dual-write flag (default on). */
  readonly dualWrite?: boolean;
  /** This machine's device id (default `dev-a`). */
  readonly device?: string;
}

export function makeStoreEnv(prefix: string, options: StoreEnvOptions = {}): StoreEnv {
  const saved = new Map<string, string | undefined>();
  for (const key of ENV_KEYS) saved.set(key, process.env[key]);
  const parent = mkdtempSync(join(tmpdir(), prefix));
  const restoreEnv = (): void => {
    for (const key of ENV_KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  const vault = join(parent, "vault");
  const storeRoot = join(parent, "store");
  const configPath = join(parent, "config.yaml");
  // A setup step that throws leaves the caller no handle to clean up with:
  // restore the environment and remove the parent here before rethrowing.
  try {
    mkdirSync(vault, { recursive: true });
    const configureVault = options.configureVault ?? true;
    writeFileSync(configPath, configureVault ? `vault: ${vault}\n` : "");
    process.env["OPEN_SECOND_BRAIN_CONFIG"] = configPath;
    delete process.env["VAULT_DIR"];
    process.env["HOME"] = join(parent, "home");
    process.env["XDG_STATE_HOME"] = join(parent, "state");
    process.env["LOCALAPPDATA"] = join(parent, "state");
    process.env[STORE_ROOT_ENV] = storeRoot;
    process.env["O2B_DEVICE_ID"] = options.device ?? "dev-a";
    if (options.dualWrite ?? true) process.env[STORE_DUAL_WRITE_ENV] = "1";
    else delete process.env[STORE_DUAL_WRITE_ENV];
    if (options.legacyTree ?? true) {
      if (!configureVault) writeFileSync(configPath, `vault: ${vault}\n`);
      bootstrapBrain(vault);
      if (!configureVault) writeFileSync(configPath, "");
    }
    const partitions = options.partitions ?? ["shared", "private"];
    if (partitions.length > 0) initStore({ root: storeRoot, partitions });
  } catch (err) {
    restoreEnv();
    rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    throw err;
  }
  return {
    parent,
    vault,
    storeRoot,
    configPath,
    cleanup: () => {
      restoreEnv();
      rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}
