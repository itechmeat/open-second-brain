/**
 * The single brain settings reader without `_brain.yaml` (design D14
 * item 3, task 2.10): folded shared settings records plus the device keys
 * of the machine config over the defaults, on a store-only machine and
 * with no vault; the legacy file on an unswitched machine.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  chmodSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { DEFAULT_BRAIN_CONFIG } from "../../../src/core/brain/policy/defaults.ts";
import { buildCaptureBoundary } from "../../../src/core/brain/capture-boundary.ts";
import {
  BrainConfigError,
  BrainSettingsUnreadableError,
} from "../../../src/core/brain/policy/errors.ts";
import {
  brainConfigUnreadableReport,
  loadBrainConfig,
  loadBrainConfigDetailed,
  loadMaintenanceConfigSafe,
} from "../../../src/core/brain/policy/load.ts";
import {
  readBrainSettingsFromStore,
  readRawBrainSettingsFromStore,
  STORE_SETTINGS_SOURCE,
} from "../../../src/core/brain/policy/settings-source.ts";
import {
  brainSettingKey,
  importBrainSettings,
} from "../../../src/core/store-migration/brain-settings.ts";
import { brainConfigPath } from "../../../src/core/brain/paths.ts";
import { appendRecord } from "../../../src/core/store/appender.ts";
import { SETTING_SET_KIND, SETTING_UNSET_KIND } from "../../../src/core/store/constants.ts";
import { openStore } from "../../../src/core/store/store-open.ts";
import { CHMOD_CANNOT_DENY } from "../../helpers/platform.ts";
import { makeStoreEnv, type StoreEnv } from "../store/fixtures/store-env.ts";
import { switchDevice } from "./store-only/fixtures.ts";

let env: StoreEnv | null = null;
afterEach(() => {
  env?.cleanup();
  env = null;
});

function setShared(e: StoreEnv, key: string, value: unknown, authority = "human"): void {
  const store = openStore({ root: e.storeRoot, device: "dev-a" });
  appendRecord(store, {
    partition: "shared",
    stream: "settings",
    kind: SETTING_SET_KIND,
    agent: "test",
    body: { authority, key, value },
  });
}

function unsetShared(e: StoreEnv, key: string): void {
  const store = openStore({ root: e.storeRoot, device: "dev-a" });
  appendRecord(store, {
    partition: "shared",
    stream: "settings",
    kind: SETTING_UNSET_KIND,
    agent: "test",
    body: { authority: "human", key },
  });
}

describe("brain settings without _brain.yaml", () => {
  test("no vault and no records: the defaults", () => {
    env = makeStoreEnv("osb-settings-none-", { legacyTree: false, configureVault: false });
    const config = loadBrainConfig(null);
    expect(config.dream).toEqual(DEFAULT_BRAIN_CONFIG.dream);
    expect(config.snapshots.retention_count).toBe(DEFAULT_BRAIN_CONFIG.snapshots.retention_count);
    expect(loadBrainConfigDetailed(null).path).toBe(STORE_SETTINGS_SOURCE);
  });

  test("no vault and no store at all: the defaults", () => {
    env = makeStoreEnv("osb-settings-nostore-", {
      legacyTree: false,
      configureVault: false,
      partitions: [],
    });
    expect(loadBrainConfig(null).primary_agent).toBeNull();
  });

  test("a shared record sets a block; missing fields keep their defaults", () => {
    env = makeStoreEnv("osb-settings-shared-", { legacyTree: false, configureVault: false });
    setShared(env, brainSettingKey("dream", "candidate_threshold"), 7);
    setShared(env, brainSettingKey("primary_agent"), "claude");
    const config = loadBrainConfig(null);
    expect(config.dream.candidate_threshold).toBe(7);
    expect(config.dream.unconfirmed_window_days).toBe(
      DEFAULT_BRAIN_CONFIG.dream.unconfirmed_window_days,
    );
    expect(config.primary_agent).toBe("claude");
  });

  test("the later record wins and an unset falls back to the default", () => {
    env = makeStoreEnv("osb-settings-fold-", { legacyTree: false, configureVault: false });
    setShared(env, brainSettingKey("dream", "candidate_threshold"), 3);
    setShared(env, brainSettingKey("dream", "candidate_threshold"), 4);
    expect(loadBrainConfig(null).dream.candidate_threshold).toBe(4);
    unsetShared(env, brainSettingKey("dream", "candidate_threshold"));
    expect(loadBrainConfig(null).dream.candidate_threshold).toBe(
      DEFAULT_BRAIN_CONFIG.dream.candidate_threshold,
    );
  });

  test("human authority wins over a later agent seed (design D4)", () => {
    env = makeStoreEnv("osb-settings-authority-", { legacyTree: false, configureVault: false });
    setShared(env, brainSettingKey("dream", "candidate_threshold"), 8, "human");
    setShared(env, brainSettingKey("dream", "candidate_threshold"), 5, "agent");
    expect(loadBrainConfig(null).dream.candidate_threshold).toBe(8);
  });

  test("device keys come from the machine config lines, never from shared records", () => {
    env = makeStoreEnv("osb-settings-device-", { legacyTree: false, configureVault: false });
    // A shared record for a device key is ignored: it would force one machine's value on all.
    setShared(env, brainSettingKey("snapshots", "retention_count"), 3);
    setShared(env, brainSettingKey("hygiene", "resolver_cmd"), "./shared.sh");
    // discipline_report is shared except its timezone, which is per machine.
    setShared(env, brainSettingKey("discipline_report", "enabled"), true);
    setShared(env, brainSettingKey("discipline_report", "watched_paths"), ["src"]);
    setShared(env, brainSettingKey("discipline_report", "known_agents"), ["claude"]);
    expect(loadBrainConfig(null).snapshots.retention_count).toBe(
      DEFAULT_BRAIN_CONFIG.snapshots.retention_count,
    );
    appendFileSync(
      env.configPath,
      'brain_snapshots_retention_count: 12\nbrain_hygiene_resolver_cmd: "./resolve.sh"\n' +
        'brain_discipline_report_timezone: "true"\n',
    );
    const read = readBrainSettingsFromStore({ configPath: env.configPath });
    expect(read.config.snapshots.retention_count).toBe(12);
    expect(read.config.hygiene?.resolver_cmd).toBe("./resolve.sh");
    // The JSON string stays a string even though it looks like a boolean.
    expect(read.config.discipline_report).toEqual({
      enabled: true,
      timezone: "true",
      watched_paths: ["src"],
      known_agents: ["claude"],
    });
  });

  test("a config line for a shared field of a device block is ignored", () => {
    env = makeStoreEnv("osb-settings-device-shared-field-", {
      legacyTree: false,
      configureVault: false,
    });
    setShared(env, brainSettingKey("decision_model", "enabled"), true);
    appendFileSync(env.configPath, "brain_decision_model_enabled: false\n");
    // The cached read is shared by every caller in the process: frozen.
    expect(Object.isFrozen(readBrainSettingsFromStore({ configPath: env.configPath }).config)).toBe(
      true,
    );
    const raw = readRawBrainSettingsFromStore({ configPath: env.configPath });
    expect((raw["decision_model"] as Record<string, unknown>)["enabled"]).toBe(true);
  });

  test("the migration's import reads back as the file it came from", () => {
    env = makeStoreEnv("osb-settings-roundtrip-");
    writeFileSync(
      brainConfigPath(env.vault),
      [
        "schema_version: 1",
        "primary_agent: claude",
        "dream:",
        "  candidate_threshold: 4",
        "  unconfirmed_window_days: 21",
        "snapshots:",
        "  retention_count: 9",
        "hygiene:",
        "  dedup_threshold: 0.9",
        "  resolver_cmd: ./resolve.sh",
        "discipline_report:",
        "  enabled: true",
        "  timezone: Europe/Berlin",
        "  watched_paths: [src, docs]",
        "  known_agents: [claude]",
        "",
      ].join("\n"),
    );
    const fromFile = loadBrainConfig(env.vault);
    const store = openStore({ root: env.storeRoot, device: "dev-a" });
    const imported = importBrainSettings(env.vault, store, "test");
    appendFileSync(env.configPath, imported.device.map((d) => `${d.line}\n`).join(""));
    const fromStore = readBrainSettingsFromStore({ configPath: env.configPath }).config;
    expect(fromStore).toEqual(fromFile);
    expect(fromStore.dream.candidate_threshold).toBe(4);
    expect(fromStore.snapshots.retention_count).toBe(9);
    expect(fromStore.discipline_report?.timezone).toBe("Europe/Berlin");
  });

  test("a folded value that does not validate raises instead of answering defaults", () => {
    env = makeStoreEnv("osb-settings-bad-", { legacyTree: false, configureVault: false });
    setShared(env, brainSettingKey("dream", "candidate_threshold"), -1);
    expect(() => loadBrainConfig(null)).toThrow(BrainConfigError);
    expect(brainConfigUnreadableReport(null)).toContain("The brain settings could not be read");
    // No file to fix: the remedy names the settings verb and the config line.
    expect(brainConfigUnreadableReport(null)).toContain("o2b brain settings set");
    expect(brainConfigUnreadableReport(null)).not.toContain("Fix the file");
  });

  test("a vault with no Brain/ tree is store-only and reads the store", () => {
    env = makeStoreEnv("osb-settings-fresh-vault-", { legacyTree: false });
    setShared(env, brainSettingKey("dream", "candidate_threshold"), 6);
    appendFileSync(env.configPath, "brain_maintenance_host_pressure_percent: 80\n");
    expect(loadBrainConfig(env.vault).dream.candidate_threshold).toBe(6);
    expect(loadMaintenanceConfigSafe(env.vault).host_pressure_percent).toBe(80);
  });

  test("an unswitched machine keeps reading _brain.yaml and ignores the records", () => {
    env = makeStoreEnv("osb-settings-legacy-");
    setShared(env, brainSettingKey("dream", "candidate_threshold"), 9);
    expect(loadBrainConfig(env.vault).dream.candidate_threshold).toBe(
      DEFAULT_BRAIN_CONFIG.dream.candidate_threshold,
    );
    expect(loadBrainConfigDetailed(env.vault).path).toBe(brainConfigPath(env.vault));
  });

  test("a switched machine reads the store even when _brain.yaml is still there", () => {
    env = makeStoreEnv("osb-settings-switched-");
    writeFileSync(
      brainConfigPath(env.vault),
      "schema_version: 1\ndream:\n  candidate_threshold: 4\n",
    );
    setShared(env, brainSettingKey("dream", "candidate_threshold"), 6);
    const store = openStore({ root: env.storeRoot, device: "dev-a" });
    appendRecord(store, {
      partition: "shared",
      stream: "settings",
      kind: "device-switched",
      agent: "test",
      body: { authority: "human", device: "dev-a" },
    });
    expect(loadBrainConfig(env.vault).dream.candidate_threshold).toBe(6);
  });
});

/**
 * A store-only machine whose `sessions.ignore_patterns` record is in
 * dev-b's settings shard, beside a readable one of dev-a's. Returns
 * dev-b's shard.
 */
