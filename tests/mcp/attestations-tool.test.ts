/**
 * `brain_attestations` (delivery trust, Lane D task D6): the read-only
 * MCP face over the attestation kernel.
 *
 * The split is the `brain_secrets` split applied to signatures: list and
 * verify are agent-facing reads, keygen and sign have NO MCP surface -
 * the input schema's operation enum is closed to `list | verify`, and
 * that closure is what this suite pins, because a mutation operation
 * added to the enum later would widen the agent surface without any test
 * noticing.
 *
 * Everything rides the JSON-RPC harness with fixture attestations written
 * through the kernel itself, and verify consumes exactly the K4
 * `AttestationVerification` shape. The tool joins `BRAIN_TOOLS` as a
 * `read`; the frozen tool-NAME parity set is the shared pass's file and
 * is deliberately not imported here.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { collectAttestationManifest } from "../../src/core/brain/attestation/digest.ts";
import {
  buildAttestationRecord,
  writeAttestationRecord,
} from "../../src/core/brain/attestation/record.ts";
import {
  generateAttestationKeypair,
  signAttestationRecord,
} from "../../src/core/brain/attestation/signing.ts";
import { appendLogEvent } from "../../src/core/brain/log.ts";
import { writeVaultIdentity } from "../../src/core/brain/vault-identity.ts";
import { TRANSPORT_REACH } from "../../src/core/graph/transport-reach.ts";
import { ATTEST_TOOLS } from "../../src/mcp/brain/attest-tools.ts";
import { BRAIN_TOOLS } from "../../src/mcp/brain-tools.ts";
import { JSONRPC_VERSION, MCPServer, PROTOCOL_VERSION } from "../../src/mcp/index.ts";
import { buildToolTable } from "../../src/mcp/tools.ts";

const DATE = "2026-06-03";

let tmp: string;
let vault: string;
let configHome: string;
let configPath: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-mcp-attestations-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain", "log"), { recursive: true });
  writeFileSync(join(vault, "Brain", "_brain.yaml"), "schema_version: 1\n", "utf8");
  writeVaultIdentity(vault);
  configHome = mkdtempSync(join(tmpdir(), "o2b-mcp-attestations-cfg-"));
  configPath = join(configHome, "config.yaml");
  for (const key of ["VAULT_DIR", "VAULT_AGENT_NAME", "OPEN_SECOND_BRAIN_CONFIG"]) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env["OPEN_SECOND_BRAIN_CONFIG"] = configPath;
  writeFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`, "utf8");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function append(count: number): void {
  for (let i = 0; i < count; i++) {
    appendLogEvent(
      vault,
      {
        timestamp: `${DATE}T10:00:0${i}Z`,
        eventType: "note",
        body: { text: `event ${i}`, agent: "@tester" },
      },
      {},
    );
  }
}

/** Keygen, sign and write one fixture attestation over the store as it stands. */
function writeFixtureAttestation(): string {
  generateAttestationKeypair(vault);
  const record = buildAttestationRecord(vault, collectAttestationManifest(vault), {
    now: new Date("2026-06-03T10:05:00Z"),
  });
  return writeAttestationRecord(vault, signAttestationRecord(record, vault)).path;
}

interface CallOutcome {
  readonly result: Record<string, unknown> | null;
  readonly error: { readonly code: number; readonly message: string } | null;
}

async function callAttestations(
  args: Record<string, unknown>,
  runtime: { reach?: (typeof TRANSPORT_REACH)[keyof typeof TRANSPORT_REACH] } = {},
): Promise<CallOutcome> {
  const server = new MCPServer({ vault, configPath }, { reach: TRANSPORT_REACH.local, ...runtime });
  await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "attestations-test", version: "0" },
    },
  });
  await server.handleRequest({ jsonrpc: JSONRPC_VERSION, method: "notifications/initialized" });
  const response = (await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 9,
    method: "tools/call",
    params: { name: "brain_attestations", arguments: args },
  })) as {
    result?: { content: ReadonlyArray<{ type: string; text: string }> };
    error?: { code: number; message: string };
  };
  if (response.error !== undefined) return { result: null, error: response.error };
  return {
    result: JSON.parse(response.result?.content[0]?.text ?? "null") as Record<string, unknown>,
    error: null,
  };
}

test("one read-only tool, registered in the full table, absent from the writer table", () => {
  expect(ATTEST_TOOLS).toHaveLength(1);
  const tool = ATTEST_TOOLS[0]!;
  expect(tool.name).toBe("brain_attestations");
  expect(tool.kind).toBe("read");
  expect(BRAIN_TOOLS.some((entry) => entry.name === "brain_attestations")).toBe(true);
  expect(buildToolTable("full").some((entry) => entry.name === "brain_attestations")).toBe(true);
  expect(buildToolTable("writer").some((entry) => entry.name === "brain_attestations")).toBe(false);
});

