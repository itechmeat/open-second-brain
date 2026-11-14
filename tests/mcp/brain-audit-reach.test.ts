/**
 * `brain_audit` answers at the caller's reach. The mutation history of a
 * preference is the trail of that preference's page and is private with
 * it: each record names the agent, the reason and the revision hashes of
 * a page the caller may not be able to read at all. The handler therefore
 * asks the same view every sibling reader asks before reading the trail,
 * and a withheld trail answers as an absent one - the empty history -
 * never as a refusal that would prove the id exists.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { writePreference } from "../../src/core/brain/preference.ts";
import { appendPrefAudit } from "../../src/core/brain/pref-audit.ts";
import { BRAIN_PREFERENCE_STATUS, PREF_AUDIT_OP } from "../../src/core/brain/types.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { TRANSPORT_REACH, type TransportReach } from "../../src/core/graph/transport-reach.ts";
import { REMOTE_DENY_VISIBILITY_TOKEN } from "../../src/core/graph/visibility.ts";
import { JSONRPC_VERSION, MCPServer, PROTOCOL_VERSION } from "../../src/mcp/index.ts";

const WITHHELD_MARKER = "zzwithheldreasonzz";
const RESERVE_LINE = `visibility: [${REMOTE_DENY_VISIBILITY_TOKEN}]`;

let tmp: string;
let vault: string;
let configHome: string;
let configPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-brain-audit-reach-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  configHome = mkdtempSync(join(tmpdir(), "o2b-brain-audit-reach-cfg-"));
  configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapBrain(vault, { configPath });
  confirmed("shared", "Prefer short sentences.");
  confirmed("withheld", "A rule reserved against remote reads.");
  reserve(join(vault, "Brain", "preferences", "pref-withheld.md"));
  audit("pref-shared", "readable trail");
  audit("pref-withheld", WITHHELD_MARKER);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

function confirmed(slug: string, principle: string): void {
  writePreference(vault, {
    slug,
    topic: slug,
    principle,
    created_at: "2026-05-01T00:00:00Z",
    unconfirmed_until: "2026-05-08T00:00:00Z",
    status: BRAIN_PREFERENCE_STATUS.confirmed,
    evidenced_by: [],
    confirmed_at: "2026-05-02T00:00:00Z",
  });
}

/** Insert frontmatter lines into a preference page already on disk. */
function reserve(abs: string): void {
  const text = readFileSync(abs, "utf8");
  const close = text.indexOf("\n---\n", "---\n".length);
  writeFileSync(abs, `${text.slice(0, close)}\n${RESERVE_LINE}${text.slice(close)}`);
}

function audit(prefId: string, reason: string): void {
  appendPrefAudit(
    vault,
    {
      pref_id: prefId,
      op: PREF_AUDIT_OP.create,
      agent: "dream",
      reason,
      revision_before: null,
      revision_after: 1,
      hash_before: null,
      hash_after: "abc123",
    },
    { now: new Date("2026-05-29T12:00:00Z") },
  );
}

async function auditCall(reach: TransportReach, prefId: string): Promise<Record<string, unknown>> {
  const server = new MCPServer({ vault, configPath }, { reach });
  await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "audit-reach-test", version: "0" },
    },
  });
  await server.handleRequest({ jsonrpc: JSONRPC_VERSION, method: "notifications/initialized" });
  const response = (await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 9,
    method: "tools/call",
    params: { name: "brain_audit", arguments: { pref_id: prefId } },
  })) as { result: { content: ReadonlyArray<{ type: string; text: string }> } };
  return JSON.parse(response.result.content[0]!.text) as Record<string, unknown>;
}

describe("brain_audit at remote reach", () => {
  test("the trail of a withheld preference answers as an absent one", async () => {
    const remote = await auditCall(TRANSPORT_REACH.remote, "pref-withheld");
    expect(remote["count"]).toBe(0);
    expect(remote["records"]).toEqual([]);
    expect(JSON.stringify(remote)).not.toContain(WITHHELD_MARKER);
    // Identical to absent: the same answer an unknown id gives, so the
    // empty history proves nothing about the preference's existence.
    const absent = await auditCall(TRANSPORT_REACH.remote, "pref-never-was");
    const { pref_id: _echoed, ...withheldShape } = remote as Record<string, unknown>;
    const { pref_id: _absentId, ...absentShape } = absent as Record<string, unknown>;
    expect(withheldShape).toEqual(absentShape);
  });

  test("a readable preference keeps its trail at remote reach", async () => {
    const remote = await auditCall(TRANSPORT_REACH.remote, "pref-shared");
    expect(remote["count"]).toBe(1);
    expect((remote["records"] as Array<Record<string, unknown>>)[0]!["reason"]).toBe(
      "readable trail",
    );
  });

  test("local reach keeps the withheld trail", async () => {
    const local = await auditCall(TRANSPORT_REACH.local, "pref-withheld");
    expect(local["count"]).toBe(1);
    expect(JSON.stringify(local)).toContain(WITHHELD_MARKER);
  });
});
