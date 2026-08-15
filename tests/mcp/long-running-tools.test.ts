/**
 * The MCP tools that can genuinely run for minutes are both bounded and
 * observable (nothing-runs-unwatched, U2).
 *
 * One theme, because a deadline and a progress tick sit at the same
 * boundary: a run worth guarding is a run worth reporting on, and the
 * safeguard checkpoints are where the spine emits.
 *
 * `brain_bridges` and `brain_clusters` call the same two core functions
 * the maintenance lane calls, and both accept a `Safeguard` there -
 * `admin-tools.ts` passes one per task, resolving the budget through
 * `resolveSafeguardTimeoutMs`. The two standalone MCP tools passed
 * nothing at all, so a graph sweep an agent started over MCP had no upper
 * bound on how long it could hold the server. They now resolve the budget
 * the same way the lane does.
 *
 * The deadline is exercised through a clock that jumps past any budget on
 * its second reading, which is what `createSafeguard` compares against:
 * the alternative - waiting out a real budget - is measured in the
 * minutes the built-in default allows.
 */

import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { indexVault } from "../../src/core/search/indexer.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { makeConfig } from "../helpers/search-fixtures.ts";
import { JSONRPC_VERSION, MCPServer, PROTOCOL_VERSION } from "../../src/mcp/index.ts";
import { PROGRESS_META_KEY, PROGRESS_NOTIFICATION_METHOD } from "../../src/mcp/progress.ts";
import type { JsonRpcNotification } from "../../src/mcp/protocol.ts";
import { PROGRESS_SCHEMA } from "../../src/core/brain/progress.ts";

let tmp: string;
let vault: string;
let configHome: string;
let configPath: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-mcp-guard-"));
  vault = join(tmp, "vault");
  configHome = mkdtempSync(join(tmpdir(), "o2b-mcp-guard-cfg-"));
  configPath = join(configHome, "config.yaml");
  for (const key of [
    "VAULT_AGENT_NAME",
    "VAULT_TIMEZONE",
    "VAULT_DIR",
    "OPEN_SECOND_BRAIN_CONFIG",
    "OPEN_SECOND_BRAIN_SAFEGUARD_TIMEOUT",
  ]) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env["OPEN_SECOND_BRAIN_CONFIG"] = configPath;
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function initialize(server: MCPServer): Promise<void> {
  await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 1,
    method: "initialize",
    params: { protocolVersion: PROTOCOL_VERSION },
  });
}

/** The tool-level envelope, whose `isError` carries a thrown core error. */
async function callRaw(
  server: MCPServer,
  tool: string,
  args: Record<string, unknown>,
): Promise<{ isError?: boolean; content?: Array<{ text?: string }> }> {
  const res = (await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 2,
    method: "tools/call",
    params: { name: tool, arguments: args },
  })) as { result?: { isError?: boolean; content?: Array<{ text?: string }> } };
  return res.result!;
}

function writeLinkedGroup(): void {
  const group = ["team-a", "team-b", "team-c", "team-d"];
  for (const name of group) {
    const others = group
      .filter((g) => g !== name)
      .map((g) => `[[${g}]]`)
      .join(" ");
    writeFileSync(join(vault, `${name}.md`), `# ${name}\n\nSee ${others}.\n`);
  }
}

/**
 * A clock whose every reading is a full day past the previous one, so any
 * budget `resolveSafeguardTimeoutMs` returns has elapsed by the first
 * checkpoint. `createSafeguard` reads `Date.now` when no clock is
 * injected, which is exactly the path an MCP tool takes.
 */
function jumpingClock(): () => void {
  let tick = 0;
  const spy = spyOn(Date, "now").mockImplementation(() => {
    tick += 1;
    return tick * 86_400_000;
  });
  return () => spy.mockRestore();
}

test("brain_bridges discover aborts once its deadline has passed", async () => {
  writeLinkedGroup();
  await indexVault(
    makeConfig({ vault, dbPath: join(vault, ".open-second-brain", "brain.sqlite") }),
  );
  const server = new MCPServer({ vault, configPath });
  await initialize(server);

  const restore = jumpingClock();
  try {
    const result = await callRaw(server, "brain_bridges", { operation: "discover" });
    expect(result.isError).toBe(true);
    expect(result.content![0]!.text).toContain("safeguard timeout");
    expect(result.content![0]!.text).toContain("bridges");
  } finally {
    restore();
  }
});