test("the operation enum is closed to list and verify: signing has no MCP face", () => {
  const schema = ATTEST_TOOLS[0]!.inputSchema as {
    properties: { operation: { enum: ReadonlyArray<string> } };
    required: ReadonlyArray<string>;
  };
  expect([...schema.properties.operation.enum]).toEqual(["list", "verify"]);
  expect(schema.required).toContain("operation");
  // No key material path, no mutation verb anywhere in the schema.
  const text = JSON.stringify(ATTEST_TOOLS[0]!.inputSchema);
  expect(text).not.toContain("keygen");
  expect(text).not.toContain('sign"');
});

test("list returns the fixture attestation newest-first with id, created_at, device", async () => {
  append(2);
  const path = writeFixtureAttestation();

  const { result, error } = await callAttestations({ operation: "list" });

  expect(error).toBeNull();
  const rows = result!["attestations"] as ReadonlyArray<Record<string, unknown>>;
  expect(rows).toHaveLength(1);
  expect(rows[0]!["id"]).toMatch(/^attest-\d{8}T\d{6}\d{3}Z$/);
  expect(rows[0]!["created_at"]).toBe("2026-06-03T10:05:00.000Z");
  expect(typeof rows[0]!["device_id"]).toBe("string");
  expect(rows[0]!["path"]).toBe(path.slice(vault.length + 1));
});

test("list reports an unreadable record on its own row and still lists the readable ones", async () => {
  append(2);
  writeFixtureAttestation();
  // A record file that exists but cannot be read is damage to name:
  // silently dropping the evidence is the one failure this family exists
  // to prevent, so the unreadable file is named on its own row - with
  // the vault root redacted - while the readable records still list,
  // instead of one corrupted file silencing the whole inventory.
  writeFileSync(
    join(vault, ".open-second-brain", "attestations", "attest-20990101T000000000Z.json"),
    "{not json at all",
    "utf8",
  );

  const { result, error } = await callAttestations({ operation: "list" });

  expect(error).toBeNull();
  const rows = result!["attestations"] as ReadonlyArray<Record<string, unknown>>;
  expect(rows).toHaveLength(1);
  const unreadable = result!["unreadable"] as ReadonlyArray<Record<string, string>>;
  expect(unreadable).toHaveLength(1);
  expect(unreadable[0]!["path"]).toContain("attest-20990101T000000000Z.json");
  expect(unreadable[0]!["reason"]).toContain("corrupted JSON");
  expect(unreadable[0]!["reason"]).not.toContain(vault);
});

test("verify answers against the exported public half and never derives from the private seed", async () => {
  append(2);
  writeFixtureAttestation();
  // The fixture record is signed with the vault's own key, so removing
  // the export must turn the agent-facing verification negative - the
  // derive-from-seed fallback is the operator CLI's local convenience,
  // never something an agent-triggered read performs.
  rmSync(join(vault, ".open-second-brain", "keys", "attestation", "attestation.pub"));

  const { result, error } = await callAttestations({ operation: "verify" });

  expect(error).toBeNull();
  expect((result as Record<string, unknown>)["signatureValid"]).toBe(false);
});

test("verify returns the K4 shape over the harness", async () => {
  append(2);
  writeFixtureAttestation();

  const { result, error } = await callAttestations({ operation: "verify" });

  expect(error).toBeNull();
  expect(result!["recordId"]).toMatch(/^attest-\d{8}T\d{6}\d{3}Z$/);
  expect(result!["createdAt"]).toBe("2026-06-03T10:05:00.000Z");
  expect(result!["signatureValid"]).toBe(true);
  const shards = result!["shards"] as ReadonlyArray<Record<string, unknown>>;
  expect(shards).toHaveLength(1);
  expect(shards[0]).toEqual({ shardId: `${DATE}.jsonl`, state: "intact" });
  expect(result!["storeDigestMatches"]).toBe(true);
});

test("verify with nothing signed says so, and an unknown operation is refused", async () => {
  const empty = await callAttestations({ operation: "verify" });
  expect(empty.error).toBeNull();
  expect(empty.result!["verified"]).toBeNull();

  const bad = await callAttestations({ operation: "sign" });
  expect(bad.result).toBeNull();
  expect(bad.error).not.toBeNull();
  expect(bad.error!.message).toContain("list");
});
