/**
 * The brain settings readers on a vault switched to the store whose legacy
 * `Brain/` tree is gone: each one reads the settings in force from the
 * store's shared settings records, as `loadBrainConfig` does, instead of
 * taking the missing `Brain/_brain.yaml` for "no settings".
 *
 * Before the fix each of these read `_brain.yaml` directly, or tested for
 * it first: the storage cap was never enforced, the discipline report went
 * silently off, the health baseline could not be set, `o2b brain status`
 * reported a missing config, and the watchdog reported a critical problem
 * and, remediating, recreated a legacy `Brain/` tree in the vault.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  readHealthBaseline,
  writeHealthBaseline,
} from "../../../src/core/brain/health-baseline.ts";
import { buildOperatorSnapshot } from "../../../src/core/brain/operator-snapshot.ts";
import {
  loadGateStorageConfig,
  StorageGateConfigError,
} from "../../../src/core/brain/storage/gate-config.ts";
import { runBrainWatchdog } from "../../../src/core/brain/watchdog.ts";
import { runDisciplineReport } from "../../../src/core/discipline/report.ts";
import { appendRecord } from "../../../src/core/store/appender.ts";
import { SETTING_SET_KIND } from "../../../src/core/store/constants.ts";
import { openStore } from "../../../src/core/store/store-open.ts";
import { makeStoreEnv, type StoreEnv } from "../store/fixtures/store-env.ts";
import { switchDevice } from "./store-only/fixtures.ts";

let env: StoreEnv | null = null;
afterEach(() => {
  env?.cleanup();
  env = null;
});

function switchedVault(): StoreEnv {
  const made = makeStoreEnv("osb-switched-readers-", { legacyTree: false });
  switchDevice(made.storeRoot);
  expect(existsSync(join(made.vault, "Brain"))).toBe(false);
  return made;
}

describe("settings readers on a switched vault", () => {
  test("the storage gate reads the cap from the store", () => {
    env = switchedVault();
    expect(loadGateStorageConfig(env.vault).cap_bytes).toBeNull();
    // `storage` is a device block: the machine config holds it.
    appendFileSync(env.configPath, "brain_storage_cap_bytes: 5000000\n");
    expect(loadGateStorageConfig(env.vault).cap_bytes).toBe(5_000_000);
  });

  test("the storage gate validates only the storage block, as it does on a legacy vault", () => {
    env = switchedVault();
    appendFileSync(env.configPath, "brain_storage_cap_bytes: 5000000\n");
    // An unrelated shared setting that does not validate.
    appendRecord(openStore({ root: env.storeRoot, device: "dev-a" }), {
      partition: "shared",
      stream: "settings",
      kind: SETTING_SET_KIND,
      agent: "operator",
      body: { authority: "human", key: "brain.health.materialize_max_age_days", value: "invalid" },
    });
    expect(loadGateStorageConfig(env.vault).cap_bytes).toBe(5_000_000);
  });

  test("a machine config the gate cannot read refuses without naming its path", () => {
    env = switchedVault();
    // A directory at the config path: present, and not readable as a file.
    rmSync(env.configPath, { force: true });
    mkdirSync(env.configPath);
    let message = "";
    try {
      loadGateStorageConfig(env.vault);
    } catch (err) {
      expect(err).toBeInstanceOf(StorageGateConfigError);
      message = (err as Error).message;
    }
    expect(message).toContain("machine config could not be read (unreadable)");
    expect(message).not.toContain(env.configPath);
    expect(message).not.toContain(env.parent);
  });

  test("a storage block that does not validate refuses by name", () => {
    env = switchedVault();
    appendFileSync(env.configPath, "brain_storage_cap_bytes: -3\n");
    expect(() => loadGateStorageConfig(env!.vault)).toThrow(/storage/);
  });

  test("the discipline report runs when the store enables it", () => {
    env = switchedVault();
    // The timezone is a device field: the machine config holds it. The
    // shared fields are seeded as the migration writes them: the block
    // validates only whole, so one settings command at a time cannot.
    appendFileSync(env.configPath, 'brain_discipline_report_timezone: "UTC"\n');
    for (const [field, value] of [
      ["enabled", true],
      ["watched_paths", ["Projects"]],
      ["known_agents", ["claude"]],
    ] as const) {
      appendRecord(openStore({ root: env.storeRoot, device: "dev-a" }), {
        partition: "shared",
        stream: "settings",
        kind: SETTING_SET_KIND,
        agent: "operator",
        body: { authority: "human", key: `brain.discipline_report.${field}`, value },
      });
    }
    const report = runDisciplineReport({ vault: env.vault, now: new Date() });
    expect(report.status).not.toBe("disabled");
  });

  test("the health baseline is set and cleared as a store setting, with no Brain/ written", async () => {
    env = switchedVault();
    await writeHealthBaseline(env.vault, "2026-11-01");
    expect(readHealthBaseline(env.vault)).toBe("2026-11-01");
    await writeHealthBaseline(env.vault, null);
    expect(readHealthBaseline(env.vault)).toBeNull();
    expect(existsSync(join(env.vault, "Brain"))).toBe(false);
  });

  test("the operator snapshot reports no missing config", async () => {
    env = switchedVault();
    const snap = await buildOperatorSnapshot(env.vault);
    expect(snap.problems.map((p) => p.detail)).not.toContain(
      "Brain config `_brain.yaml` is missing",
    );
  });

  test("the watchdog neither reports the legacy config missing nor recreates Brain/", () => {
    env = switchedVault();
    const result = runBrainWatchdog(env.vault, { remediate: true });
    const config = result.report.checks.find((c) => c.name === "brain-config");
    expect(config?.status).toBe("ok");
    expect(result.report.checks.some((c) => c.name.startsWith("dir:Brain"))).toBe(false);
    expect(existsSync(join(env.vault, "Brain", "inbox"))).toBe(false);
  });
});
