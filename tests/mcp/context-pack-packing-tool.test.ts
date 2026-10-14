/**
 * MCP surface of the opt-in packing policy on `brain_context_pack`
 * (recall-lane-latency wave).
 *
 * The knob rides the existing tool - a new argument, never a new tool -
 * and mirrors the `query_mode` discipline argument for argument:
 *
 *   1. The schema enum DERIVES from the frozen core tuple, ends its
 *      description, and declares the query pairing `dependentRequired`
 *      style so a schema-driven client discovers it without a refusal.
 *   2. A non-member is refused with INVALID_PARAMS naming the frozen
 *      members.
 *   3. A policy without a query - absent, blank or whitespace-only - is
 *      refused: a policy with nothing to order is inert, exactly like a
 *      mode with nothing to read.
 *   4. The omitted argument is byte-identical: no `packing` member
 *      exists on the response and the unified order is untouched.
 *   5. With a policy, the response carries the `packing` accounting -
 *      policy name, the reserved attention charge and both lane spends -
 *      and only then.
 *   6. A policy against a one-lane vault is refused by name through the
 *      wire as INVALID_PARAMS, never a silent no-op.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JSONRPC_VERSION, MCPServer, PROTOCOL_VERSION } from "../../src/mcp/index.ts";
import { buildToolTable } from "../../src/mcp/tools.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { PACKING_POLICIES } from "../../src/core/brain/recall-budget.ts";

let tmp: string;
let vault: string;
let configHome: string;
let configPath: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-mcp-pack-packing-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
  mkdirSync(join(vault, "Brain", "retired"), { recursive: true });
  configHome = mkdtempSync(join(tmpdir(), "o2b-mcp-pack-packing-cfg-"));
  configPath = join(configHome, "config.yaml");
  for (const k of ["VAULT_AGENT_NAME", "VAULT_TIMEZONE", "VAULT_DIR", "OPEN_SECOND_BRAIN_CONFIG"]) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  process.env["OPEN_SECOND_BRAIN_CONFIG"] = configPath;
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

async function initialize(server: MCPServer): Promise<void> {
  await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "pack-packing-test", version: "0" },
    },
  });
  await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    method: "notifications/initialized",
  });
}

async function callPack(
  server: MCPServer,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const r = (await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 9,
    method: "tools/call",
    params: { name: "brain_context_pack", arguments: args },
  })) as { result: { content: ReadonlyArray<{ type: string; text: string }> } };
  return JSON.parse(r.result.content[0]!.text) as Record<string, unknown>;
}

async function callPackRaw(
  server: MCPServer,
  args: Record<string, unknown>,
): Promise<{ error?: { code: number; message: string } }> {
  return (await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 11,
    method: "tools/call",
    params: { name: "brain_context_pack", arguments: args },
  })) as { error?: { code: number; message: string } };
}

/** One preference page and one retired page whose topics share the fixture query. */
function writeBothLanes(): void {
  writeFileSync(
    join(vault, "Brain", "preferences", "pref-fix.md"),
    "---\nid: pref-fix\ntopic: packing fixture\nprinciple: the distilled preference layer\ntier: core\ncreated_at: 2026-03-01T00:00:00Z\n---\n",
  );
  writeFileSync(
    join(vault, "Brain", "retired", "ret-fix.md"),
    "---\nid: ret-fix\ntopic: packing fixture\nprinciple: a retired page\ntier: core\ncreated_at: 2026-01-01T00:00:00Z\n---\n",
  );
}

const FIXTURE_QUERY = "packing fixture";

describe("brain_context_pack packing_policy declaration", () => {
  test("the schema enum derives from the frozen tuple and states the pairing", () => {
    const tool = buildToolTable("full").find((t) => t.name === "brain_context_pack")!;
    const schema = tool.inputSchema as {
      properties: Record<string, { type?: string; enum?: string[]; description?: string }>;
      dependentRequired?: Record<string, ReadonlyArray<string>>;
      additionalProperties?: boolean;
    };
    const declared = schema.properties["packing_policy"]!;
    expect(declared.type).toBe("string");
    expect(declared.enum).toEqual([...PACKING_POLICIES]);
    expect(declared.description).toContain("facts_first");
    expect(declared.description).toContain("retired_first");
    // The description does not sell `facts_first` as the omitted default:
    // it states the up-front reserved charge and the one-lane refusal the
    // omitted call does not make (external review M4).
    expect(declared.description).toContain("Neither is the omitted default");
    expect(declared.description).toContain("one lane has no candidate");
    expect(declared.description!.endsWith(".")).toBe(true);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.dependentRequired!["packing_policy"]).toEqual(["query"]);
  });
});

