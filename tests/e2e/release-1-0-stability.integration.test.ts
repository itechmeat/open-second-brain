/**
 * Release 1.0.0 - Stability & Trust, end-to-end composition
 * (epic t_a77ade0a): one temp vault exercises every unit together.
 *
 *   1. A removed alias answers a tombstone over MCP tools/call.
 *   2. The staged dream lifecycle runs stage -> validate -> apply and
 *      the doctor flags a stale alias reference in a Brain note.
 *   3. A brief renders the configured timezone additively.
 *   4. A second digest run reports a precise snapshot delta.
 *   5. A long operation aborts cleanly under a tripped safeguard.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runDoctor } from "../../src/core/brain/doctor.ts";
import {
  applyDreamBundle,
  stageDream,
  validateDreamBundle,
} from "../../src/core/brain/dream-stage.ts";
import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { listMetrics } from "../../src/core/brain/metrics.ts";
import { createSafeguard, SafeguardTimeoutError } from "../../src/core/brain/safeguard.ts";
import { writeSignal } from "../../src/core/brain/signal.ts";
import { indexVault } from "../../src/core/search/indexer.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { JSONRPC_VERSION, MCPServer, PROTOCOL_VERSION } from "../../src/mcp/index.ts";
import { makeConfig } from "../helpers/search-fixtures.ts";

let tmp: string;
let vault: string;
let configPath: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-e2e-stability-"));
  vault = join(tmp, "vault");
  configPath = join(tmp, "config.yaml");
  for (const key of [
    "VAULT_AGENT_NAME",
    "VAULT_TIMEZONE",
    "VAULT_DIR",
    "OPEN_SECOND_BRAIN_CONFIG",
    "OPEN_SECOND_BRAIN_REPORT_SNAPSHOTS",
  ]) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env["OPEN_SECOND_BRAIN_CONFIG"] = configPath;
  atomicWriteFileSync(
    configPath,
    `vault: ${vault}\nagent_name: claude\ntimezone: Europe/Berlin\nreport_snapshots_enabled: true\n`,
  );
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function makeServer(): Promise<MCPServer> {
  const server = new MCPServer({ vault, configPath });
  await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "stability-e2e", version: "0" },
    },
  });
  await server.handleRequest({ jsonrpc: JSONRPC_VERSION, method: "notifications/initialized" });
  return server;
}

let id = 100;
async function call(server: MCPServer, name: string, args: Record<string, unknown>) {
  id += 1;
  return (await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id,
    method: "tools/call",
    params: { name, arguments: args },
  })) as {
    result?: { structuredContent?: Record<string, unknown> };
    error?: { code: number; message: string };
  };
}

test("the 1.0.0 composition holds end to end", async () => {
  const server = await makeServer();

  // 1. Tombstone: the removed alias names its replacement.
  const tombstone = await call(server, "brain_digest", {});
  expect(tombstone.error!.code).toBe(-32602);
  expect(tombstone.error!.message).toContain("brain_digest was removed in 1.0.0");
  expect(tombstone.error!.message).toContain('brain_brief with view="digest"');

  // 2. Doctor flags a stale alias reference in a Brain note.
  writeFileSync(
    join(vault, "Brain", "old-playbook.md"),
    "# Playbook\n\nEvery morning call brain_digest first.\n",
  );
  const doctorWarnings = runDoctor(vault).warnings.filter(
    (w) => w.code === "removed-tool-reference",
  );
  expect(doctorWarnings).toHaveLength(1);
  expect(doctorWarnings[0]!.message).toContain("brain_brief");

  // Staged dream lifecycle over a real signal cluster.
  for (const i of [1, 2, 3]) {
    writeSignal(vault, {
      topic: "e2e-topic",
      signal: "positive",
      agent: "claude",
      principle: "Rule for e2e-topic.",
      created_at: "2026-06-01T10:00:00Z",
      date: "2026-06-01",
      slug: `e2e-${i}`,
      scope: "writing",
    });
  }
  const bundle = stageDream(vault, { now: new Date("2026-06-05T12:00:00Z") });
  expect(bundle.plan.new_unconfirmed).toEqual(["pref-e2e-topic"]);
  const verdict = validateDreamBundle(vault, bundle.runId, {
    now: new Date("2026-06-05T13:00:00Z"),
  });
  expect(verdict.valid).toBe(true);
  const outcome = applyDreamBundle(vault, bundle.runId, {
    now: new Date("2026-06-05T13:00:00Z"),
  });
  expect(outcome.applied).toBe(true);
  expect(listMetrics(vault, { surface: "dream_stage" }).length).toBeGreaterThanOrEqual(2);

  // 3. Timezone: the daily brief carries additive local fields.
  const brief = await call(server, "brain_brief", { view: "daily", date: "2026-06-05" });
  const briefBody = brief.result!.structuredContent!;
  expect(briefBody["timezone"]).toBe("Europe/Berlin");
  expect(String(briefBody["local_time"])).toMatch(/\+0[12]:00$/);

  // 4. Dual output: the second digest run reports a delta against the
  //    first day's snapshot (the applied preference changed the data).
  const firstDigest = await call(server, "brain_brief", {
    view: "digest",
    since: "2026-06-01T00:00:00Z",
    until: "2026-06-04T00:00:00Z",
  });
  expect(firstDigest.result!.structuredContent!["delta"]).toBeDefined();
  const secondDigest = await call(server, "brain_brief", {
    view: "digest",
    since: "2026-06-01T00:00:00Z",
    until: "2026-06-06T00:00:00Z",
  });
  const delta = secondDigest.result!.structuredContent!["delta"] as {
    prior_date: string | null;
  };
  expect(delta.prior_date).toBe("2026-06-04");

  // 5. Safeguard: a tripped deadline aborts indexing at a checkpoint.
  writeFileSync(join(vault, "note-a.md"), "# A\n\nBody.\n");
  let calls = 0;
  const tripped = createSafeguard({
    operation: "reindex",
    timeoutMs: 1,
    now: () => {
      calls += 1;
      return calls === 1 ? 0 : 10_000;
    },
  });
  const searchConfig = makeConfig({ vault, dbPath: join(tmp, "index.sqlite") });
  await expect(indexVault(searchConfig, { safeguard: tripped })).rejects.toThrow(
    SafeguardTimeoutError,
  );
});
