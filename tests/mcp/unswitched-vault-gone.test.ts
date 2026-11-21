/**
 * A machine that has NOT switched to the brain store, whose vault folder
 * is gone (an unmounted disk).
 *
 * The vault folder holds no legacy tree once it is gone, so the machine
 * answers `no-legacy-tree` and is store-only: the brain lives in the
 * store, and the store-backed tools keep working. What must not happen is
 * a WRITE that materialises the folder that is missing - a fresh tree in
 * its place hides the real vault, and the operator sees an empty vault
 * where the one that matters is not mounted at all.
 *
 * Before the fix `brain_create_note` created the vault folder and wrote
 * the note into it.
 */
import { afterEach, expect, test } from "bun:test";
import { existsSync, renameSync } from "node:fs";

import { MCPServer } from "../../src/mcp/index.ts";
import { makeStoreEnv, type StoreEnv } from "../core/store/fixtures/store-env.ts";

let env: StoreEnv | undefined;
const undo: Array<() => void> = [];
afterEach(() => {
  try {
    for (const step of undo.splice(0)) step();
  } finally {
    env?.cleanup();
    env = undefined;
  }
});

/** An unswitched machine with a legacy tree, whose vault folder is then renamed away. */
function unswitchedMachine(prefix: string): { env: StoreEnv; server: MCPServer } {
  const made = makeStoreEnv(prefix);
  env = made;
  const server = new MCPServer(
    { vault: made.vault, configPath: made.configPath },
    { reach: "local" },
  );
  const away = `${made.vault}-away`;
  renameSync(made.vault, away);
  undo.push(() => {
    if (existsSync(away) && !existsSync(made.vault)) renameSync(away, made.vault);
  });
  return { env: made, server };
}

async function request(server: MCPServer, name: string, args: object) {
  return (await server.handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  })) as { result?: Record<string, any>; error?: { data?: { code?: string } } };
}

/** The error code a tool result carries, or null when it is not an error. */
function errorCode(result: Record<string, any> | undefined): string | null {
  if (result?.["isError"] !== true) return null;
  return result["_meta"]?.["open-second-brain/error"]?.["code"] ?? "untyped";
}

test("brain_create_note refuses on an unswitched machine whose vault folder is gone", async () => {
  const { env: e, server } = unswitchedMachine("osb-mcp-unswitched-gone-");
  const response = await request(server, "brain_create_note", {
    path: "Notes/x.md",
    content: "hi\n",
  });
  // The named refusal, not a silent success and not an internal error.
  expect(response.error?.data?.code ?? errorCode(response.result)).toBe("vault_unreadable");
  // The folder that is gone was not recreated, and nothing was written.
  expect(existsSync(e.vault)).toBe(false);
}, 60_000);

test("the write batch refuses on an unswitched machine whose vault folder is gone", async () => {
  const { env: e, server } = unswitchedMachine("osb-mcp-unswitched-batch-");
  const response = await request(server, "brain_write_batch", {
    operations: [{ op: "create_note", path: "Notes/x.md", content: "hi\n" }],
  });
  expect(response.error?.data?.code ?? errorCode(response.result)).toBe("vault_unreadable");
  expect(existsSync(e.vault)).toBe(false);
}, 60_000);

test("the read-only vault tools answer by their own checks on such a machine", async () => {
  const { env: e, server } = unswitchedMachine("osb-mcp-unswitched-read-");
  // The diagnostic reports the condition instead of refusing it: the
  // folder is not there, and the brain is in the store.
  const status = await request(server, "second_brain_status", {});
  expect(status.error).toBeUndefined();
  expect(status.result?.["isError"]).not.toBe(true);
  const content = status.result?.["content"] as Array<{ text: string }> | undefined;
  expect(content).toBeDefined();
  const payload = JSON.parse((content ?? []).map((c) => c.text).join("\n"));
  expect(payload["vault_exists"]).toBe(false);
  expect(existsSync(e.vault)).toBe(false);
}, 60_000);

test("the store-backed tools still answer on an unswitched machine whose vault folder is gone", async () => {
  const { env: e, server } = unswitchedMachine("osb-mcp-unswitched-store-");
  const response = await request(server, "brain_context", {});
  expect(response.error).toBeUndefined();
  expect(response.result?.["isError"]).not.toBe(true);
  expect(existsSync(e.vault)).toBe(false);
}, 60_000);
