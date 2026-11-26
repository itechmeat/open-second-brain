/**
 * The machine's search tuning below local reach (change
 * `lane-private-partition-reach`, the lead's answer to the tuning
 * question of the write census).
 *
 * A `brain_tune run` scores its grid at the caller's reach and answers as
 * at any reach, but a caller below local reach does not persist the
 * winner: the machine's one tuning file is written from the scores a
 * local caller sees, so it stays byte-identical. A `reset` below local
 * reach leaves the file and answers the no-op the tool already reports
 * (`removed: false`). The same calls at local reach are the control.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { TRANSPORT_REACH } from "../../src/core/graph/transport-reach.ts";
import { indexVault } from "../../src/core/search/indexer.ts";
import { makeConfig } from "../helpers/search-fixtures.ts";
import { JSONRPC_VERSION, MCPServer, PROTOCOL_VERSION } from "../../src/mcp/index.ts";

let tmp: string;
let vault: string;
let configPath: string;
const saved: Record<string, string | undefined> = {};
const ENV = ["VAULT_AGENT_NAME", "VAULT_TIMEZONE", "VAULT_DIR", "OPEN_SECOND_BRAIN_CONFIG"];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-lane-reach-tune-"));
  vault = join(tmp, "vault");
  mkdirSync(join(tmp, "cfg"), { recursive: true });
  configPath = join(tmp, "cfg", "config.yaml");
  for (const key of ENV) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  process.env["OPEN_SECOND_BRAIN_CONFIG"] = configPath;
  writeFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapBrain(vault, { configPath });
  writeFileSync(join(vault, "canary.md"), "# Canary rollout\n\nShip one instance first.\n");
  writeFileSync(join(vault, "other.md"), "# Other note\n\nSomething else entirely.\n");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  for (const key of ENV) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

const DATASET = {
  queries: [{ id: "canary", query: "canary rollout", expected: ["canary.md"] }],
};

async function call(
  server: MCPServer,
  tool: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = (await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 99,
    method: "tools/call",
    params: { name: tool, arguments: args },
  })) as { result?: { content?: Array<{ text?: string }> }; error?: { message: string } };
  if (res.error !== undefined) throw new Error(res.error.message);
  return JSON.parse(res.result!.content![0]!.text!) as Record<string, unknown>;
}

async function serve(local: boolean): Promise<MCPServer> {
  const server = local
    ? new MCPServer({ vault, configPath }, { reach: TRANSPORT_REACH.local })
    : new MCPServer({ vault, configPath });
  await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "lane-reach-tune", version: "0" },
    },
  });
  await server.handleRequest({ jsonrpc: JSONRPC_VERSION, method: "notifications/initialized" });
  return server;
}

const tuningFile = (): string => join(vault, "Brain", "search", "tuning.json");

async function index(): Promise<void> {
  await indexVault(
    makeConfig({ vault, dbPath: join(vault, ".open-second-brain", "brain.sqlite") }),
  );
}

test("a remote tune run answers as a local one and leaves the tuning file byte-identical", async () => {
  await index();
  const local = await call(await serve(true), "brain_tune", { operation: "run", dataset: DATASET });
  expect(existsSync(tuningFile())).toBe(true);
  const before = readFileSync(tuningFile());
  const remote = await call(await serve(false), "brain_tune", {
    operation: "run",
    dataset: DATASET,
  });
  expect({
    file: readFileSync(tuningFile()).equals(before),
    same_shape: Object.keys(remote).toSorted().join(","),
  }).toEqual({ file: true, same_shape: Object.keys(local).toSorted().join(",") });
});

test("a remote tune run on a machine with no tuning file writes none", async () => {
  await index();
  await call(await serve(false), "brain_tune", { operation: "run", dataset: DATASET });
  expect(existsSync(tuningFile())).toBe(false);
});

test("a remote tune reset leaves the tuning file and answers the no-op; a local reset removes it", async () => {
  await index();
  await call(await serve(true), "brain_tune", { operation: "run", dataset: DATASET });
  const before = readFileSync(tuningFile());
  const remote = await call(await serve(false), "brain_tune", { operation: "reset" });
  expect({ removed: remote["removed"], file: readFileSync(tuningFile()).equals(before) }).toEqual({
    removed: false,
    file: true,
  });
  const local = await call(await serve(true), "brain_tune", { operation: "reset" });
  expect({ removed: local["removed"], file: existsSync(tuningFile()) }).toEqual({
    removed: true,
    file: false,
  });
});
