/**
 * The shared brain settings writer (task 2.11 follow-up, design D4 and
 * D14 item 3): a store-only machine writes `setting-set` / `setting-unset`
 * records and never a byte under `Brain/`; an unswitched machine edits
 * `_brain.yaml` as before. Only shared keys are written; a device key is
 * answered with the machine-config key to set instead; values pass the
 * `_brain.yaml` validator in both modes.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { brainConfigPath } from "../../../src/core/brain/paths.ts";
import { DEFAULT_BRAIN_CONFIG } from "../../../src/core/brain/policy/defaults.ts";
import { loadBrainConfig } from "../../../src/core/brain/policy/load.ts";
import {
  BrainSettingError,
  getBrainSetting,
  listBrainSettings,
  parseSettingValue,
  setBrainSetting,
  unsetBrainSetting,
} from "../../../src/core/brain/policy/settings-write.ts";
import { SETTING_SET_KIND, SETTING_UNSET_KIND } from "../../../src/core/store/constants.ts";
import { appendRecord } from "../../../src/core/store/appender.ts";
import { openStore } from "../../../src/core/store/store-open.ts";
import { makeStoreEnv, type StoreEnv } from "../store/fixtures/store-env.ts";
import { brainTreeDigest, partitionRecords, switchDevice } from "./store-only/fixtures.ts";

let env: StoreEnv | null = null;
afterEach(() => {
  env?.cleanup();
  env = null;
});

function settingRecords(e: StoreEnv) {
  return partitionRecords(e.storeRoot, "shared").filter(
    (r) => r.kind === SETTING_SET_KIND || r.kind === SETTING_UNSET_KIND,
  );
}

function switched(prefix: string): StoreEnv {
  const e = makeStoreEnv(prefix);
  switchDevice(e.storeRoot);
  return e;
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

describe("store-only machine", () => {
  test("set writes one human setting-set record and nothing under Brain/", () => {
    env = switched("osb-setw-store-");
    const before = brainTreeDigest(env.vault);
    const result = setBrainSetting(
      { vault: env.vault, authority: "human", agent: "tester" },
      "dream.candidate_threshold",
      7,
    );
    expect(result).toMatchObject({
      name: "dream.candidate_threshold",
      key: "brain.dream.candidate_threshold",
      value: 7,
      changed: true,
      mode: "store",
    });
    expect(result.record).toMatch(/^[0-9A-Z]{26}$/);
    expect(brainTreeDigest(env.vault)).toBe(before);
    const records = settingRecords(env);
    expect(records).toHaveLength(1);
    expect(records[0]!.body).toMatchObject({
      authority: "human",
      key: "brain.dream.candidate_threshold",
      value: 7,
    });
    expect(records[0]!.id).toBe(result.record!);
    expect(loadBrainConfig(env.vault).dream.candidate_threshold).toBe(7);
  });

  test("works with no vault configured", () => {
    env = makeStoreEnv("osb-setw-novault-", { legacyTree: false, configureVault: false });
    setBrainSetting({ vault: null, authority: "human", agent: "t" }, "primary_agent", "claude");
    expect(loadBrainConfig(null).primary_agent).toBe("claude");
    expect(getBrainSetting({ vault: null }, "primary_agent")).toMatchObject({
      set: true,
      value: "claude",
      authority: "human",
      source: "store",
    });
  });

  test("the same value again writes nothing", () => {
    env = switched("osb-setw-same-");
    const ctx = { vault: env.vault, authority: "human" as const, agent: "t" };
    setBrainSetting(ctx, "notes.read_paths", ["Projects/"]);
    const again = setBrainSetting(ctx, "notes.read_paths", ["Projects/"]);
    expect(again.changed).toBe(false);
    expect(settingRecords(env)).toHaveLength(1);
  });

  test("unset writes a tombstone and the default comes back", () => {
    env = switched("osb-setw-unset-");
    const ctx = { vault: env.vault, authority: "human" as const, agent: "t" };
    setBrainSetting(ctx, "dream.candidate_threshold", 9);
    const result = unsetBrainSetting(ctx, "dream.candidate_threshold");
    expect(result.changed).toBe(true);
    expect(settingRecords(env).at(-1)!.kind).toBe(SETTING_UNSET_KIND);
    expect(loadBrainConfig(env.vault).dream.candidate_threshold).toBe(
      DEFAULT_BRAIN_CONFIG.dream.candidate_threshold,
    );
    expect(unsetBrainSetting(ctx, "dream.candidate_threshold").changed).toBe(false);
  });

  test("an agent cannot override or unset a human value; nothing is written", () => {
    env = switched("osb-setw-auth-");
    setBrainSetting(
      { vault: env.vault, authority: "human", agent: "u" },
      "dream.heal_enrich_enabled",
      true,
    );
    const agent = { vault: env.vault, authority: "agent" as const, agent: "a" };
    expect(errorOf(() => setBrainSetting(agent, "dream.heal_enrich_enabled", false)).code).toBe(
      "human_value_in_force",
    );
    expect(errorOf(() => unsetBrainSetting(agent, "dream.heal_enrich_enabled")).code).toBe(
      "human_value_in_force",
    );
    expect(settingRecords(env)).toHaveLength(1);
  });

  test("an agent cannot change a setting while the shard of the human value is gone", () => {
    env = switched("osb-setw-gone-");
    // The operator's value sits in a peer's settings shard.
    const shard = appendRecord(openStore({ root: env.storeRoot, device: "dev-b" }), {
      partition: "shared",
      stream: "settings",
      kind: SETTING_SET_KIND,
      agent: "u",
      body: { authority: "human", key: "brain.dream.heal_enrich_enabled", value: true },
    }).path;
    const agent = { vault: env.vault, authority: "agent" as const, agent: "a" };
    expect(errorOf(() => setBrainSetting(agent, "dream.heal_enrich_enabled", false)).code).toBe(
      "human_value_in_force",
    );
    rmSync(shard);
    const before = settingRecords(env).length;
    expect(errorOf(() => setBrainSetting(agent, "dream.heal_enrich_enabled", false)).code).toBe(
      "settings_unreadable",
    );
    expect(settingRecords(env)).toHaveLength(before);
  });

  test("an agent cannot change a setting while the switched machine's store cannot be opened", () => {
    env = switched("osb-setw-nostore-");
    setBrainSetting(
      { vault: env.vault, authority: "human", agent: "u" },
      "dream.heal_enrich_enabled",
      true,
    );
    const agent = { vault: env.vault, authority: "agent" as const, agent: "a" };
    expect(errorOf(() => setBrainSetting(agent, "dream.heal_enrich_enabled", false)).code).toBe(
      "human_value_in_force",
    );
    rmSync(join(env.storeRoot, "shared", "store.json"));
    rmSync(join(env.storeRoot, "private", "store.json"));
    expect(errorOf(() => setBrainSetting(agent, "dream.heal_enrich_enabled", false)).code).toBe(
      "settings_unreadable",
    );
  });

  test("an agent value lands with agent authority and a human one replaces it", () => {
    env = switched("osb-setw-agent-");
    setBrainSetting(
      { vault: env.vault, authority: "agent", agent: "a" },
      "dream.candidate_threshold",
      4,
    );
    expect(settingRecords(env)[0]!.body["authority"]).toBe("agent");
    setBrainSetting(
      { vault: env.vault, authority: "human", agent: "u" },
      "dream.candidate_threshold",
      6,
    );
    expect(loadBrainConfig(env.vault).dream.candidate_threshold).toBe(6);
  });

  test("list names every shared setting that is set, with its authority", () => {
    env = switched("osb-setw-list-");
    setBrainSetting(
      { vault: env.vault, authority: "human", agent: "u" },
      "primary_agent",
      "claude",
    );
    setBrainSetting(
      { vault: env.vault, authority: "agent", agent: "a" },
      "guardrails.derived_fact_synthesis",
      true,
    );
    const list = listBrainSettings({ vault: env.vault });
    expect(list.mode).toBe("store");
    expect(list.settings.map((s) => [s.name, s.value, s.authority])).toEqual([
      ["guardrails.derived_fact_synthesis", true, "agent"],
      ["primary_agent", "claude", "human"],
    ]);
  });
});

describe("unswitched machine", () => {
  test("set edits _brain.yaml in place and writes no settings record", () => {
    env = makeStoreEnv("osb-setw-legacy-");
    const path = brainConfigPath(env.vault);
    const before = readFileSync(path, "utf8");
    const result = setBrainSetting(
      { vault: env.vault, authority: "human", agent: "t" },
      "dream.candidate_threshold",
      11,
    );
    expect(result).toMatchObject({ mode: "legacy", changed: true, value: 11 });
    expect(result.record).toBeUndefined();
    const after = readFileSync(path, "utf8");
    expect(after).not.toBe(before);
    expect(after).toContain("candidate_threshold: 11");
    // Every other line is kept, comments included.
    expect(after.split("\n").length).toBe(before.split("\n").length);
    expect(loadBrainConfig(env.vault).dream.candidate_threshold).toBe(11);
    expect(settingRecords(env)).toHaveLength(0);
  });

  test("a list value and a new field are written in the file's layout", () => {
    env = makeStoreEnv("osb-setw-legacy-list-");
    const ctx = { vault: env.vault, authority: "human" as const, agent: "t" };
    setBrainSetting(ctx, "notes.read_paths", ["Projects/", "Areas/x y"]);
    expect(loadBrainConfig(env.vault).notes?.read_paths).toEqual(["Projects/", "Areas/x y"]);
    setBrainSetting(ctx, "notes.read_paths", ["Only/"]);
    expect(loadBrainConfig(env.vault).notes?.read_paths).toEqual(["Only/"]);
    expect(getBrainSetting({ vault: env.vault }, "notes.read_paths")).toMatchObject({
      set: true,
      value: ["Only/"],
      source: "brain-yaml",
    });
  });

  test("unset removes the field and the default comes back", () => {
    env = makeStoreEnv("osb-setw-legacy-unset-");
    const ctx = { vault: env.vault, authority: "human" as const, agent: "t" };
    setBrainSetting(ctx, "primary_agent", "claude");
    expect(loadBrainConfig(env.vault).primary_agent).toBe("claude");
    expect(unsetBrainSetting(ctx, "primary_agent").changed).toBe(true);
    expect(loadBrainConfig(env.vault).primary_agent).toBeNull();
    setBrainSetting(ctx, "dream.candidate_threshold", 12);
    unsetBrainSetting(ctx, "dream.candidate_threshold");
    expect(loadBrainConfig(env.vault).dream.candidate_threshold).toBe(
      DEFAULT_BRAIN_CONFIG.dream.candidate_threshold,
    );
  });

  test("an invalid value leaves the file untouched", () => {
    env = makeStoreEnv("osb-setw-legacy-bad-");
    const path = brainConfigPath(env.vault);
    const before = readFileSync(path, "utf8");
    const err = errorOf(() =>
      setBrainSetting(
        { vault: env!.vault, authority: "human", agent: "t" },
        "dream.candidate_threshold",
        -3,
      ),
    );
    expect(err.code).toBe("invalid_setting_value");
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("a vault without _brain.yaml is told to run brain init", () => {
    env = makeStoreEnv("osb-setw-legacy-nofile-");
    rmSync(brainConfigPath(env.vault));
    const err = errorOf(() =>
      setBrainSetting({ vault: env!.vault, authority: "human", agent: "t" }, "primary_agent", "x"),
    );
    expect(err.code).toBe("no_settings_file");
  });
});

describe("key classification and value validation (both modes)", () => {
  for (const mode of ["store", "legacy"] as const) {
    const make = (): StoreEnv =>
      mode === "store" ? switched(`osb-setw-cls-${mode}-`) : makeStoreEnv(`osb-setw-cls-${mode}-`);

    test(`${mode}: a device key answers with the machine-config key to set`, () => {
      env = make();
      const err = errorOf(() =>
        setBrainSetting(
          { vault: env!.vault, authority: "human", agent: "t" },
          "snapshots.retention_count",
          3,
        ),
      );
      expect(err.code).toBe("device_setting");
      expect(err.configKey).toBe("brain_snapshots_retention_count");
      expect(err.message).toContain("brain_snapshots_retention_count: 3");
      const field = errorOf(() =>
        setBrainSetting(
          { vault: env!.vault, authority: "human", agent: "t" },
          "decision_model.provider",
          "x",
        ),
      );
      expect(field.code).toBe("device_setting");
      expect(field.configKey).toBe("brain_decision_model_provider");
    });

    test(`${mode}: unknown keys, schema_version and a whole block are refused`, () => {
      env = make();
      const ctx = { vault: env.vault, authority: "human" as const, agent: "t" };
      expect(errorOf(() => setBrainSetting(ctx, "nope.field", 1)).code).toBe("unknown_setting");
      expect(errorOf(() => setBrainSetting(ctx, "dream.no_such_field", 1)).code).toBe(
        "unknown_setting",
      );
      expect(errorOf(() => setBrainSetting(ctx, "schema_version", 2)).code).toBe("not_a_setting");
      expect(errorOf(() => setBrainSetting(ctx, "dream", 1)).code).toBe("field_required");
    });

    test(`${mode}: a value the validator rejects is refused`, () => {
      env = make();
      const ctx = { vault: env.vault, authority: "human" as const, agent: "t" };
      expect(errorOf(() => setBrainSetting(ctx, "dream.candidate_threshold", "many")).code).toBe(
        "invalid_setting_value",
      );
      expect(errorOf(() => setBrainSetting(ctx, "notes.read_paths", { a: 1 })).code).toBe(
        "invalid_setting_value",
      );
    });
  }

  test("the brain. prefix is accepted and dropped", () => {
    env = switched("osb-setw-prefix-");
    const r = setBrainSetting(
      { vault: env.vault, authority: "human", agent: "t" },
      "brain.dream.candidate_threshold",
      5,
    );
    expect(r.name).toBe("dream.candidate_threshold");
  });
});

describe("parseSettingValue", () => {
  test("JSON first, else the bare string", () => {
    expect(parseSettingValue("5")).toBe(5);
    expect(parseSettingValue("true")).toBe(true);
    expect(parseSettingValue('["a","b"]')).toEqual(["a", "b"]);
    expect(parseSettingValue('"5"')).toBe("5");
    expect(parseSettingValue("claude")).toBe("claude");
  });
});
