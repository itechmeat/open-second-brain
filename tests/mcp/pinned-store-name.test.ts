/**
 * `brain_pinned_context` on a store-only machine names the pinned register
 * (`store:<partition>/pinned`), never `Brain/pinned.md` or an absolute
 * vault path; an unswitched machine keeps naming the file.
 */
import { afterEach, describe, expect, test } from "bun:test";

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

async function serverFor(e: StoreEnv): Promise<MCPServer> {
  const server = new MCPServer({ vault: e.vault, configPath: e.configPath });
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
  test("store-only: write, read and clear name the register, not a vault path", async () => {
    env = makeStoreEnv("osb-pinned-name-");
    switchDevice(env.storeRoot);
    const before = brainTreeDigest(env.vault);
    const server = await serverFor(env);
    for (const args of [
      { operation: "write", content: "task facts" },
      { operation: "read" },
      { operation: "append", content: "more" },
      { operation: "clear" },
      { operations: [{ op: "write", content: "batched" }] },
    ]) {
      const result = await pinned(server, args);
      expect(result["path"]).toBe("store:private/pinned");
      expect(result["absolute_path"]).toBe("store:private/pinned");
      expect(JSON.stringify(result)).not.toContain(env.vault);
      expect(JSON.stringify(result)).not.toContain("pinned.md");
    }
    expect(brainTreeDigest(env.vault)).toBe(before);
  });

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