test("brain_clusters run aborts once its deadline has passed", async () => {
  writeLinkedGroup();
  await indexVault(
    makeConfig({ vault, dbPath: join(vault, ".open-second-brain", "brain.sqlite") }),
  );
  const server = new MCPServer({ vault, configPath });
  await initialize(server);

  const restore = jumpingClock();
  try {
    const result = await callRaw(server, "brain_clusters", { operation: "run" });
    expect(result.isError).toBe(true);
    expect(result.content![0]!.text).toContain("safeguard timeout");
    expect(result.content![0]!.text).toContain("clusters");
  } finally {
    restore();
  }
});

test("a live clock leaves both tools running to completion", async () => {
  writeLinkedGroup();
  await indexVault(
    makeConfig({ vault, dbPath: join(vault, ".open-second-brain", "brain.sqlite") }),
  );
  const server = new MCPServer({ vault, configPath });
  await initialize(server);

  const bridges = await callRaw(server, "brain_bridges", { operation: "discover" });
  expect(bridges.isError).toBe(false);
  const clusters = await callRaw(server, "brain_clusters", { operation: "run" });
  expect(clusters.isError).toBe(false);
});

// ---------------------------------------------------------------------------
// The same four tools, observed
// ---------------------------------------------------------------------------

/** The operations named by the progress events a call emitted. */
function operationsIn(frames: JsonRpcNotification[]): Set<string> {
  const seen = new Set<string>();
  for (const frame of frames) {
    if (frame.method !== PROGRESS_NOTIFICATION_METHOD) continue;
    const params = frame.params as Record<
      string,
      Record<string, { operation: string; schema: string }>
    >;
    const event = params["_meta"]![PROGRESS_META_KEY]!;
    expect(event.schema).toBe(PROGRESS_SCHEMA);
    seen.add(event.operation);
  }
  return seen;
}

/** A server whose notification frames this test can read back. */
function observedServer(frames: JsonRpcNotification[]): MCPServer {
  return new MCPServer(
    { vault, configPath },
    { sendNotification: (notification) => frames.push(notification) },
  );
}

async function callWithToken(
  server: MCPServer,
  tool: string,
  args: Record<string, unknown>,
): Promise<{ isError?: boolean }> {
  const res = (await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 3,
    method: "tools/call",
    params: { name: tool, arguments: args, _meta: { progressToken: `t-${tool}` } },
  })) as { result?: { isError?: boolean } };
  return res.result!;
}

test("brain_bridges reports its scan under a progress token", async () => {
  writeLinkedGroup();
  await indexVault(
    makeConfig({ vault, dbPath: join(vault, ".open-second-brain", "brain.sqlite") }),
  );
  const frames: JsonRpcNotification[] = [];
  const server = observedServer(frames);
  await initialize(server);

  expect((await callWithToken(server, "brain_bridges", { operation: "discover" })).isError).toBe(
    false,
  );
  expect(operationsIn(frames)).toEqual(new Set(["bridges"]));
});

test("brain_clusters reports its sweeps under a progress token", async () => {
  writeLinkedGroup();
  await indexVault(
    makeConfig({ vault, dbPath: join(vault, ".open-second-brain", "brain.sqlite") }),
  );
  const frames: JsonRpcNotification[] = [];
  const server = observedServer(frames);
  await initialize(server);

  expect((await callWithToken(server, "brain_clusters", { operation: "run" })).isError).toBe(false);
  expect(operationsIn(frames)).toEqual(new Set(["clusters"]));
});

test("brain_maintenance forwards the sink to every task it dispatches", async () => {
  writeLinkedGroup();
  const frames: JsonRpcNotification[] = [];
  const server = observedServer(frames);
  await initialize(server);

  expect(
    (await callWithToken(server, "brain_maintenance", { operation: "run", force: true })).isError,
  ).toBe(false);
  // The lane is a dispatcher, so it speaks with its tasks' voices: each
  // event names the operation that emitted it, never the lane.
  expect(operationsIn(frames)).toEqual(new Set(["dream", "reindex", "bridges", "clusters"]));
});

test("no token leaves every one of them silent", async () => {
  writeLinkedGroup();
  await indexVault(
    makeConfig({ vault, dbPath: join(vault, ".open-second-brain", "brain.sqlite") }),
  );
  const frames: JsonRpcNotification[] = [];
  const server = observedServer(frames);
  await initialize(server);

  await callRaw(server, "brain_bridges", { operation: "discover" });
  await callRaw(server, "brain_clusters", { operation: "run" });
  expect(frames).toEqual([]);
});
