/**
 * `brain_pinned_context` on a store-only machine names the pinned register
 * (`store:<partition>/pinned`), never `Brain/pinned.md` or an absolute
 * vault path; an unswitched machine keeps naming the file.
 */
import { afterEach, describe, expect, test } from "bun:test";

import { TRANSPORT_REACH, type TransportReach } from "../../src/core/graph/transport-reach.ts";
import { JSONRPC_VERSION, MCPServer, PROTOCOL_VERSION } from "../../src/mcp/index.ts";
import { brainTreeDigest, switchDevice } from "../core/brain/store-only/fixtures.ts";
import { makeStoreEnv, type StoreEnv } from "../core/store/fixtures/store-env.ts";

let env: StoreEnv | null = null;
afterEach(() => {
  env?.cleanup();
  env = null;
});

async function pinned(
  server: MCPServer,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const r = (await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 2,
    method: "tools/call",
    params: { name: "brain_pinned_context", arguments: args },
  })) as { result: { content: ReadonlyArray<{ text: string }>; isError?: boolean } };
  expect(r.result.isError).not.toBe(true);
  return JSON.parse(r.result.content[0]!.text) as Record<string, unknown>;
}

async function serverFor(e: StoreEnv, reach?: TransportReach): Promise<MCPServer> {
  const config = { vault: e.vault, configPath: e.configPath };
  const server = reach === undefined ? new MCPServer(config) : new MCPServer(config, { reach });
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

describe("brain_pinned_context result paths", () => {
  // Below local reach the register is `shared` even on a machine holding
  // `private` (requirement "A machine register and the receipt ledger
  // follow the lane rule below local reach"); at local reach it is
  // `private`.
  for (const [reach, name] of [
    [TRANSPORT_REACH.local, "store:private/pinned"],
    [undefined, "store:shared/pinned"],
  ] as const) {
    test(`store-only: write, read and clear name the register, not a vault path (${name})`, async () => {
      env = makeStoreEnv("osb-pinned-name-");
      switchDevice(env.storeRoot);
      const before = brainTreeDigest(env.vault);
      const server = await serverFor(env, reach);
      for (const args of [
        { operation: "write", content: "task facts" },
        { operation: "read" },
        { operation: "append", content: "more" },
        { operation: "clear" },
        { operations: [{ op: "write", content: "batched" }] },
      ]) {
        const result = await pinned(server, args);
        expect(result["path"]).toBe(name);
        expect(result["absolute_path"]).toBe(name);
        expect(JSON.stringify(result)).not.toContain(env.vault);
        expect(JSON.stringify(result)).not.toContain("pinned.md");
      }
      expect(brainTreeDigest(env.vault)).toBe(before);
    });
  }

  test("store-only without a private partition: the shared register", async () => {
    env = makeStoreEnv("osb-pinned-name-shared-", { partitions: ["shared"] });
    switchDevice(env.storeRoot);
    const result = await pinned(await serverFor(env), { operation: "write", content: "x" });
    expect(result["path"]).toBe("store:shared/pinned");
  });

  test("unswitched: the file, as before", async () => {
    env = makeStoreEnv("osb-pinned-name-legacy-");
    const result = await pinned(await serverFor(env), { operation: "write", content: "x" });
    expect(result["path"]).toBe("Brain/pinned.md");
  });
});