describe("brain_context_pack packing_policy refusals", () => {
  test("a non-member is refused naming the frozen members", async () => {
    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    const r = await callPackRaw(server, {
      max_tokens: 10_000,
      query: FIXTURE_QUERY,
      packing_policy: "budget_policy",
    });
    expect(r.error?.code).toBe(-32602);
    expect(r.error!.message).toContain("packing_policy");
    for (const member of PACKING_POLICIES) {
      expect(r.error!.message).toContain(member);
    }
  });

  test("a policy without a query is refused as inert", async () => {
    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    const r = await callPackRaw(server, { max_tokens: 10_000, packing_policy: "facts_first" });
    expect(r.error?.code).toBe(-32602);
    expect(r.error!.message).toContain("packing_policy");
    expect(r.error!.message).toContain("query");
    expect(r.error!.message).toContain("inert");
  });

  test("a policy with a blank or whitespace-only query is refused as inert exactly like an absent one", async () => {
    // An empty string survives the raw read, is dropped before the core
    // as falsy, and the null query filter-passes every candidate - so the
    // policy would silently reorder an unordered pack. Whitespace survives
    // the drop and substring-passes every haystack. Both are the same
    // nothing-to-order call the absent-query refusal names.
    writeBothLanes();
    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    for (const query of ["", " ", "   "]) {
      const r = await callPackRaw(server, {
        max_tokens: 10_000,
        query,
        packing_policy: "retired_first",
      });
      expect(r.error?.code).toBe(-32602);
      expect(r.error!.message).toContain("packing_policy");
      expect(r.error!.message).toContain("query");
      expect(r.error!.message).toContain("inert");
    }
  });

  test("a policy against a one-lane vault is refused by name as INVALID_PARAMS", async () => {
    // Facts lane only: the retired directory holds nothing, so the
    // pages lane is empty and the policy would silently do nothing.
    writeFileSync(
      join(vault, "Brain", "preferences", "pref-fix.md"),
      "---\nid: pref-fix\ntopic: packing fixture\nprinciple: the distilled layer\ntier: core\n---\n",
    );
    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    const r = await callPackRaw(server, {
      max_tokens: 10_000,
      query: FIXTURE_QUERY,
      packing_policy: "facts_first",
    });
    expect(r.error?.code).toBe(-32602);
    expect(r.error!.message).toContain("pages lane is empty");
    expect(r.error!.message).toContain("facts_first");
  });
});

describe("brain_context_pack packing_policy response", () => {
  test("the omitted argument keeps the response byte-identical: no packing member", async () => {
    writeBothLanes();
    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    const out = await callPack(server, { max_tokens: 10_000, query: FIXTURE_QUERY });
    expect(Object.hasOwn(out, "packing")).toBe(false);
    expect(JSON.stringify(out)).not.toContain('"packing"');
    // The unified comparator order, untouched by the absent option.
    const items = out["items"] as Array<{ id: string }>;
    expect(items.map((i) => i.id)).toEqual(["pref-fix", "ret-fix"]);
  });

  test("a named policy adds the packing accounting with both lane spends", async () => {
    writeBothLanes();
    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    const out = await callPack(server, {
      max_tokens: 10_000,
      query: FIXTURE_QUERY,
      packing_policy: "facts_first",
    });
    const packing = out["packing"] as {
      policy: string;
      reservedTokens: number;
      pages: { allocation: number; spent: number; candidates: number; items: number };
      facts: { allocation: number; spent: number; candidates: number; items: number };
    };
    expect(packing.policy).toBe("facts_first");
    // The reserved charge rides the wire accounting too; zero here, since
    // the fixture requests no attention block.
    expect(packing.reservedTokens).toBe(0);
    expect(packing.facts.items).toBe(1);
    expect(packing.pages.items).toBe(1);
    expect(packing.facts.spent + packing.pages.spent).toBe(out["tokens_used"] as number);
    expect(packing.facts.allocation + packing.pages.allocation + packing.reservedTokens).toBe(
      10_000,
    );
    // Facts first: the preference page leads despite the retired page's
    // unified-order slot.
    const items = out["items"] as Array<{ id: string }>;
    expect(items.map((i) => i.id)).toEqual(["pref-fix", "ret-fix"]);
  });
});
