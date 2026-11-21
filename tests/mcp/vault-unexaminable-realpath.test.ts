/**
 * Every MCP tool answers `vault_unreadable` on a vault this process
 * cannot examine, whichever look fails first.
 *
 * On macOS a mode-000 vault still stats, so the store-only predicate
 * answers, and the first look that fails is the path-safety check's
 * realpath of the vault root (EACCES; Linux resolves it). That error used
 * to surface bare, so `second_brain_status` answered `internal_error`
 * while `brain_feedback` answered `vault_unreadable`. The class is now one
 * (`VaultUnexaminableError`), classified wherever it surfaces. The spy
 * reproduces the macOS realpath on every platform.
 */
import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { chmodSync } from "node:fs";
import { join, resolve } from "node:path";

import { MCPServer } from "../../src/mcp/index.ts";
import { makeStoreEnv, type StoreEnv } from "../core/store/fixtures/store-env.ts";
import { CHMOD_CANNOT_DENY } from "../helpers/platform.ts";

let env: StoreEnv | undefined;
const restore: Array<() => void> = [];
afterEach(() => {
  for (const undo of restore.splice(0)) undo();
  env?.cleanup();
  env = undefined;
});

/** realpath of `target` fails as it does on macOS for a mode-000 directory. */
function denyRealpathOf(vault: string): void {
  const real = fs.realpathSync;
  const spy = spyOn(fs, "realpathSync").mockImplementation(((
    p: fs.PathLike,
    ...rest: unknown[]
  ) => {
    if (resolve(String(p)) === resolve(vault)) {
      throw Object.assign(new Error(`EACCES: permission denied, lstat '${vault}'`), {
        code: "EACCES",
      });
    }
    return (real as (...a: unknown[]) => string)(p, ...rest);
  }) as typeof fs.realpathSync);
  restore.push(() => spy.mockRestore());
}

async function callTool(server: MCPServer, id: number, name: string, args: object) {
  const response = (await server.handleRequest({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  })) as { result?: Record<string, any>; error?: unknown };
  expect(response.error).toBeUndefined();
  return response.result!;
}

function errorCode(result: Record<string, any>): string | null {
  if (result["isError"] !== true) return null;
  return result["_meta"]?.["open-second-brain/error"]?.["code"] ?? "untyped";
}

test("status and a writer both answer vault_unreadable when the vault's realpath is refused", async () => {
  env = makeStoreEnv("osb-mcp-realpath-denied-");
  const server = new MCPServer(
    { vault: env.vault, configPath: env.configPath },
    { reach: "local" },
  );
  denyRealpathOf(env.vault);

  const status = await callTool(server, 1, "second_brain_status", {});
  expect(errorCode(status)).toBe("vault_unreadable");
  const feedback = await callTool(server, 2, "brain_feedback", {
    topic: "style",
    principle: "prefer tabs",
    signal: "positive",
  });
  expect(errorCode(feedback)).toBe("vault_unreadable");
});

/** stat of `path` fails as it does for a vault below a parent that cannot be traversed. */
function denyStatOf(path: string): void {
  const real = fs.statSync;
  const spy = spyOn(fs, "statSync").mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
    if (resolve(String(p)) === resolve(path)) {
      throw Object.assign(new Error(`EACCES: permission denied, stat '${path}'`), {
        code: "EACCES",
      });
    }
    return (real as (...a: unknown[]) => unknown)(p, ...rest);
  }) as typeof fs.statSync);
  restore.push(() => spy.mockRestore());
}

async function expectEveryToolUnreadable(server: MCPServer, statusPayload = false): Promise<void> {
  const status = await callTool(server, 11, "second_brain_status", {});
  if (statusPayload) {
    // The status payload exists to name this condition: it answers with the
    // vault block saying it cannot determine the vault, never a guess.
    expect(JSON.stringify(status)).toContain("cannot determine whether the vault directory");
  } else {
    expect(errorCode(status)).toBe("vault_unreadable");
  }
  expect(
    errorCode(
      await callTool(server, 12, "brain_feedback", {
        topic: "style",
        principle: "prefer tabs",
        signal: "positive",
      }),
    ),
  ).toBe("vault_unreadable");
  expect(errorCode(await callTool(server, 13, "brain_search", { query: "tabs" }))).toBe(
    "vault_unreadable",
  );
}

test("a Brain/ whose realpath is refused (a mode-000 Brain/ on macOS) answers vault_unreadable", async () => {
  env = makeStoreEnv("osb-mcp-brain-realpath-denied-");
  const server = new MCPServer(
    { vault: env.vault, configPath: env.configPath },
    { reach: "local" },
  );
  denyRealpathOf(join(env.vault, "Brain"));
  await expectEveryToolUnreadable(server);
});

test("a vault whose stat is refused (a parent that cannot be traversed) answers vault_unreadable", async () => {
  env = makeStoreEnv("osb-mcp-vault-stat-denied-");
  const server = new MCPServer(
    { vault: env.vault, configPath: env.configPath },
    { reach: "local" },
  );
  denyStatOf(env.vault);
  await expectEveryToolUnreadable(server, true);
});

test.skipIf(CHMOD_CANNOT_DENY)("a real mode-000 Brain/ answers vault_unreadable", async () => {
  env = makeStoreEnv("osb-mcp-brain-mode-000-");
  const server = new MCPServer(
    { vault: env.vault, configPath: env.configPath },
    { reach: "local" },
  );
  const brain = join(env.vault, "Brain");
  chmodSync(brain, 0o000);
  restore.push(() => chmodSync(brain, 0o755));
  await expectEveryToolUnreadable(server);
});