function excluded(e: StoreEnv): string {
  setShared(e, brainSettingKey("dream", "candidate_threshold"), 6);
  return appendRecord(openStore({ root: e.storeRoot, device: "dev-b" }), {
    partition: "shared",
    stream: "settings",
    kind: SETTING_SET_KIND,
    agent: "test",
    body: {
      authority: "human",
      key: brainSettingKey("sessions", "ignore_patterns"),
      value: ["secret-*"],
    },
  }).path;
}

/** As a fresh process meets the shard: the cached read is not reused. */
function touch(path: string): void {
  const later = new Date(Date.now() + 60_000);
  utimesSync(path, later, later);
}

describe("a capture exclusion whose settings shard cannot be seen", () => {
  // POSIX modes only, and root reads a 0000 file anyway.
  test.skipIf(CHMOD_CANNOT_DENY)("unreadable: the excluded session is not captured", () => {
    env = makeStoreEnv("osb-settings-capture-unreadable-", { legacyTree: false });
    const shard = excluded(env);
    expect(buildCaptureBoundary(env.vault).sessionDecision("secret-1")).toBe("ignore");
    chmodSync(shard, 0o000);
    try {
      touch(shard);
      expect(() => loadBrainConfig(env!.vault)).toThrow(BrainSettingsUnreadableError);
      const boundary = buildCaptureBoundary(env.vault);
      expect(boundary.sessionDecision("secret-1")).toBe("ignore");
      expect(boundary.suppressMessage("anything")).toBe(true);
      expect(boundary.warnings.join("\n")).toContain("shared/settings/dev-b/");
    } finally {
      chmodSync(shard, 0o600);
    }
    touch(shard);
    expect(buildCaptureBoundary(env.vault).sessionDecision("other-1")).toBe("capture");
  });

  test("gone since this machine read it: the excluded session is not captured", () => {
    env = makeStoreEnv("osb-settings-capture-gone-", { legacyTree: false });
    const shard = excluded(env);
    expect(buildCaptureBoundary(env.vault).sessionDecision("secret-1")).toBe("ignore");
    rmSync(shard);
    expect(() => loadBrainConfig(env!.vault)).toThrow(BrainSettingsUnreadableError);
    expect(buildCaptureBoundary(env.vault).sessionDecision("secret-1")).toBe("ignore");
  });

  test("read only in part: a corrupt exclusion line before a readable one is not captured over", () => {
    env = makeStoreEnv("osb-settings-capture-corrupt-", { legacyTree: false });
    const shard = excluded(env);
    // A later record of dev-b's shard stays readable.
    appendRecord(openStore({ root: env.storeRoot, device: "dev-b" }), {
      partition: "shared",
      stream: "settings",
      kind: SETTING_SET_KIND,
      agent: "test",
      body: { authority: "human", key: "view.language", value: "en" },
    });
    expect(buildCaptureBoundary(env.vault).sessionDecision("secret-1")).toBe("ignore");
    const lines = readFileSync(shard, "utf8").split("\n");
    lines[0] = lines[0]!.replace("secret-*", "secret-?");
    writeFileSync(shard, lines.join("\n"));
    expect(() => loadBrainConfig(env!.vault)).toThrow(BrainSettingsUnreadableError);
    expect(buildCaptureBoundary(env.vault).sessionDecision("secret-1")).toBe("ignore");
    expect(buildCaptureBoundary(env.vault).sessionDecision("other-1")).toBe("ignore");
  });
});

