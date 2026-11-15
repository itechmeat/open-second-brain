/**
 * The evidence counters of a shared preference at each reach on a
 * switched machine (task 3.18, design D15 item 4): the counters fold every
 * partition the machine holds, so a local caller sees its private
 * evidence counted, and a caller below local reach is shown what a
 * machine that holds only `shared` folds.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { appendApplyEvidence } from "../../src/core/brain/apply-evidence.ts";
import { writePreference } from "../../src/core/brain/preference.ts";
import { indexVault, resolveSearchConfig } from "../../src/core/search/index.ts";
import { TRANSPORT_REACH, type TransportReach } from "../../src/core/graph/transport-reach.ts";
import { JSONRPC_VERSION, MCPServer, PROTOCOL_VERSION } from "../../src/mcp/index.ts";
import { switchDevice } from "../core/brain/store-only/fixtures.ts";
import { makeStoreEnv, type StoreEnv } from "../core/store/fixtures/store-env.ts";

let env: StoreEnv;
beforeEach(() => {
  env = makeStoreEnv("osb-evidence-reach-", { dualWrite: false });
  switchDevice(env.storeRoot);
  writePreference(
    env.vault,
    {
      slug: "tabs",
      topic: "tabs",
      principle: "principle tabs",
      created_at: "2026-11-01T00:00:00Z",
      unconfirmed_until: "2026-12-30T00:00:00Z",
      status: "confirmed",
      evidenced_by: [],
    },
    { authority: "agent" },
  );
  appendApplyEvidence(env.vault, {
    pref_id: "pref-tabs",
    artifact: "[[notes/open]]",
    agent: "claude",
    result: "applied",
  });
  // Its note names a preference the store cannot resolve: judged private.
  appendApplyEvidence(env.vault, {
    pref_id: "pref-tabs",
    artifact: "[[notes/work]]",
    agent: "claude",
    result: "applied",
    note: "[[pref-unknown-private]]",
  });
});
afterEach(() => env.cleanup());

/** The whole JSON-RPC response, error included. */
async function callRaw(reach: TransportReach, method: string, params: Record<string, unknown>) {
  const server = new MCPServer({ vault: env.vault, configPath: env.configPath }, { reach });
  return JSON.stringify(
    await server.handleRequest({ jsonrpc: JSONRPC_VERSION, id: 2, method, params }),
  );
}

async function call(reach: TransportReach, method: string, params: Record<string, unknown>) {
  const server = new MCPServer({ vault: env.vault, configPath: env.configPath }, { reach });
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
  const response = (await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 2,
    method,
    params,
  })) as {
    result?: unknown;
    error?: unknown;
  };
  expect(response.error).toBeUndefined();
  return JSON.stringify(response.result);
}

function read(reach: TransportReach): Promise<string> {
  return call(reach, "resources/read", { uri: "osb://preference/tabs" });
}

/** The text payload of a tool call. */
async function toolText(reach: TransportReach, name: string, args: Record<string, unknown>) {
  const result = JSON.parse(await call(reach, "tools/call", { name, arguments: args })) as {
    content: Array<{ text: string }>;
  };
  return result.content[0]!.text;
}

async function applied(reach: TransportReach): Promise<number> {
  const text = await toolText(reach, "brain_query", { preference: "pref-tabs" });
  return (JSON.parse(text) as { preference: { applied_count: number } }).preference.applied_count;
}

function content(reach: TransportReach): Promise<string> {
  return toolText(reach, "brain_context", {});
}

describe("evidence counters of a shared preference", () => {
  test("the preference resource counts private evidence locally only", async () => {
    expect(await read(TRANSPORT_REACH.local)).toContain("_applied_count: 2");
    const remote = await read(TRANSPORT_REACH.remote);
    expect(remote).toContain("_applied_count: 1");
    expect(remote).not.toContain("_applied_count: 2");
  });

  test("brain_query answers the shared count below local reach", async () => {
    expect(await applied(TRANSPORT_REACH.local)).toBe(2);
    expect(await applied(TRANSPORT_REACH.remote)).toBe(1);
  });
});

async function counted(reach: TransportReach): Promise<number> {
  const server = new MCPServer({ vault: env.vault, configPath: env.configPath }, { reach });
  const result = (await server.callTool("brain_query", { preference: "pref-tabs" })) as {
    content: Array<{ text: string }>;
  };
  return (JSON.parse(result.content[0]!.text) as { preference: { applied_count: number } })
    .preference.applied_count;
}

describe("the CLI tool bridge", () => {
  test("callTool answers in the caller's reach too", async () => {
    expect(await counted(TRANSPORT_REACH.local)).toBe(2);
    expect(await counted(TRANSPORT_REACH.remote)).toBe(1);
  });
});

describe("the brain_context digest", () => {
  test("states the shared count below local reach", async () => {
    expect(await content(TRANSPORT_REACH.local)).toContain("applied_in_window: 2");
    const remote = await content(TRANSPORT_REACH.remote);
    expect(remote).toContain("applied_in_window: 1");
    expect(remote).not.toContain("applied_in_window: 2");
  });
});

// A regression guard, not proof of task 3.18: indexed reads served this
// before the change too (the index holds records, never derived counters,
// and reserves the `private` partition). It pins that the new counters
// rule did not open a path through the index.
describe("indexed reads below local reach (regression guard)", () => {
  test("serve neither the private evidence record nor a counter that counts it", async () => {
    await indexVault(resolveSearchConfig({ vault: env.vault, configPath: env.configPath }), {});
    // The index holds records, not the counters derived from them: a
    // preference record's fields never carry one (FORMAT.md).
    const hits = async (reach: TransportReach, query: string): Promise<string> =>
      toolText(reach, "brain_search", { query, limit: 1 });
    // Only the private evidence names this page: found locally, withheld remotely.
    expect(await hits(TRANSPORT_REACH.local, "unknown private")).toContain("pref-unknown-private");
    const remote = await hits(TRANSPORT_REACH.remote, "unknown private");
    // Its chunk, drilled into by id from below local reach, is withheld too.
    const local = JSON.parse(await hits(TRANSPORT_REACH.local, "unknown private")) as {
      results: Array<{ chunkId: number }>;
    };
    const chunk = local.results[0]!.chunkId;
    const expanded = await callRaw(TRANSPORT_REACH.remote, "tools/call", {
      name: "brain_search_expand",
      arguments: { chunk_id: chunk },
    });
    expect(expanded).not.toContain("pref-unknown-private");
    const answers = [
      remote,
      await hits(TRANSPORT_REACH.remote, "applied"),
      await hits(TRANSPORT_REACH.remote, "principle tabs"),
      await toolText(TRANSPORT_REACH.remote, "brain_file_context", {
        file_path: "notes/work.md",
        min_bytes: 0,
      }),
    ];
    for (const answer of answers) {
      expect(answer).not.toContain("applied_count");
      expect(answer).not.toContain("pref-unknown-private");
    }
  });
});
