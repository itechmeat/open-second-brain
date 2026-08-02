/**
 * The acting agent on a `brain_context_pack_outcome` post.
 *
 * `context-pack-outcome.ts` spreads an `agentId` onto three rows - the
 * outcome row, the `token_impact_outcome` calibration row and the
 * `context_pack_evidence` row, which calls it "the ACTING agent recorded
 * as the claimant". Until this file existed the only caller,
 * `toolBrainContextPackOutcome`, never supplied one and the tool schema
 * had no property for it, so the claimant key could not be written by any
 * shipped path. The exercise here runs the REAL surface - a JSON-RPC
 * `tools/call` against a live `MCPServer` - rather than the core function,
 * because a test that calls the core function directly is exactly what let
 * that gap survive.
 *
 * Three properties:
 *
 *   - supplied, the identity reaches all three rows. One argument, three
 *     joined records, so the outcome row and its two side records can
 *     never disagree about who posted.
 *   - omitted, the post is byte-identical to one made before the property
 *     existed. Nothing is invented and nothing is guessed.
 *   - a config that cannot be READ does not fail the post. The identity is
 *     an argument, never `ServerContext.agentName`, which resolves the
 *     config on access and RAISES on one it cannot read. Reading it here
 *     would turn a working telemetry post into a failure over a broken
 *     line in an unrelated file; the third test forbids that by standing a
 *     directory where the config belongs.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveAgentName } from "../../src/core/config.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { listContextPackEvidence } from "../../src/core/brain/context-pack-evidence.ts";
import { emitContextReceipt } from "../../src/core/brain/context-receipts.ts";
import { listTokenImpactOutcomes } from "../../src/core/brain/token-impact.ts";
import { CONTINUITY_AGENT_ID_KEY } from "../../src/core/brain/continuity/types.ts";
import { JSONRPC_VERSION, MCPServer, PROTOCOL_VERSION } from "../../src/mcp/index.ts";

/** The identity a client asserts. Self-asserted, like every identity here. */
const ACTING_AGENT = "claude-dev-agent";

let tmp: string;
let vault: string;
let configHome: string;
let configPath: string;
const savedEnv: Record<string, string | undefined> = {};

const ENV_KEYS: ReadonlyArray<string> = Object.freeze([
  "VAULT_AGENT_NAME",
  "VAULT_TIMEZONE",
  "VAULT_DIR",
  "OPEN_SECOND_BRAIN_CONFIG",
  "OPEN_SECOND_BRAIN_CONTEXT_PACK_OUTCOME_ENABLED",
  "OPEN_SECOND_BRAIN_TOKEN_IMPACT_LEDGER_ENABLED",
]);

function writeConfig(): void {
  atomicWriteFileSync(configPath, `vault: ${vault}\ncontext_pack_outcome_enabled: "true"\n`);
}

function seedReceipt(): string {
  return emitContextReceipt(vault, {
    options: { host: "test", trigger: "context_pack", createdAt: "2026-07-01T00:00:00.000Z" },
    items: [{ id: "pref-a", path: "Brain/preferences/pref-a.md", text: "preference one" }],
    finalText: "preference one\n",
  }).id;
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-ctx-outcome-agent-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  configHome = mkdtempSync(join(tmpdir(), "o2b-ctx-outcome-agent-cfg-"));
  configPath = join(configHome, "config.yaml");
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env["OPEN_SECOND_BRAIN_CONFIG"] = configPath;
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function startServer(): Promise<MCPServer> {
  const server = new MCPServer({ vault, configPath });
  await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "ctx-outcome-agent-test", version: "0" },
    },
  });
  return server;
}

async function callTool(
  server: MCPServer,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = (await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 9,
    method: "tools/call",
    params: { name: "brain_context_pack_outcome", arguments: args },
  })) as { result: { content: ReadonlyArray<{ type: string; text: string }> } };
  return JSON.parse(response.result.content[0]!.text);
}

describe("brain_context_pack_outcome acting agent", () => {
  test("an agent_id supplied at the tool boundary reaches all three joined rows", async () => {
    writeConfig();
    const sampleId = seedReceipt();
    const server = await startServer();

    const out = await callTool(server, {
      operation: "post",
      sample_id: sampleId,
      first_pass_success: true,
      agent_id: ACTING_AGENT,
    });
    expect(out["recorded"]).toBe(true);

    // 1. the outcome row itself
    const list = await callTool(server, { operation: "list" });
    const rows = list["records"] as ReadonlyArray<{ payload: Record<string, unknown> }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload[CONTINUITY_AGENT_ID_KEY]).toBe(ACTING_AGENT);

    // 2. the evidence row - where the identity is the CLAIMANT
    const evidence = listContextPackEvidence(vault);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]!.payload[CONTINUITY_AGENT_ID_KEY]).toBe(ACTING_AGENT);

    // 3. the token-impact calibration row composed off the same post
    const calibration = listTokenImpactOutcomes(vault);
    expect(calibration).toHaveLength(1);
    expect(calibration[0]!.payload[CONTINUITY_AGENT_ID_KEY]).toBe(ACTING_AGENT);
  });

  test("a post with no agent_id is byte-identical to one made before the property existed", async () => {
    writeConfig();
    const sampleId = seedReceipt();
    const server = await startServer();

    await callTool(server, { operation: "post", sample_id: sampleId, first_pass_success: true });

    const list = await callTool(server, { operation: "list" });
    const rows = list["records"] as ReadonlyArray<{ payload: Record<string, unknown> }>;
    expect(Object.keys(rows[0]!.payload).toSorted()).toEqual(["first_pass_success", "sample_id"]);
    // Nothing is guessed on the joined rows either - no server identity
    // leaks in through the back door when the client asserted none.
    expect(CONTINUITY_AGENT_ID_KEY in listContextPackEvidence(vault)[0]!.payload).toBe(false);
    expect(CONTINUITY_AGENT_ID_KEY in listTokenImpactOutcomes(vault)[0]!.payload).toBe(false);
  });

  test("a config that cannot be read does not fail the post", async () => {
    // A directory where the config file belongs: present, and unreadable
    // as a config. The gate comes from the environment, which short-
    // circuits ahead of the config read, so the ONLY thing that could
    // touch that file on this path is an identity lookup.
    mkdirSync(configPath, { recursive: true });
    process.env["OPEN_SECOND_BRAIN_CONTEXT_PACK_OUTCOME_ENABLED"] = "true";

    // Non-vacuity: the config really is unreadable, and the server-side
    // identity really would raise on it. Without this the test would pass
    // just as well against a config that was merely absent.
    expect(() => resolveAgentName(configPath)).toThrow();

    const server = await startServer();
    const out = await callTool(server, {
      operation: "post",
      sample_id: "opaque_hash",
      first_pass_success: true,
      agent_id: ACTING_AGENT,
    });

    expect(out["recorded"]).toBe(true);
    const list = await callTool(server, { operation: "list" });
    const rows = list["records"] as ReadonlyArray<{ payload: Record<string, unknown> }>;
    expect(rows[0]!.payload[CONTINUITY_AGENT_ID_KEY]).toBe(ACTING_AGENT);
  });
});
