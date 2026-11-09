/**
 * A machine that has switched to the store writes no byte under `Brain/`
 * (design D14 item 1, task 2.10): `brain upgrade` refuses there, and the
 * session-start maintenance skips the managed-file upgrade.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import {
  applyUpgrade,
  BrainUpgradeError,
  BrainUpgradeStoreOnlyError,
  upgradeBlockedByStore,
} from "../../../src/core/brain/upgrade.ts";
import { brainConfigPath, brainManualPath } from "../../../src/core/brain/paths.ts";
import { ensureVaultCurrent } from "../../../src/core/maintenance/ensure-current.ts";
import { runSelfHealUpgrade } from "../../../src/core/maintenance/self-heal-upgrade.ts";
import { storeOnlyMode } from "../../../src/core/store/store-only.ts";
import { runCli } from "../../helpers/run-cli.ts";
import { digestVaultTree } from "../../helpers/vault-digest.ts";
import { makeStoreEnv, type StoreEnv } from "../store/fixtures/store-env.ts";
import { switchDevice as switchDeviceAt } from "./store-only/fixtures.ts";
import { join } from "node:path";

let env: StoreEnv | null = null;
afterEach(() => {
  env?.cleanup();
  env = null;
});

function switchDevice(e: StoreEnv): void {
  switchDeviceAt(e.storeRoot);
}

describe("upgrade on a switched machine", () => {
  test("brain upgrade refuses and writes nothing", () => {
    env = makeStoreEnv("osb-upgrade-switched-");
    writeFileSync(brainManualPath(env.vault), "hand edited\n");
    switchDevice(env);
    const before = digestVaultTree(join(env.vault, "Brain"));
    expect(() => applyUpgrade(env!.vault)).toThrow(BrainUpgradeError);
    expect(() => applyUpgrade(env!.vault)).toThrow(BrainUpgradeStoreOnlyError);
    expect(upgradeBlockedByStore(env.vault)).toBe(true);
    expect(digestVaultTree(join(env.vault, "Brain"))).toEqual(before);
  });

  test("brain upgrade --json: the answer's ok and the exit code agree", async () => {
    env = makeStoreEnv("osb-upgrade-switched-json-");
    switchDevice(env);
    const look = await runCli(["brain", "upgrade", "--json", "--vault", env.vault]);
    expect(look.returncode).toBe(0);
    expect(JSON.parse(look.stdout)).toMatchObject({ ok: true, store_only: true });
    const apply = await runCli(["brain", "upgrade", "--apply", "--json", "--vault", env.vault]);
    expect(apply.returncode).toBe(1);
    expect(JSON.parse(apply.stdout)).toMatchObject({ ok: false, store_only: true });
  });

  test("a vault with no legacy tree is refused and gets no Brain/ tree", () => {
    env = makeStoreEnv("osb-upgrade-notree-", { legacyTree: false });
    expect(() => applyUpgrade(env!.vault)).toThrow(BrainUpgradeStoreOnlyError);
    expect(existsSync(join(env.vault, "Brain"))).toBe(false);
  });

  test("an unswitched machine still upgrades", () => {
    env = makeStoreEnv("osb-upgrade-legacy-");
    writeFileSync(brainManualPath(env.vault), "hand edited\n");
    expect(applyUpgrade(env.vault).files_updated.length).toBeGreaterThan(0);
  });

  test("session-start maintenance skips the managed-file upgrade", async () => {
    env = makeStoreEnv("osb-ensure-switched-");
    writeFileSync(brainManualPath(env.vault), "hand edited\n");
    switchDevice(env);
    const managed = () => [
      readFileSync(brainManualPath(env!.vault), "utf8"),
      readFileSync(brainConfigPath(env!.vault), "utf8"),
    ];
    const before = managed();
    const beforeTree = digestVaultTree(join(env.vault, "Brain"));
    const result = await ensureVaultCurrent(env.vault, {
      configPath: env.configPath,
      background: false,
    });
    expect(result.brainUpgraded).toEqual([]);
    expect(result.brainUpgradeOutcome).toBeNull();
    expect(managed()).toEqual(before);
    // Nothing else either: no snapshot, self-heal state, log or ledger row.
    expect(digestVaultTree(join(env.vault, "Brain"))).toEqual(beforeTree);
  });

  test("a self-heal attempt on a switched machine records no failure and writes nothing", () => {
    env = makeStoreEnv("osb-selfheal-switched-");
    writeFileSync(brainManualPath(env.vault), "hand edited\n");
    switchDevice(env);
    const before = digestVaultTree(join(env.vault, "Brain"));
    const upgrade = runSelfHealUpgrade(env.vault, { configPath: env.configPath });
    expect(upgrade.outcome).not.toBe("failed");
    expect(digestVaultTree(join(env.vault, "Brain"))).toEqual(before);
  });

  test("a switched machine whose store is unreadable for a moment still runs the index steps", async () => {
    env = makeStoreEnv("osb-ensure-switched-gone-");
    switchDevice(env);
    // Seen switched once (the sticky marker), then sync takes the store away.
    expect(storeOnlyMode({ vault: env.vault, configPath: env.configPath }).storeOnly).toBe(true);
    rmSync(env.storeRoot, { recursive: true, force: true });
    const result = await ensureVaultCurrent(env.vault, {
      configPath: env.configPath,
      background: false,
    });
    expect(result.skipped).toBe("");
  });

  test("session-start maintenance of a vault with no legacy tree still runs the index steps", async () => {
    env = makeStoreEnv("osb-ensure-notree-", { legacyTree: false });
    const result = await ensureVaultCurrent(env.vault, {
      configPath: env.configPath,
      background: false,
    });
    expect(result.skipped).toBe("");
    expect(result.brainUpgradeOutcome).toBeNull();
    expect(existsSync(join(env.vault, "Brain"))).toBe(false);
  });
});
