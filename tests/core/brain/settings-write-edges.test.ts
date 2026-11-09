/**
 * Edges of the brain settings writer: an unset of a top-level scalar in
 * `_brain.yaml` removes the key, `list` works on a vault with no settings
 * file yet, a settings write holds the lock the schema mutation takes on
 * the file, and an agent refused over an operator's reset is told so.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import lockfile from "proper-lockfile";

import { brainConfigPath } from "../../../src/core/brain/paths.ts";
import {
  getBrainSetting,
  listBrainSettings,
  setBrainSetting,
  unsetBrainSetting,
} from "../../../src/core/brain/policy/settings-write.ts";
import { makeStoreEnv, type StoreEnv } from "../store/fixtures/store-env.ts";

let env: StoreEnv | null = null;
afterEach(() => {
  env?.cleanup();
  env = null;
});

const human = (vault: string | null) => ({ vault, authority: "human" as const, agent: "t" });
const agent = (vault: string | null) => ({ vault, authority: "agent" as const, agent: "t" });

describe("the settings writer on an unswitched machine", () => {
  test("unsetting a top-level scalar removes the key from _brain.yaml", () => {
    env = makeStoreEnv("osb-settings-unset-scalar-");
    setBrainSetting(human(env.vault), "primary_agent", "claude");
    unsetBrainSetting(human(env.vault), "primary_agent");
    expect(readFileSync(brainConfigPath(env.vault), "utf8")).not.toMatch(/^primary_agent:/m);
    expect(getBrainSetting({ vault: env.vault }, "primary_agent").set).toBe(false);
  });

  test("list answers on a vault with no settings file yet", () => {
    env = makeStoreEnv("osb-settings-list-nofile-");
    rmSync(brainConfigPath(env.vault));
    expect(listBrainSettings({ vault: env.vault }).settings).toEqual([]);
  });

  test("a write does not run while a schema mutation holds the file lock", () => {
    env = makeStoreEnv("osb-settings-lock-");
    const path = brainConfigPath(env.vault);
    const release = lockfile.lockSync(path, { stale: 30_000, realpath: false });
    try {
      expect(() => setBrainSetting(human(env!.vault), "dream.candidate_threshold", 7)).toThrow(
        /lock/,
      );
    } finally {
      release();
    }
    setBrainSetting(human(env.vault), "dream.candidate_threshold", 7);
    expect(getBrainSetting({ vault: env.vault }, "dream.candidate_threshold").value).toBe(7);
  });
});

describe("the settings writer once switched", () => {
  test("an agent refused over an operator's reset is told it was reset", () => {
    env = makeStoreEnv("osb-settings-reset-", { legacyTree: false, configureVault: false });
    setBrainSetting(human(null), "dream.candidate_threshold", 6);
    unsetBrainSetting(human(null), "dream.candidate_threshold");
    expect(() => setBrainSetting(agent(null), "dream.candidate_threshold", 3)).toThrow(
      /reset to its default by the operator/,
    );
  });
});
