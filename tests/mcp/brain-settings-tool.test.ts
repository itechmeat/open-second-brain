/**
 * `brain_settings`, the MCP twin of `o2b brain settings`: agent-authority
 * records on a store-only machine (and on a server with no vault), the
 * operator's value never outvoted, device keys answered with the config
 * key, the settings file edited on an unswitched machine.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { brainConfigPath } from "../../src/core/brain/paths.ts";
import { setBrainSetting } from "../../src/core/brain/policy/settings-write.ts";
import { TRANSPORT_REACH, type TransportReach } from "../../src/core/graph/transport-reach.ts";
import { SETTING_SET_KIND } from "../../src/core/store/constants.ts";
import { JSONRPC_VERSION, MCPServer, PROTOCOL_VERSION } from "../../src/mcp/index.ts";
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

interface Answer {
  readonly result?: Record<string, unknown>;
  readonly error?: { readonly message: string; readonly data?: Record<string, unknown> };
}

async function call(server: MCPServer, args: Record<string, unknown>): Promise<Answer> {
  const r = (await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 2,
    method: "tools/call",
    params: { name: "brain_settings", arguments: args },
  })) as {
    result?: { content: ReadonlyArray<{ text: string }>; isError?: boolean };
    error?: { message: string; data?: Record<string, unknown> };
  };
  if (r.error) return { error: r.error };
  const text = r.result!.content[0]!.text;
  if (r.result!.isError) return { error: { message: text } };
  return { result: JSON.parse(text) as Record<string, unknown> };
}

async function serverFor(
  vault: string | null,
  configPath: string,
  reach?: TransportReach,
): Promise<MCPServer> {
  const server = new MCPServer({
    vault,
    configPath,
    ...(reach !== undefined ? { reach } : {}),
  });
  await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "t", version: "0" },
    },
  });
  return server;
}

function sets(e: StoreEnv) {
  return partitionRecords(e.storeRoot, "shared").filter((r) => r.kind === SETTING_SET_KIND);
}

describe("brain_settings on a store-only machine", () => {
  test("set writes an agent-authority record and nothing under Brain/", async () => {
    env = makeStoreEnv("osb-settool-store-");
    switchDevice(env.storeRoot);
    const before = brainTreeDigest(env.vault);
    const server = await serverFor(env.vault, env.configPath);
    const { result } = await call(server, {
      action: "set",
      name: "guardrails.derived_fact_synthesis",
      value: true,
    });
    expect(result).toMatchObject({ changed: true, mode: "store", value: true });
    expect(sets(env)[0]!.body).toMatchObject({
      authority: "agent",
      key: "brain.guardrails.derived_fact_synthesis",
      value: true,
    });
    const got = await call(server, { action: "get", name: "guardrails.derived_fact_synthesis" });
    expect(got.result).toMatchObject({ set: true, value: true, authority: "agent" });
    const listed = await call(server, { action: "list" });
    expect(listed.result?.["settings"]).toHaveLength(1);
    expect(brainTreeDigest(env.vault)).toBe(before);
  });

  test("a record is attributed to the agent the transport minted, not the config's", async () => {
    env = makeStoreEnv("osb-settool-identity-");
    switchDevice(env.storeRoot);
    const server = await serverFor(env.vault, env.configPath);
    const reply = await server.handleRequest(
      {
        jsonrpc: JSONRPC_VERSION,
        id: 3,
        method: "tools/call",
        params: {
          name: "brain_settings",
          arguments: { action: "set", name: "guardrails.derived_fact_synthesis", value: true },
        },
      },
      { agent: "edge-agent", via: "token" },
    );
    expect(JSON.stringify(reply)).toContain('\\"changed\\": true');
    expect(sets(env)[0]!.agent).toBe("edge-agent");
  });

  test("an operator value is refused, not outvoted", async () => {
    env = makeStoreEnv("osb-settool-human-");
    switchDevice(env.storeRoot);
    setBrainSetting(
      { vault: env.vault, authority: "human", agent: "operator" },
      "dream.heal_enrich_enabled",
      true,
    );
    const server = await serverFor(env.vault, env.configPath);
    const { error } = await call(server, {
      action: "set",
      name: "dream.heal_enrich_enabled",
      value: false,
    });
    expect(error?.message).toContain("o2b brain settings set dream.heal_enrich_enabled");
    expect(error?.data?.["code"]).toBe("human_value_in_force");
    expect(sets(env)).toHaveLength(1);
    // An agent unset would remove the operator's value: refused the same way.
    const unset = await call(server, { action: "unset", name: "dream.heal_enrich_enabled" });
    expect(unset.error?.data?.["code"]).toBe("human_value_in_force");
    expect(
      partitionRecords(env.storeRoot, "shared").filter(
        (r) => r.kind !== SETTING_SET_KIND && r.kind.startsWith("setting"),
      ),
    ).toEqual([]);
    expect(sets(env)).toHaveLength(1);
    const got = await call(server, { action: "get", name: "dream.heal_enrich_enabled" });
    expect(got.result).toMatchObject({ set: true, value: true, authority: "human" });
  });

  test("a device key names the config key; an invalid value is refused", async () => {
    env = makeStoreEnv("osb-settool-device-");
    switchDevice(env.storeRoot);
    const server = await serverFor(env.vault, env.configPath);
    const device = await call(server, {
      action: "set",
      name: "embeddings.sunset_model",
      value: "m",
    });
    expect(device.error?.data).toMatchObject({
      code: "device_setting",
      config_key: "brain_embeddings_sunset_model",
    });
    const bad = await call(server, { action: "set", name: "dream.candidate_threshold", value: 0 });
    expect(bad.error?.data?.["code"]).toBe("invalid_setting_value");
    const missing = await call(server, { action: "set", name: "primary_agent" });
    expect(missing.error?.message).toContain("needs value");
    expect(sets(env)).toHaveLength(0);
  });

  test("a server with no vault reads and writes the store", async () => {
    env = makeStoreEnv("osb-settool-novault-", { legacyTree: false, configureVault: false });
    const server = await serverFor(null, env.configPath);
    const set = await call(server, { action: "set", name: "primary_agent", value: "codex" });
    expect(set.result).toMatchObject({ changed: true, mode: "store" });
    const got = await call(server, { action: "get", name: "primary_agent" });
    expect(got.result).toMatchObject({ set: true, value: "codex" });
  });
});

describe("brain_settings on an unswitched machine", () => {
  test("set edits the settings file and writes no record", async () => {
    env = makeStoreEnv("osb-settool-legacy-");
    const server = await serverFor(env.vault, env.configPath);
    const { result } = await call(server, {
      action: "set",
      name: "dream.candidate_threshold",
      value: 7,
    });
    expect(result).toMatchObject({ changed: true, mode: "legacy" });
    expect(readFileSync(brainConfigPath(env.vault), "utf8")).toContain("candidate_threshold: 7");
    expect(sets(env)).toHaveLength(0);
  });

  test("an agent cannot unset a value that differs from the default; the file is unchanged", async () => {
    env = makeStoreEnv("osb-settool-legacy-unset-");
    const server = await serverFor(env.vault, env.configPath);
    await call(server, { action: "set", name: "dream.candidate_threshold", value: 7 });
    const before = readFileSync(brainConfigPath(env.vault), "utf8");
    // `_brain.yaml` records no authority: a value off the shipped default
    // counts as the operator's (\`o2b brain settings unset\` removes it).
    const { error } = await call(server, { action: "unset", name: "dream.candidate_threshold" });
    expect(error?.data?.["code"]).toBe("human_value_in_force");
    expect(readFileSync(brainConfigPath(env.vault), "utf8")).toBe(before);
    expect(sets(env)).toHaveLength(0);
  });

  test("an operator-only setting is refused with operator_only_setting", async () => {
    env = makeStoreEnv("osb-settool-operator-");
    const before = readFileSync(brainConfigPath(env.vault), "utf8");
    const server = await serverFor(env.vault, env.configPath);
    const { error } = await call(server, {
      action: "set",
      name: "integrity.owner_scope_delivery",
      value: "off",
    });
    expect(error?.data?.["code"]).toBe("operator_only_setting");
    expect(error?.message).toContain("o2b brain settings set integrity.owner_scope_delivery");
    expect(readFileSync(brainConfigPath(env.vault), "utf8")).toBe(before);
  });
});

describe("brain_settings on a switched machine whose store cannot be opened", () => {
  test("a remote agent's refusal names neither the lost partition nor the leave remedy", async () => {
    env = makeStoreEnv("osb-settool-remote-redact-");
    switchDevice(env.storeRoot);
    setBrainSetting(
      { vault: env.vault, authority: "human", agent: "u" },
      "dream.heal_enrich_enabled",
      true,
    );
    // A switched machine that lost identity files of the partitions it
    // holds: the store-open error names `private/store.json` and the
    // leave verb, but none of that may reach the remote caller.
    rmSync(join(env.storeRoot, "shared", "store.json"));
    rmSync(join(env.storeRoot, "private", "store.json"));
    const before = sets(env).length;
    const server = await serverFor(env.vault, env.configPath, TRANSPORT_REACH.remote);
    const reply = await server.handleRequest({
      jsonrpc: JSONRPC_VERSION,
      id: 4,
      method: "tools/call",
      params: {
        name: "brain_settings",
        arguments: { action: "set", name: "dream.heal_enrich_enabled", value: false },
      },
    });
    // The write fails closed; the whole answer - prose, codes, data -
    // names neither the partition's identity file nor the remedy.
    expect(JSON.stringify(reply)).not.toContain("private/");
    expect(JSON.stringify(reply)).not.toContain("partition leave private");
    const err = (reply as { error?: { message: string; data?: Record<string, unknown> } }).error;
    expect(err?.data?.["code"]).toBe("settings_unreadable");
    expect(err?.message).toContain("dream.heal_enrich_enabled cannot be changed by an agent");
    expect(sets(env)).toHaveLength(before);
  });
});
