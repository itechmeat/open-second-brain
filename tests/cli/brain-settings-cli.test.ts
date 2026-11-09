/**
 * `o2b brain settings get|set|unset|list` and `o2b brain set-primary` on a
 * store-only machine (with and without a vault) and on an unswitched one.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { brainConfigPath } from "../../src/core/brain/paths.ts";
import { SETTING_SET_KIND } from "../../src/core/store/constants.ts";
import { runCli } from "../helpers/run-cli.ts";
import {
  brainTreeDigest,
  partitionRecords,
  switchDevice,
} from "../core/brain/store-only/fixtures.ts";
import { makeStoreEnv, type StoreEnv } from "../core/store/fixtures/store-env.ts";

let env: StoreEnv | null = null;
afterEach(() => {
  env?.cleanup();
  env = null;
});

/** Run the CLI against this test's machine config (the runner drops the variable otherwise). */
function cli(args: ReadonlyArray<string>) {
  return runCli(args, { env: { OPEN_SECOND_BRAIN_CONFIG: env!.configPath } });
}

function settingSets(e: StoreEnv) {
  return partitionRecords(e.storeRoot, "shared").filter((r) => r.kind === SETTING_SET_KIND);
}

describe("o2b brain settings on a store-only machine", () => {
  test("set, get, list and unset write records and no byte under Brain/", async () => {
    env = makeStoreEnv("osb-setcli-store-");
    switchDevice(env.storeRoot);
    const before = brainTreeDigest(env.vault);

    const set = await cli(["brain", "settings", "set", "notes.read_paths", '["Projects/"]']);
    expect(set.returncode).toBe(0);
    expect(set.stdout).toContain('notes.read_paths: null -> ["Projects/"] (record ');
    expect(settingSets(env)[0]!.body).toMatchObject({
      authority: "human",
      key: "brain.notes.read_paths",
      value: ["Projects/"],
    });

    const get = await cli(["brain", "settings", "get", "notes.read_paths", "--json"]);
    expect(get.returncode).toBe(0);
    expect(JSON.parse(get.stdout)).toMatchObject({
      name: "notes.read_paths",
      set: true,
      value: ["Projects/"],
      authority: "human",
      source: "store",
    });

    const list = await cli(["brain", "settings", "list"]);
    expect(list.stdout).toContain('notes.read_paths = ["Projects/"] (store, human');

    const unset = await cli(["brain", "settings", "unset", "notes.read_paths"]);
    expect(unset.returncode).toBe(0);
    expect(unset.stdout).toContain("notes.read_paths: unset, the default applies");
    expect(brainTreeDigest(env.vault)).toBe(before);
  });

  test("works with no vault configured", async () => {
    env = makeStoreEnv("osb-setcli-novault-", { legacyTree: false, configureVault: false });
    const set = await cli(["brain", "settings", "set", "decision_model.enabled", "false"]);
    expect(set.returncode).toBe(0);
    const get = await cli(["brain", "settings", "get", "decision_model.enabled"]);
    expect(get.stdout).toContain("decision_model.enabled = false (store, human");
  });

  test("a device key exits 2 and names the machine-config line", async () => {
    env = makeStoreEnv("osb-setcli-device-", { legacyTree: false, configureVault: false });
    const res = await cli(["brain", "settings", "set", "storage.max_bytes", "10"]);
    expect(res.returncode).toBe(2);
    expect(res.stderr).toContain("brain_storage_max_bytes: 10");
    expect(settingSets(env)).toHaveLength(0);
  });

  test("an invalid value exits 1 and writes nothing", async () => {
    env = makeStoreEnv("osb-setcli-bad-", { legacyTree: false, configureVault: false });
    const res = await cli(["brain", "settings", "set", "dream.candidate_threshold", "-1"]);
    expect(res.returncode).toBe(1);
    expect(settingSets(env)).toHaveLength(0);
  });

  test("set-primary writes the shared setting, not _brain.yaml", async () => {
    env = makeStoreEnv("osb-setcli-primary-");
    switchDevice(env.storeRoot);
    const before = brainTreeDigest(env.vault);
    const res = await cli(["brain", "set-primary", "claude", "--json"]);
    expect(res.returncode).toBe(0);
    expect(JSON.parse(res.stdout)).toMatchObject({ previous: null, next: "claude", changed: true });
    expect(settingSets(env).map((r) => r.body["key"])).toEqual(["brain.primary_agent"]);
    expect(brainTreeDigest(env.vault)).toBe(before);
    const clear = await cli(["brain", "set-primary", "--clear", "--json"]);
    expect(JSON.parse(clear.stdout)).toMatchObject({
      previous: "claude",
      next: null,
      changed: true,
    });
  });
});

describe("o2b brain set-primary --agent", () => {
  test("a blank --agent falls back to the configured agent, never a blank attribution", async () => {
    env = makeStoreEnv("osb-setcli-primary-agent-");
    switchDevice(env.storeRoot);
    const res = await cli(["brain", "set-primary", "claude", "--agent", "  "]);
    expect(res.returncode).toBe(0);
    const agent = settingSets(env)[0]!.agent;
    expect(agent.trim()).not.toBe("");
    const named = await cli(["brain", "set-primary", "codex", "--agent", "ops"]);
    expect(named.returncode).toBe(0);
    expect(settingSets(env)[1]!.agent).toBe("ops");
  });
});

describe("o2b brain settings on an unswitched machine", () => {
  test("set edits _brain.yaml and writes no settings record", async () => {
    env = makeStoreEnv("osb-setcli-legacy-");
    const res = await cli(["brain", "settings", "set", "dream.candidate_threshold", "9"]);
    expect(res.returncode).toBe(0);
    expect(res.stdout).not.toContain("record");
    expect(readFileSync(brainConfigPath(env.vault), "utf8")).toContain("candidate_threshold: 9");
    expect(settingSets(env)).toHaveLength(0);
    const get = await cli(["brain", "settings", "get", "dream.candidate_threshold"]);
    expect(get.stdout).toContain("dream.candidate_threshold = 9 (settings file)");
  });

  test("set-primary keeps editing _brain.yaml", async () => {
    env = makeStoreEnv("osb-setcli-legacy-primary-");
    const res = await cli(["brain", "set-primary", "claude"]);
    expect(res.returncode).toBe(0);
    expect(readFileSync(brainConfigPath(env.vault), "utf8")).toContain('primary_agent: "claude"');
    expect(settingSets(env)).toHaveLength(0);
  });
});
