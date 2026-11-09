/**
 * Settings that hold a safety or privacy boundary (the integrity gates,
 * the agent's note read scope, the vault and capture boundaries, the
 * write binding, the promotion guardrails) are the operator's alone: an
 * agent-authority write (`brain_settings`) is refused with
 * `operator_only_setting` and the CLI line to run, before the switch and
 * after it, whether or not the operator ever set the key; the operator
 * (`o2b brain settings`, human authority) sets and unsets them.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { brainConfigPath } from "../../../src/core/brain/paths.ts";
import {
  BrainSettingError,
  setBrainSetting,
  unsetBrainSetting,
} from "../../../src/core/brain/policy/settings-write.ts";
import { OPERATOR_ONLY_SETTINGS } from "../../../src/core/brain/policy/settings-keys.ts";
import { makeStoreEnv, type StoreEnv } from "../store/fixtures/store-env.ts";
import { partitionRecords, switchDevice } from "./store-only/fixtures.ts";

let env: StoreEnv | null = null;
afterEach(() => {
  env?.cleanup();
  env = null;
});

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof BrainSettingError) return `${err.code}: ${err.message}`;
    throw err;
  }
  return "no error";
}

/** A value each protected setting accepts. */
const VALUES: Readonly<Record<string, unknown>> = {
  "integrity.owner_scope_delivery": "off",
  "integrity.owner_scope_writes": "off",
  "integrity.embedding_abi": "off",
  "integrity.pack_validity_seconds": 86400,
  "notes.read_paths": ["Private"],
  "vault.ignore_paths": [],
  "vault.include_paths": ["Everything"],
  "write_binding.path_prefixes": ["Notes"],
  "sessions.ignore_patterns": [],
  "sessions.stateless_patterns": [],
  "sessions.ignore_message_patterns": [],
  "guardrails.promotion_min_signals": 1,
  "guardrails.promotion_min_distinct_agents": 1,
  "guardrails.promotion_min_age_days": 0,
  "guardrails.instruction_file_max_lines": 1000,
  "guardrails.untrusted_source_delimiting": false,
  "guardrails.provenance_trust_ordering": false,
  "guardrails.owner_scoped_facts": false,
  "decision_model.enabled": true,
};

const agent = (vault: string) => ({ vault, authority: "agent" as const, agent: "a" });
const human = (vault: string) => ({ vault, authority: "human" as const, agent: "o" });

describe("operator-only settings", () => {
  test("the protected list is the one the test names", () => {
    expect([...OPERATOR_ONLY_SETTINGS].toSorted()).toEqual(Object.keys(VALUES).toSorted());
  });

  test("an agent cannot set or unset one on a store-only machine; the operator can", () => {
    env = makeStoreEnv("osb-setop-store-");
    switchDevice(env.storeRoot);
    for (const name of OPERATOR_ONLY_SETTINGS) {
      const set = codeOf(() => setBrainSetting(agent(env!.vault), name, VALUES[name]));
      expect(set).toStartWith("operator_only_setting: ");
      expect(set).toContain(`o2b brain settings set ${name}`);
      expect(codeOf(() => unsetBrainSetting(agent(env!.vault), name))).toStartWith(
        "operator_only_setting: ",
      );
    }
    expect(partitionRecords(env.storeRoot, "shared").some((r) => r.kind === "setting-set")).toBe(
      false,
    );
    const done = setBrainSetting(human(env.vault), "integrity.owner_scope_delivery", "fail");
    expect(done).toMatchObject({ changed: true, mode: "store", value: "fail" });
    expect(unsetBrainSetting(human(env.vault), "integrity.owner_scope_delivery").changed).toBe(
      true,
    );
  });

  test("an agent cannot edit one in the settings file of an unswitched machine", () => {
    env = makeStoreEnv("osb-setop-legacy-");
    const path = brainConfigPath(env.vault);
    const before = readFileSync(path, "utf8");
    expect(
      codeOf(() => setBrainSetting(agent(env!.vault), "integrity.owner_scope_delivery", "off")),
    ).toStartWith("operator_only_setting: ");
    expect(codeOf(() => setBrainSetting(agent(env!.vault), "notes.read_paths", ["X"]))).toStartWith(
      "operator_only_setting: ",
    );
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(
      setBrainSetting(human(env.vault), "integrity.owner_scope_delivery", "fail").changed,
    ).toBe(true);
  });

  test("on an unswitched machine an agent cannot override a value the operator set", () => {
    env = makeStoreEnv("osb-setop-legacy-human-");
    const path = brainConfigPath(env.vault);
    // A key still at its shipped default stays the agent's to change.
    expect(setBrainSetting(agent(env.vault), "dream.candidate_threshold", 7).changed).toBe(true);
    expect(setBrainSetting(human(env.vault), "dream.candidate_threshold", 9).changed).toBe(true);
    const before = readFileSync(path, "utf8");
    expect(
      codeOf(() => setBrainSetting(agent(env!.vault), "dream.candidate_threshold", 3)),
    ).toStartWith("human_value_in_force: ");
    expect(
      codeOf(() => unsetBrainSetting(agent(env!.vault), "dream.candidate_threshold")),
    ).toStartWith("human_value_in_force: ");
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("an agent still sets a setting that holds no boundary", () => {
    env = makeStoreEnv("osb-setop-free-");
    switchDevice(env.storeRoot);
    expect(
      setBrainSetting(agent(env.vault), "guardrails.derived_fact_synthesis", true).changed,
    ).toBe(true);
  });
});
