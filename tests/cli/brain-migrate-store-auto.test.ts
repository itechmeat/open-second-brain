/**
 * `o2b brain migrate-store` beside the automatic worker (change
 * auto-store-migration, design D4): a manual run refuses while the
 * automatic worker holds this vault's lock and starts no second
 * migration; the dry run stays available; `--auto <token>` is the
 * worker's entry point, runs only on the claim it was handed, and is
 * no form to combine with another.
 */
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { STORE_ROOT_ENV } from "../../src/core/store/constants.ts";
import {
  autoMigrationLockPath,
  claimAutoMigrationLock,
  handAutoMigrationLock,
  releaseAutoMigrationLock,
} from "../../src/core/store-migration/auto-state.ts";
import { runCli } from "../helpers/run-cli.ts";
import {
  makeLegacyVault,
  type LegacyVaultFixture,
} from "../core/store-migration/fixtures/legacy-vault.ts";
import { CLI_SPAWN_BUDGET_MS } from "../helpers/cli-timeout.ts";

// Tests here spawn processes; see tests/helpers/cli-timeout.ts.
setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

/** A claim token no worker holds. */
const FOREIGN_CLAIM = "not-the-claim";

let fx: LegacyVaultFixture;
let env: Record<string, string>;
let storeRoot: string;
const saved = new Map<string, string | undefined>();

beforeEach(() => {
  fx = makeLegacyVault("osb-cli-migrate-auto-");
  const configPath = join(fx.parent, "config.yaml");
  writeFileSync(configPath, `vault: ${fx.vault}\n`);
  storeRoot = join(fx.parent, "store");
  env = {
    OPEN_SECOND_BRAIN_CONFIG: configPath,
    HOME: join(fx.parent, "home"),
    XDG_CONFIG_HOME: join(fx.parent, "config"),
    XDG_STATE_HOME: join(fx.parent, "state"),
    XDG_DATA_HOME: join(fx.parent, "data"),
    LOCALAPPDATA: join(fx.parent, "state"),
    [STORE_ROOT_ENV]: storeRoot,
    O2B_DEVICE_ID: "dev-a",
    // The suite's preload turns the automatic migration off; the worker
    // entry point is under test here.
    OPEN_SECOND_BRAIN_AUTO_STORE_MIGRATION: "true",
  };
  // The worker lock lives in the device-local state, which the state
  // directories name: this process claims where the CLI child looks.
  for (const key of Object.keys(env)) saved.set(key, process.env[key]);
  Object.assign(process.env, env);
});
afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  saved.clear();
  fx.cleanup();
});

const migrate = (...args: string[]) =>
  runCli(["brain", "migrate-store", "--vault", fx.vault, ...args], { env });

describe("a manual run while the automatic worker holds the vault", () => {
  test("refuses, names the worker, and starts no migration", async () => {
    const token = claimAutoMigrationLock(fx.vault, new Date());
    expect(token).not.toBeNull();
    try {
      const res = await migrate();
      expect(res.returncode).toBe(1);
      expect(res.stderr).toContain("the automatic store migration is running");
      expect(res.stderr).toContain(`process ${process.pid}`);
      // No second migration started: not even a store was created.
      expect(existsSync(storeRoot)).toBe(false);
    } finally {
      releaseAutoMigrationLock(fx.vault, token!);
    }
  });

  test("a claim whose worker is gone refuses nothing", async () => {
    const token = claimAutoMigrationLock(fx.vault, new Date());
    // The worker the claim was handed to has ended without releasing it
    // (a kill): its pid is gone.
    const gone = Bun.spawnSync([process.execPath, "-e", "0"], { stdin: "ignore" }).pid;
    expect(handAutoMigrationLock(fx.vault, token!, gone, null)).toBe(true);
    const res = await migrate();
    expect(res.stderr).not.toContain("the automatic store migration is running");
  });

  test("the dry run stays available", async () => {
    const token = claimAutoMigrationLock(fx.vault, new Date());
    try {
      const res = await migrate("--dry-run", "--json");
      // The fixture holds unmapped entries, so the plan fails; it is printed.
      expect(res.returncode).toBe(1);
      expect((JSON.parse(res.stdout) as { dry_run: boolean }).dry_run).toBe(true);
    } finally {
      releaseAutoMigrationLock(fx.vault, token!);
    }
  });
});

describe("the --auto worker entry point", () => {
  test("a claim it does not hold runs nothing and leaves the claim alone", async () => {
    const token = claimAutoMigrationLock(fx.vault, new Date());
    try {
      const res = await migrate("--auto", FOREIGN_CLAIM);
      expect(res.returncode).toBe(0);
      expect(res.stdout).toBe("");
      expect(existsSync(storeRoot)).toBe(false);
      expect(existsSync(autoMigrationLockPath(fx.vault))).toBe(true);
    } finally {
      releaseAutoMigrationLock(fx.vault, token!);
    }
  });

  test("is no form to combine with another", async () => {
    const res = await migrate("--auto", FOREIGN_CLAIM, "--dry-run");
    expect(res.returncode).toBe(2);
    expect(res.stderr).toContain("--auto");
  });
});
