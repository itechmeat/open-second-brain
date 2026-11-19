/**
 * `migration.silent_device_days` (change stale-device-retirement, design
 * D4): a store-native shared setting, an integer from 0 to 3650 with the
 * default 30, that only the operator sets, read through the shared
 * settings fold every machine of the store agrees on.
 */
import { afterEach, describe, expect, test } from "bun:test";

import {
  BrainSettingError,
  getBrainSetting,
  setBrainSetting,
} from "../../../src/core/brain/policy/settings-write.ts";
import { SETTING_SET_KIND, SETTING_SILENT_DEVICE_DAYS } from "../../../src/core/store/constants.ts";
import { buildRecord, type StoreRecord } from "../../../src/core/store/envelope.ts";
import { foldSettings, settingValue } from "../../../src/core/store/fold-settings.ts";
import { makeStoreEnv, type StoreEnv } from "../store/fixtures/store-env.ts";
import { partitionRecords, switchDevice } from "./store-only/fixtures.ts";

let env: StoreEnv | null = null;
afterEach(() => {
  env?.cleanup();
  env = null;
});

function record(value: unknown, n: number): StoreRecord {
  return buildRecord({
    hlc: { physical: 1_700_000_000_000 + n, counter: 0 },
    device: "dev-a",
    agent: "t",
    kind: SETTING_SET_KIND,
    body: { authority: "human", key: SETTING_SILENT_DEVICE_DAYS, value },
  });
}

describe("the setting in the shared settings fold", () => {
  test("defaults to 30 days", () => {
    expect(SETTING_SILENT_DEVICE_DAYS).toBe("migration.silent_device_days");
    expect(settingValue(foldSettings([]), SETTING_SILENT_DEVICE_DAYS)).toBe(30);
  });

  for (const value of [0, 1, 60, 3650]) {
    test(`accepts ${value}`, () => {
      expect(settingValue(foldSettings([record(value, 1)]), SETTING_SILENT_DEVICE_DAYS)).toBe(
        value,
      );
    });
  }

  for (const value of [-1, 3651, 1.5, "30", true]) {
    test(`rejects ${JSON.stringify(value)} and keeps the default`, () => {
      const fold = foldSettings([record(value, 1)]);
      expect(fold.rejected).toHaveLength(1);
      expect(settingValue(fold, SETTING_SILENT_DEVICE_DAYS)).toBe(30);
    });
  }
});

describe("the setting through the settings writer", () => {
  test("the operator sets it on a switched machine; every reader sees the store value", () => {
    env = makeStoreEnv("osb-silent-days-");
    switchDevice(env.storeRoot);
    const result = setBrainSetting(
      { vault: env.vault, authority: "human", agent: "t" },
      SETTING_SILENT_DEVICE_DAYS,
      0,
    );
    expect(result).toMatchObject({ key: SETTING_SILENT_DEVICE_DAYS, value: 0, changed: true });
    expect(
      settingValue(
        foldSettings(partitionRecords(env.storeRoot, "shared")),
        SETTING_SILENT_DEVICE_DAYS,
      ),
    ).toBe(0);
    expect(getBrainSetting({ vault: env.vault }, SETTING_SILENT_DEVICE_DAYS)).toMatchObject({
      set: true,
      value: 0,
    });
  });

  test("an agent may not set it: it decides when the legacy tree may leave the vault", () => {
    env = makeStoreEnv("osb-silent-days-agent-");
    switchDevice(env.storeRoot);
    let error: unknown = null;
    try {
      setBrainSetting(
        { vault: env.vault, authority: "agent", agent: "t" },
        SETTING_SILENT_DEVICE_DAYS,
        1,
      );
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(BrainSettingError);
    expect((error as BrainSettingError).code).toBe("operator_only_setting");
  });

  test("an out-of-range value is refused before anything is written", () => {
    env = makeStoreEnv("osb-silent-days-range-");
    switchDevice(env.storeRoot);
    let error: unknown = null;
    try {
      setBrainSetting(
        { vault: env.vault, authority: "human", agent: "t" },
        SETTING_SILENT_DEVICE_DAYS,
        -5,
      );
    } catch (err) {
      error = err;
    }
    expect((error as BrainSettingError).code).toBe("invalid_setting_value");
  });
});
