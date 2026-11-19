/**
 * The preview an over-budget tool result gets while the artifact store is
 * refused by the migration gate carries the refusal in its note. For a
 * damaged or unreadable gate that refusal names the gate file's absolute
 * path, a host path: below local reach it is redacted like every other path
 * a result names; a local caller keeps it.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { resetFreezeMarkerCache } from "../../src/core/brain/freeze-marker.ts";
import { resetVaultIdentityPins } from "../../src/core/brain/vault-identity.ts";
import { TRANSPORT_REACH, type TransportReach } from "../../src/core/graph/transport-reach.ts";
import { migrationGatePath } from "../../src/core/migration-gate.ts";
import { MCPServer } from "../../src/mcp/server.ts";

let tmp: string;
let vault: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-preview-gate-reach-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  writeFileSync(join(vault, "Brain", "_brain.yaml"), "schema_version: 1\n");
  mkdirSync(join(vault, "notes"), { recursive: true });
  for (let i = 0; i < 40; i++) {
    writeFileSync(
      join(vault, "notes", `note-${i}.md`),
      `---\ntype: note\n---\n\n# Note ${i}\n\nLinks [[note-${(i + 1) % 40}]] and [[note-${(i + 7) % 40}]].\n`,
    );
  }
  for (const key of ["XDG_STATE_HOME", "LOCALAPPDATA"]) {
    saved[key] = process.env[key];
    process.env[key] = join(tmp, "state");
  }
  // A damaged gate: it refuses every vault, and its refusal names the file.
  const gate = migrationGatePath();
  mkdirSync(dirname(gate), { recursive: true });
  writeFileSync(gate, "{ not a gate");
  resetFreezeMarkerCache();
  resetVaultIdentityPins();
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(tmp, { recursive: true, force: true });
});

async function previewAt(reach: TransportReach): Promise<Record<string, unknown>> {
  const server = new MCPServer({ vault }, { reach });
  const response = (await server.handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "schema_inspect", arguments: { view: "graph" } },
  })) as { result?: { content: Array<{ text: string }> } };
  return JSON.parse(response.result!.content[0]!.text) as Record<string, unknown>;
}

test("below local reach the note names no host path; a local caller keeps it", async () => {
  const gate = migrationGatePath();
  const remote = await previewAt(TRANSPORT_REACH.remote);
  expect(remote["preview_truncated"]).toBe(true);
  expect(remote["artifact_id"]).toBeNull();
  expect(String(remote["note"])).toContain("damaged");
  expect(String(remote["note"])).not.toContain(gate);
  const local = await previewAt(TRANSPORT_REACH.local);
  expect(String(local["note"])).toContain(gate);
});