describe("a switched machine whose store cannot be opened", () => {
  const cases: ReadonlyArray<[string, (e: StoreEnv) => void]> = [
    [
      "every store.json gone",
      (e) => {
        rmSync(join(e.storeRoot, "shared", "store.json"));
        rmSync(join(e.storeRoot, "private", "store.json"));
      },
    ],
    ["only shared/store.json gone", (e) => rmSync(join(e.storeRoot, "shared", "store.json"))],
  ];
  for (const [name, breakStore] of cases) {
    test(`${name}: capture closes and no default is answered`, () => {
      env = makeStoreEnv("osb-settings-nostore-");
      excluded(env);
      switchDevice(env.storeRoot);
      // The first answer that sees the switch records the sticky marker.
      expect(buildCaptureBoundary(env.vault).sessionDecision("secret-1")).toBe("ignore");
      expect(buildCaptureBoundary(env.vault).sessionDecision("other-1")).toBe("capture");
      breakStore(env);
      expect(() => loadBrainConfig(env!.vault)).toThrow(BrainSettingsUnreadableError);
      expect(() => readRawBrainSettingsFromStore()).toThrow(BrainSettingsUnreadableError);
      const boundary = buildCaptureBoundary(env.vault);
      expect(boundary.sessionDecision("secret-1")).toBe("ignore");
      expect(boundary.sessionDecision("other-1")).toBe("ignore");
      expect(boundary.suppressMessage("anything")).toBe(true);
    });
  }
});
