import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { emitContextReceipt } from "../../src/core/brain/context-receipts.ts";
import {
  CONTEXT_PACK_EVIDENCE_VERDICT,
  listContextPackEvidence,
} from "../../src/core/brain/context-pack-evidence.ts";
import { JSONRPC_VERSION, MCPServer, PROTOCOL_VERSION } from "../../src/mcp/index.ts";

let tmp: string;
let vault: string;
let configHome: string;
let configPath: string;
const savedEnv: Record<string, string | undefined> = {};

const PACKED_TEXT = "preference one\npreference two\n";

function writeConfig(enabled: boolean): void {
  atomicWriteFileSync(
    configPath,
    `vault: ${vault}\nagent_name: claude\ncontext_pack_outcome_enabled: "${enabled}"\n`,
  );
}

function seedReceipt(): { sampleId: string; finalTextHash: string; itemCount: number } {
  const record = emitContextReceipt(vault, {
    options: { host: "test", trigger: "context_pack", createdAt: "2026-07-01T00:00:00.000Z" },
    items: [
      { id: "pref-a", path: "Brain/preferences/pref-a.md", text: "preference one" },
      { id: "pref-b", path: "Brain/preferences/pref-b.md", text: "preference two" },
    ],
    finalText: PACKED_TEXT,
  });
  return {
    sampleId: record.id,
    finalTextHash: record.payload["final_text_hash"] as string,
    itemCount: record.payload["item_count"] as number,
  };
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-ctx-evidence-tool-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  configHome = mkdtempSync(join(tmpdir(), "o2b-ctx-evidence-tool-cfg-"));
  configPath = join(configHome, "config.yaml");
  for (const key of [
    "VAULT_AGENT_NAME",
    "VAULT_TIMEZONE",
    "VAULT_DIR",
    "OPEN_SECOND_BRAIN_CONFIG",
    "OPEN_SECOND_BRAIN_CONTEXT_PACK_OUTCOME_ENABLED",
  ]) {
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

async function initialize(server: MCPServer): Promise<void> {
  await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "ctx-evidence-test", version: "0" },
    },
  });
}

async function callTool(
  server: MCPServer,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = (await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 9,
    method: "tools/call",
    params: { name, arguments: args },
  })) as { result: { content: ReadonlyArray<{ type: string; text: string }> } };
  return JSON.parse(response.result.content[0]!.text);
}

describe("brain_context_pack_outcome evidence half", () => {
  test("post reports the kernel's verdict for a sample with no claim", async () => {
    writeConfig(true);
    const seeded = seedReceipt();
    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    const out = await callTool(server, "brain_context_pack_outcome", {
      operation: "post",
      sample_id: seeded.sampleId,
      first_pass_success: true,
    });
    expect(out["recorded"]).toBe(true);
    const evidence = out["evidence"] as Record<string, unknown>;
    expect(evidence["verdict"]).toBe(CONTEXT_PACK_EVIDENCE_VERDICT.unclaimed);
    expect(listContextPackEvidence(vault)).toHaveLength(1);
  });

  test("an agreeing claim reports match; a contradicted one reports mismatch and still records the outcome", async () => {
    writeConfig(true);
    const seeded = seedReceipt();
    const server = new MCPServer({ vault, configPath });
    await initialize(server);

    const agreeing = await callTool(server, "brain_context_pack_outcome", {
      operation: "post",
      sample_id: seeded.sampleId,
      first_pass_success: true,
      evidence_claim: { item_count: seeded.itemCount, final_text_hash: seeded.finalTextHash },
    });
    expect((agreeing["evidence"] as Record<string, unknown>)["verdict"]).toBe(
      CONTEXT_PACK_EVIDENCE_VERDICT.match,
    );

    const contradicted = await callTool(server, "brain_context_pack_outcome", {
      operation: "post",
      sample_id: seeded.sampleId,
      first_pass_success: true,
      evidence_claim: { item_count: 99 },
    });
    expect(contradicted["recorded"]).toBe(true);
    const evidence = contradicted["evidence"] as Record<string, unknown>;
    expect(evidence["verdict"]).toBe(CONTEXT_PACK_EVIDENCE_VERDICT.mismatch);
    expect(evidence["mismatches"]).toEqual([
      { field: "item_count", expected: "99", actual: String(seeded.itemCount) },
    ]);
    // the contradicted post is a RECORD, not a refusal: the outcome landed
    const list = await callTool(server, "brain_context_pack_outcome", { operation: "list" });
    expect(list["total"]).toBe(2);
  });

  test("a malformed claim is refused at the boundary rather than written as a guess", async () => {
    writeConfig(true);
    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    const response = (await server.handleRequest({
      jsonrpc: JSONRPC_VERSION,
      id: 4,
      method: "tools/call",
      params: {
        name: "brain_context_pack_outcome",
        arguments: {
          operation: "post",
          sample_id: "s1",
          first_pass_success: true,
          evidence_claim: { item_count: -3 },
        },
      },
    })) as { error?: { message: string } };
    expect(response.error?.message).toContain("item_count");
  });

  test("gate off writes no evidence record and reports none", async () => {
    writeConfig(false);
    const seeded = seedReceipt();
    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    const out = await callTool(server, "brain_context_pack_outcome", {
      operation: "post",
      sample_id: seeded.sampleId,
      first_pass_success: true,
      evidence_claim: { item_count: 99 },
    });
    expect(out["recorded"]).toBe(false);
    expect("evidence" in out).toBe(false);
    expect(listContextPackEvidence(vault)).toHaveLength(0);
  });

  test("a post with no evidence_claim is byte-identical to one made before the field existed", async () => {
    writeConfig(true);
    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    const out = await callTool(server, "brain_context_pack_outcome", {
      operation: "post",
      sample_id: "opaque_hash",
      first_pass_success: true,
    });
    const list = await callTool(server, "brain_context_pack_outcome", { operation: "list" });
    const rows = list["records"] as ReadonlyArray<{ payload: Record<string, unknown> }>;
    expect(Object.keys(rows[0]!.payload).toSorted()).toEqual(["first_pass_success", "sample_id"]);
    // the evidence row records that the sample has nothing behind it
    const evidence = out["evidence"] as Record<string, unknown>;
    expect(evidence["verdict"]).toBe(CONTEXT_PACK_EVIDENCE_VERDICT.unresolved);
    expect(evidence["unresolved_reason"]).toBe("sample_absent");
  });
});
