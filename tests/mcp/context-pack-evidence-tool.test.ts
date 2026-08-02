import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { emitContextReceipt } from "../../src/core/brain/context-receipts.ts";
import {
  CONTEXT_PACK_EVIDENCE_VERDICT,
  listContextPackEvidence,
} from "../../src/core/brain/context-pack-evidence.ts";
import { continuityLogPath } from "../../src/core/brain/continuity/store.ts";
import { JSONRPC_VERSION, MCPServer, PROTOCOL_VERSION } from "../../src/mcp/index.ts";

let tmp: string;
let vault: string;
let configHome: string;
let configPath: string;
const savedEnv: Record<string, string | undefined> = {};

const PACKED_TEXT = "preference one\npreference two\n";

/** The opaque sample id the claimless byte-identity fixture posts on. */
const CLAIMLESS_SAMPLE_ID = "opaque_hash";

/** Length of the `YYYY-MM` month key a continuity shard is named for. */
const MONTH_KEY_LENGTH = 7;

/**
 * The serialized `payload` of a claimless `post`, exactly as it stood
 * before `evidence_claim` existed. `JSON.stringify` emits insertion
 * order, so this literal pins the key ORDER as well as the values -
 * sorting the keys before comparing, which is what this test used to do,
 * destroys precisely the property "byte-identical" names.
 */
const GOLDEN_CLAIMLESS_PAYLOAD = '{"sample_id":"opaque_hash","first_pass_success":true}';

/** Payload key order of the pre-claim outcome row, in emission order. */
const GOLDEN_CLAIMLESS_PAYLOAD_KEYS: ReadonlyArray<string> = Object.freeze([
  "sample_id",
  "first_pass_success",
]);

/**
 * The whole JSONL record line a claimless `post` writes. `id` and
 * `createdAt` are the only fields a run cannot fix - the id is a content
 * hash over a wall-clock timestamp - so they are interpolated from the
 * record under test and everything else, envelope key order included, is
 * pinned as a literal.
 */
function goldenOutcomeLine(id: string, createdAt: string): string {
  return (
    `{"schema":"o2b.continuity.v1","id":"${id}","kind":"context_pack_outcome",` +
    `"createdAt":"${createdAt}","sourceRefs":[],"payload":${GOLDEN_CLAIMLESS_PAYLOAD},` +
    `"private":false,"redacted":false}`
  );
}

/** Raw lines of the month shard a record with this timestamp lands in. */
function shardLines(createdAt: string): ReadonlyArray<string> {
  return readFileSync(continuityLogPath(vault, createdAt.slice(0, MONTH_KEY_LENGTH)), "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0);
}

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
      sample_id: CLAIMLESS_SAMPLE_ID,
      first_pass_success: true,
    });
    const list = await callTool(server, "brain_context_pack_outcome", { operation: "list" });
    const rows = list["records"] as ReadonlyArray<{ id: string; createdAt: string }>;
    const row = rows[0]!;
    expect(row.id).toBe(out["id"] as string);

    // The record as it actually sits on disk. Key order has to be read
    // off the shard rather than off the MCP envelope, which re-serializes
    // with sorted keys - and sorting before comparing, which this test
    // used to do, destroys exactly the property "byte-identical" names.
    const line = shardLines(row.createdAt).find((entry) => entry.includes(`"id":"${row.id}"`));
    expect(line).toBe(goldenOutcomeLine(row.id, row.createdAt));
    const written = JSON.parse(line!) as { payload: Record<string, unknown> };
    expect(Object.keys(written.payload)).toEqual([...GOLDEN_CLAIMLESS_PAYLOAD_KEYS]);
    expect(JSON.stringify(written.payload)).toBe(GOLDEN_CLAIMLESS_PAYLOAD);

    // the evidence row records that the sample has nothing behind it
    const evidence = out["evidence"] as Record<string, unknown>;
    expect(evidence["verdict"]).toBe(CONTEXT_PACK_EVIDENCE_VERDICT.unresolved);
    expect(evidence["unresolved_reason"]).toBe("sample_absent");
  });
});
