/**
 * `view.language` through the shared settings writer: it is a store
 * setting the view renderer reads (`core/view/render.ts`), not a
 * `_brain.yaml` key, so it is written as a `setting-set` record under its
 * own key on every machine, switched or not, and validated against the
 * languages the view has strings for.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { brainConfigPath } from "../../../src/core/brain/paths.ts";
import {
  BrainSettingError,
  getBrainSetting,
  listBrainSettings,
  setBrainSetting,
  unsetBrainSetting,
} from "../../../src/core/brain/policy/settings-write.ts";
import {
  SETTING_SET_KIND,
  SETTING_UNSET_KIND,
  SETTING_VIEW_LANGUAGE,
} from "../../../src/core/store/constants.ts";
import { foldSettings, settingValue } from "../../../src/core/store/fold-settings.ts";
import { makeStoreEnv, type StoreEnv } from "../store/fixtures/store-env.ts";
import { brainTreeDigest, partitionRecords, switchDevice } from "./store-only/fixtures.ts";

let env: StoreEnv | null = null;
afterEach(() => {
  env?.cleanup();
  env = null;
});

function language(e: StoreEnv): unknown {
  return settingValue(foldSettings(partitionRecords(e.storeRoot, "shared")), SETTING_VIEW_LANGUAGE);
}

function errorOf(fn: () => unknown): BrainSettingError {
  try {
    fn();
  } catch (err) {
    if (err instanceof BrainSettingError) return err;
    throw err;
  }
  throw new Error("expected a BrainSettingError");
}

const human = (vault: string | null) => ({ vault, authority: "human" as const, agent: "t" });

describe("view.language", () => {
  test("a switched machine writes the key the renderer reads, nothing under Brain/", () => {
    env = makeStoreEnv("osb-viewlang-store-");
    switchDevice(env.storeRoot);
    const before = brainTreeDigest(env.vault);
    const result = setBrainSetting(human(env.vault), "view.language", "ru");
    expect(result).toMatchObject({
      name: "view.language",
      key: "view.language",
      value: "ru",
      changed: true,
      mode: "store",
    });
    expect(language(env)).toBe("ru");
    expect(brainTreeDigest(env.vault)).toBe(before);
    expect(getBrainSetting({ vault: env.vault }, "view.language")).toMatchObject({
      set: true,
      value: "ru",
      authority: "human",
      source: "store",
    });
  });

  test("an unswitched machine writes it to the store too and leaves _brain.yaml alone", () => {
    env = makeStoreEnv("osb-viewlang-legacy-");
    const yaml = readFileSync(brainConfigPath(env.vault), "utf8");
    const result = setBrainSetting(human(env.vault), "view.language", "ru");
    expect(result.changed).toBe(true);
    expect(language(env)).toBe("ru");
    expect(readFileSync(brainConfigPath(env.vault), "utf8")).toBe(yaml);
    expect(getBrainSetting({ vault: env.vault }, "view.language").value).toBe("ru");
  });

  test("works with no vault, is listed, and unset brings English back", () => {
    env = makeStoreEnv("osb-viewlang-novault-", { legacyTree: false, configureVault: false });
    setBrainSetting(human(null), "view.language", "ru");
    expect(listBrainSettings({ vault: null }).settings.map((s) => s.name)).toContain(
      "view.language",
    );
    const unset = unsetBrainSetting(human(null), "view.language");
    expect(unset.changed).toBe(true);
    const kinds = partitionRecords(env.storeRoot, "shared")
      .filter((r) => r.kind === SETTING_SET_KIND || r.kind === SETTING_UNSET_KIND)
      .map((r) => r.kind);
    expect(kinds).toEqual([SETTING_SET_KIND, SETTING_UNSET_KIND]);
    expect(language(env)).toBeNull();
    expect(getBrainSetting({ vault: null }, "view.language")).toMatchObject({
      set: false,
      default: "en",
    });
  });

  test("the brain. prefix names it as it names every other setting", () => {
    env = makeStoreEnv("osb-viewlang-prefix-", { legacyTree: false, configureVault: false });
    setBrainSetting(human(null), "brain.view.language", "ru");
    expect(getBrainSetting({ vault: null }, "view.language").value).toBe("ru");
  });

  test("a language the view has no strings for is refused, naming the ones it has", () => {
    env = makeStoreEnv("osb-viewlang-bad-", { legacyTree: false, configureVault: false });
    const unknown = errorOf(() => setBrainSetting(human(null), "view.language", "xx"));
    expect(unknown.code).toBe("invalid_setting_value");
    expect(unknown.message).toContain("en, ru");
    expect(errorOf(() => setBrainSetting(human(null), "view.language", 3)).code).toBe(
      "invalid_setting_value",
    );
    expect(language(env)).toBeNull();
  });

  test("a regional tag of a supported language is accepted", () => {
    env = makeStoreEnv("osb-viewlang-region-", { legacyTree: false, configureVault: false });
    setBrainSetting(human(null), "view.language", "ru-RU");
    expect(language(env)).toBe("ru-RU");
  });
});
