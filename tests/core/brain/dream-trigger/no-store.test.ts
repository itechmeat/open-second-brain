/**
 * A machine with no store keeps no dream trigger state (change
 * `dream-session-trigger`, design D1). The trigger's state lives where
 * the store's device-local state lives for the same caller: the state
 * root its environment names, and only for a store that exists. A
 * session (the MCP server's `initialize` and tool calls), a manual `o2b
 * dream run`, its worker form and the owner verbs' forget step, run
 * against a home with no config and no store (a fresh machine, a CI
 * runner's real home), write nothing under that home's state root.
 *
 * The home here is a directory of the test standing in for the real one:
 * the per-user variables point into it, as the real home's defaults
 * would, and the trigger is on (the suite turns it off).
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DREAM_AUTO_ENV,
  DREAM_TRIGGER_DIR,
} from "../../../../src/core/brain/dream-trigger/constants.ts";
import { forgetDreamOwnerCheck } from "../../../../src/core/brain/dream-trigger/forget.ts";
import { STORE_ROOT_ENV } from "../../../../src/core/store/constants.ts";
import { TRANSPORT_REACH } from "../../../../src/core/graph/transport-reach.ts";
import * as o2bCommand from "../../../../src/core/maintenance/o2b-command.ts";
import { APP_DIR_NAME } from "../../../../src/core/platform-dirs.ts";
import { JSONRPC_VERSION, MCPServer, PROTOCOL_VERSION } from "../../../../src/mcp/index.ts";
import { runCli } from "../../../helpers/run-cli.ts";

const KEYS = [
  "XDG_STATE_HOME",
  "LOCALAPPDATA",
  "OPEN_SECOND_BRAIN_CONFIG",
  STORE_ROOT_ENV,
  "VAULT_DIR",
  DREAM_AUTO_ENV,
] as const;

let home: string;
let state: string;
let configPath: string;
let saved: Record<string, string | undefined>;
let spawnSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "osb-trigger-nostore-"));
  state = join(home, "state");
  configPath = join(home, "config", "config.yaml");
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  process.env["XDG_STATE_HOME"] = state;
  process.env["LOCALAPPDATA"] = state;
  process.env["OPEN_SECOND_BRAIN_CONFIG"] = configPath;
  process.env[STORE_ROOT_ENV] = join(home, "store");
  delete process.env["VAULT_DIR"];
  delete process.env[DREAM_AUTO_ENV];
  // Nothing may start; were anything to, it is recorded and never run.
  spawnSpy = spyOn(o2bCommand, "spawnSelfDetached").mockImplementation((() => ({
    pid: 0,
    unref: () => {},
  })) as unknown as typeof o2bCommand.spawnSelfDetached);
});

afterEach(() => {
  spawnSpy.mockRestore();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/**
 * What the trigger left under the home's state root (the pass a manual
 * run makes keeps the store's own device-local state there, which is
 * not the trigger's).
 */
function stateLeft(): string[] {
  const own = join(state, APP_DIR_NAME);
  return existsSync(own) ? readdirSync(own).filter((n) => n === DREAM_TRIGGER_DIR) : [];
}

function cliEnv(): Record<string, string> {
  return {
    OPEN_SECOND_BRAIN_CONFIG: configPath,
    XDG_STATE_HOME: state,
    LOCALAPPDATA: state,
    [STORE_ROOT_ENV]: join(home, "store"),
    [DREAM_AUTO_ENV]: "true",
  };
}

describe("a machine with no store keeps no trigger state", () => {
  test("a session's day check (the MCP server's initialize and its tool calls)", async () => {
    const server = new MCPServer({ vault: null, configPath }, { reach: TRANSPORT_REACH.local });
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
    await server.handleRequest({
      jsonrpc: JSONRPC_VERSION,
      id: 2,
      method: "tools/call",
      params: { name: "brain_status", arguments: {} },
    });
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(stateLeft()).toEqual([]);
  });

  test("a manual o2b dream run, and the worker form with a claim", async () => {
    await runCli(["dream", "run"], { env: cliEnv() });
    const worker = await runCli(["dream", "run", "--claim", "tok1"], { env: cliEnv() });
    expect(worker.returncode).toBe(1);
    expect(stateLeft()).toEqual([]);
  });

  test("the owner verbs' forget step", () => {
    forgetDreamOwnerCheck(configPath);
    expect(stateLeft()).toEqual([]);
  });
});
