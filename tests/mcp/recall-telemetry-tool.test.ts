import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendContinuityRecord } from "../../src/core/brain/continuity/store.ts";
import { brainConfigPath } from "../../src/core/brain/paths.ts";
import {
  emitRecallTelemetry,
  RECALL_CHANNEL,
  RECALL_CHANNELS,
  RECALL_TELEMETRY_MODES,
  RECALL_TELEMETRY_STATUSES,
} from "../../src/core/brain/recall-telemetry.ts";
import { recordHostMemoryWrite } from "../../src/core/brain/host-memory-write.ts";
import { writePreference } from "../../src/core/brain/preference.ts";
import { BRAIN_CONFIDENCE, BRAIN_PREFERENCE_STATUS } from "../../src/core/brain/types.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { TRANSPORT_REACH } from "../../src/core/graph/transport-reach.ts";
import { JSONRPC_VERSION, MCPServer, PROTOCOL_VERSION } from "../../src/mcp/index.ts";
import { INVALID_PARAMS } from "../../src/mcp/protocol.ts";
import { buildToolTable } from "../../src/mcp/tools.ts";

let tmp: string;
let vault: string;
let configHome: string;
let configPath: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-mcp-recall-telemetry-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  configHome = mkdtempSync(join(tmpdir(), "o2b-mcp-recall-telemetry-cfg-"));
  configPath = join(configHome, "config.yaml");
  for (const key of [
    "VAULT_AGENT_NAME",
    "VAULT_TIMEZONE",
    "VAULT_DIR",
    "OPEN_SECOND_BRAIN_CONFIG",
  ]) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env["OPEN_SECOND_BRAIN_CONFIG"] = configPath;
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
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
      clientInfo: { name: "recall-telemetry-test", version: "0" },
    },
  });
  await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    method: "notifications/initialized",
  });
}

async function callTelemetry(
  server: MCPServer,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return callTool(server, "brain_recall_telemetry", args);
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

describe("brain_recall_telemetry tool registration", () => {
  test("registered in the full tool table only", () => {
    expect(
      buildToolTable("full").find((tool) => tool.name === "brain_recall_telemetry"),
    ).toBeDefined();
    expect(
      buildToolTable("writer").find((tool) => tool.name === "brain_recall_telemetry"),
    ).toBeUndefined();
  });
});

describe("brain_recall_telemetry tool", () => {
  test("lists records and summarizes recall gaps", async () => {
    emitRecallTelemetry(vault, {
      createdAt: "2026-05-20T16:00:00.000Z",
      host: "mcp-test",
      channel: RECALL_CHANNEL.mcp,
      mode: "context_pack",
      status: "ok",
      durationMs: 4,
      resultCount: 1,
      topArtifacts: [{ id: "pref-alpha" }],
    });
    emitRecallTelemetry(vault, {
      createdAt: "2026-05-20T16:01:00.000Z",
      host: "mcp-test",
      channel: RECALL_CHANNEL.mcp,
      mode: "search",
      status: "empty",
      durationMs: 9,
      resultCount: 0,
      gaps: ["missing_recent_decision"],
    });

    const server = new MCPServer({ vault, configPath });
    await initialize(server);

    const list = await callTelemetry(server, {
      operation: "list",
      mode: "context_pack",
    });
    expect(list["total"]).toBe(1);
    expect((list["records"] as Array<Record<string, unknown>>)[0]!["payload"]).toMatchObject({
      mode: "context_pack",
      result_count: 1,
    });

    const summary = await callTelemetry(server, {
      operation: "summary",
      host: "mcp-test",
    });
    expect(summary).toMatchObject({
      total: 2,
      by_mode: { context_pack: 1, search: 1 },
      by_status: { ok: 1, empty: 1 },
      total_results: 1,
      empty_runs: 1,
      gap_counts: { missing_recent_decision: 1 },
    });
  });

  test("context-pack and pre-compress tools can opt in to receipts and telemetry", async () => {
    writePreference(vault, {
      slug: "alpha",
      topic: "alpha",
      principle: "Prefer crisp answers",
      created_at: "2026-05-20T00:00:00.000Z",
      unconfirmed_until: "2026-05-21T00:00:00.000Z",
      status: BRAIN_PREFERENCE_STATUS.confirmed,
      evidenced_by: ["[[sig-2026-05-20-alpha]]"],
      confirmed_at: "2026-05-20T01:00:00.000Z",
      applied_count: 1,
      violated_count: 0,
      last_evidence_at: "2026-05-20T01:00:00.000Z",
      confidence: BRAIN_CONFIDENCE.high,
      confidence_value: 0.9,
    });
    const server = new MCPServer({ vault, configPath });
    await initialize(server);

    const contextPack = await callTool(server, "brain_context_pack", {
      max_tokens: 10000,
      receipt: true,
      receipt_host: "mcp-test",
      telemetry: true,
      telemetry_host: "mcp-test",
    });
    expect(contextPack["receipt_id"]).toStartWith("ctn_");
    expect(contextPack["telemetry_id"]).toStartWith("ctn_");

    const preCompress = await callTool(server, "brain_pre_compress_pack", {
      receipt: true,
      receipt_host: "mcp-test",
      telemetry: true,
      telemetry_host: "mcp-test",
    });
    expect(preCompress["receipt_id"]).toStartWith("ctn_");
    expect(preCompress["telemetry_id"]).toStartWith("ctn_");

    const receipts = await callTool(server, "brain_context_receipts", {
      operation: "list",
      host: "mcp-test",
    });
    expect(receipts["total"]).toBe(2);
    expect(
      (receipts["receipts"] as Array<Record<string, unknown>>)
        .map((receipt) => receipt["trigger"])
        .toSorted(),
    ).toEqual(["context_pack", "pre_compress"]);

    const summary = await callTelemetry(server, {
      operation: "summary",
      host: "mcp-test",
    });
    expect(summary).toMatchObject({
      total: 2,
      by_mode: { context_pack: 1, pre_compress: 1 },
      by_status: { ok: 2 },
    });
  });

  test("cost meter folds write volume against reads", async () => {
    recordHostMemoryWrite(vault, {
      action: "add",
      target: "memory",
      content: "one",
      createdAt: "2026-05-20T09:00:00.000Z",
    });
    recordHostMemoryWrite(vault, {
      action: "add",
      target: "memory",
      content: "two",
      createdAt: "2026-05-20T09:01:00.000Z",
    });
    emitRecallTelemetry(vault, {
      createdAt: "2026-05-20T09:02:00.000Z",
      host: "mcp-test",
      channel: RECALL_CHANNEL.mcp,
      mode: "search",
      status: "ok",
      durationMs: 3,
      resultCount: 1,
    });

    const server = new MCPServer({ vault, configPath });
    await initialize(server);

    const meter = await callTelemetry(server, {
      operation: "cost",
      write_cost: 2,
      read_cost: 1,
    });
    expect(meter).toMatchObject({
      write_read_ratio: 2, // 2 host writes / 1 read
      write_heavy: true,
      cost: { write: 4, read: 1, total: 5 },
    });
    expect((meter["writes"] as Record<string, unknown>)["by_kind"]).toEqual({
      host_memory_write: 2,
    });
  });

  test("cost meter rejects a negative weight", async () => {
    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    const response = (await server.handleRequest({
      jsonrpc: JSONRPC_VERSION,
      id: 9,
      method: "tools/call",
      params: {
        name: "brain_recall_telemetry",
        arguments: { operation: "cost", write_cost: -1 },
      },
    })) as { result?: { isError?: boolean }; error?: unknown };
    // Invalid params surface as a tool error rather than a valid meter.
    expect(response.error ?? response.result?.isError).toBeTruthy();
  });

  test("cost meter rejects read-side-only filters (mode/status/host/limit)", async () => {
    // Parity with the CLI: mode/status/host/limit filter recall records only
    // and have no write-side analogue. They must be rejected for the cost
    // meter, not silently ignored as a valid filtered result.
    for (const field of ["mode", "status", "host", "limit"]) {
      const server = new MCPServer({ vault, configPath });
      await initialize(server);
      const response = (await server.handleRequest({
        jsonrpc: JSONRPC_VERSION,
        id: 9,
        method: "tools/call",
        params: {
          name: "brain_recall_telemetry",
          arguments: { operation: "cost", [field]: "search" },
        },
      })) as { error?: { code: number; message: string } };
      expect(response.error?.code).toBe(INVALID_PARAMS);
      expect(response.error?.message).toContain(field);
    }
  });
});

describe("brain_observed_use tool (t_65588d8b)", () => {
  test("records verdicts and surfaces them via observed_reuse", async () => {
    // The keys are page references, so both pages exist: a key whose page
    // the caller cannot read is withheld from the fold (see the reach
    // test below).
    mkdirSync(join(vault, "notes"), { recursive: true });
    writeFileSync(join(vault, "notes", "a.md"), "---\nkind: note\n---\n\na\n");
    writeFileSync(join(vault, "notes", "b.md"), "---\nkind: note\n---\n\nb\n");
    const server = new MCPServer({ vault, configPath });
    await initialize(server);

    const rec = await callTool(server, "brain_observed_use", {
      entries: [
        { id: "1", path: "notes/a.md", verdict: "USED" },
        { id: "2", path: "notes/b.md", verdict: "CONTRADICTED" },
      ],
    });
    expect(rec.recorded).toBe(2);

    const reuse = await callTelemetry(server, { operation: "observed_reuse" });
    expect(reuse.total).toBe(2);
    const artifacts = reuse.artifacts as Array<Record<string, unknown>>;
    const a = artifacts.find((x) => x.key === "notes/a.md");
    expect(a?.score).toBe(1);
    const b = artifacts.find((x) => x.key === "notes/b.md");
    expect(b?.score).toBe(0);
  });

  test("rejects an invalid verdict", async () => {
    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    const response = (await server.handleRequest({
      jsonrpc: JSONRPC_VERSION,
      id: 9,
      method: "tools/call",
      params: {
        name: "brain_observed_use",
        arguments: { entries: [{ id: "1", verdict: "MAYBE" }] },
      },
    })) as { error?: { code: number } };
    expect(response.error?.code).toBe(INVALID_PARAMS);
  });

  test("observed_reuse answers at the caller's reach", async () => {
    // One key the caller can read and one whose page is reserved against
    // remote reads; the write path accepts any path unchecked, so the log
    // holds both.
    mkdirSync(join(vault, "notes"), { recursive: true });
    writeFileSync(join(vault, "notes", "visible.md"), "---\nkind: note\n---\n\nvisible\n");
    writeFileSync(
      join(vault, "notes", "hidden.md"),
      "---\nkind: note\nvisibility: [private]\n---\n\nhidden\n",
    );
    await callTool(new MCPServer({ vault, configPath }), "brain_observed_use", {
      entries: [
        { id: "1", path: "notes/visible.md", verdict: "USED" },
        { id: "2", path: "notes/hidden.md", verdict: "USED" },
      ],
    });

    const remote = new MCPServer({ vault, configPath }, { reach: TRANSPORT_REACH.remote });
    await initialize(remote);
    const seen = await callTelemetry(remote, { operation: "observed_reuse" });
    const keys = (seen["artifacts"] as Array<{ key: string }>).map((a) => a.key);
    expect(keys).toEqual(["notes/visible.md"]);
    // Dropped BEFORE total, so the withheld key's number is not leaked.
    expect(seen["total"]).toBe(1);

    // Local reach keeps both keys.
    const local = new MCPServer({ vault, configPath }, { reach: TRANSPORT_REACH.local });
    await initialize(local);
    const all = await callTelemetry(local, { operation: "observed_reuse" });
    expect(all["total"]).toBe(2);
  });
});

describe("brain_recall_telemetry channel dimension", () => {
  test("the mode enum admits every mode the server records", () => {
    // The schema enum used to omit `query`, so a legitimately recorded
    // mode was rejected at the tool boundary before the handler ran.
    const tool = buildToolTable("full").find((t) => t.name === "brain_recall_telemetry")!;
    const properties = (tool.inputSchema as { properties: Record<string, { enum?: string[] }> })
      .properties;
    expect(properties["mode"]!.enum).toEqual([...RECALL_TELEMETRY_MODES]);
    expect(properties["channel"]!.enum).toEqual([...RECALL_CHANNELS]);
    expect(properties["status"]!.enum).toEqual([...RECALL_TELEMETRY_STATUSES]);
  });

  test("filters by channel and rolls the deliveries up per channel", async () => {
    emitRecallTelemetry(vault, {
      createdAt: "2026-05-20T17:00:00.000Z",
      host: "mcp-test",
      channel: RECALL_CHANNEL.hook,
      mode: "search",
      status: "empty",
      durationMs: 1,
      resultCount: 0,
    });
    emitRecallTelemetry(vault, {
      createdAt: "2026-05-20T17:01:00.000Z",
      host: "mcp-test",
      channel: RECALL_CHANNEL.mcp,
      mode: "query",
      status: "ok",
      durationMs: 1,
      resultCount: 3,
    });

    const server = new MCPServer({ vault, configPath });
    await initialize(server);

    const hooks = await callTelemetry(server, { operation: "list", channel: "hook" });
    expect(hooks["total"]).toBe(1);

    const byQuery = await callTelemetry(server, { operation: "list", mode: "query" });
    expect(byQuery["total"]).toBe(1);

    const summary = await callTelemetry(server, { operation: "summary" });
    expect(summary["by_channel"]).toEqual({ hook: 1, mcp: 1 });
  });

  test("rejects a channel outside the closed set", async () => {
    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    const response = (await server.handleRequest({
      jsonrpc: JSONRPC_VERSION,
      id: 9,
      method: "tools/call",
      params: {
        name: "brain_recall_telemetry",
        arguments: { operation: "list", channel: "hermes" },
      },
    })) as { error?: { code: number; message: string } };
    expect(response.error?.code).toBe(INVALID_PARAMS);
    expect(response.error?.message).toContain("mcp, cli, hook");
  });
});

describe("brain_recall_telemetry reach boundary on list, summary and gate ops", () => {
  test("list, summary, gate_list and gate_summary drop withheld records at remote reach", async () => {
    // Two pages: one the remote caller may read, one reserved.
    mkdirSync(join(vault, "notes"), { recursive: true });
    writeFileSync(join(vault, "notes", "open.md"), "---\nkind: note\n---\n\nopen\n");
    writeFileSync(
      join(vault, "notes", "closed.md"),
      "---\nkind: note\nvisibility: [private]\n---\n\nclosed\n",
    );

    // Three recall records: one naming the open page, one naming the
    // reserved page (both in its source refs and its top_artifacts), and
    // one naming nothing.
    emitRecallTelemetry(vault, {
      createdAt: "2026-05-20T18:00:00.000Z",
      host: "mcp-test",
      channel: RECALL_CHANNEL.mcp,
      mode: "search",
      status: "ok",
      durationMs: 2,
      resultCount: 1,
      topArtifacts: [{ id: "notes-open", path: "notes/open.md" }],
    });
    emitRecallTelemetry(vault, {
      createdAt: "2026-05-20T18:01:00.000Z",
      host: "mcp-test",
      channel: RECALL_CHANNEL.mcp,
      mode: "query",
      status: "ok",
      durationMs: 2,
      resultCount: 0,
      topArtifacts: [{ id: "notes-closed", path: "notes/closed.md" }],
    });
    emitRecallTelemetry(vault, {
      createdAt: "2026-05-20T18:02:00.000Z",
      host: "mcp-test",
      channel: RECALL_CHANNEL.hook,
      mode: "query",
      status: "ok",
      durationMs: 1,
      resultCount: 0,
    });
    // One gate record flagged private and one ordinary one. Gate records
    // carry no artifact refs, so only the private flag can withhold them.
    appendContinuityRecord(vault, {
      kind: "gate_telemetry",
      createdAt: "2026-05-20T18:03:00.000Z",
      sourceRefs: [],
      private: true,
      payload: { host: "mcp-test", decision: "skip", reason: "private" },
    });
    appendContinuityRecord(vault, {
      kind: "gate_telemetry",
      createdAt: "2026-05-20T18:04:00.000Z",
      sourceRefs: [],
      payload: { host: "mcp-test", decision: "retrieve", reason: "threshold" },
    });

    // Local reach keeps everything, exactly as before this boundary.
    const local = new MCPServer({ vault, configPath }, { reach: TRANSPORT_REACH.local });
    await initialize(local);
    expect((await callTelemetry(local, { operation: "summary" }))["total"]).toBe(3);
    expect((await callTelemetry(local, { operation: "gate_summary" }))["total"]).toBe(2);

    // Remote reach: the reserved page's record is dropped whole BEFORE
    // total and before the summary counts, and the private gate record
    // with it. No path of the reserved page appears anywhere.
    const remote = new MCPServer({ vault, configPath }, { reach: TRANSPORT_REACH.remote });
    await initialize(remote);
    const seen = await callTelemetry(remote, { operation: "list", mode: "search" });
    expect(seen["total"]).toBe(1);
    expect(JSON.stringify(seen)).not.toContain("notes/closed.md");

    const summary = await callTelemetry(remote, { operation: "summary" });
    expect(summary).toMatchObject({
      total: 2,
      by_mode: { search: 1, query: 1 },
      by_channel: { hook: 1, mcp: 1 },
      total_results: 1,
    });

    const gateList = await callTelemetry(remote, { operation: "gate_list" });
    expect(gateList["total"]).toBe(1);
    expect(JSON.stringify(gateList)).not.toContain('"reason":"private"');

    const gateSummary = await callTelemetry(remote, { operation: "gate_summary" });
    expect(gateSummary).toMatchObject({
      total: 1,
      retrieved: 1,
      skipped: 0,
      by_reason: { threshold: 1 },
    });
  });

  test("an id-only artifact of a withheld preference drops the record at remote reach", async () => {
    // The emitter had no path for the artifact, only its bare Brain id -
    // the shape `emitRecallTelemetry` records whenever the ranked search
    // never surfaced a path. The preference's page is reserved against
    // remote reads, so the record that names it only by id must drop
    // whole below local reach.
    writePreference(vault, {
      slug: "withheld",
      topic: "withheld",
      principle: "A rule nobody else may read",
      created_at: "2026-05-20T19:00:00.000Z",
      unconfirmed_until: "2026-05-21T00:00:00.000Z",
      status: BRAIN_PREFERENCE_STATUS.confirmed,
      evidenced_by: ["[[sig-2026-05-20-withheld]]"],
      confirmed_at: "2026-05-20T19:00:00.000Z",
    });
    const prefPath = join(vault, "Brain", "preferences", "pref-withheld.md");
    const page = readFileSync(prefPath, "utf8");
    const frontmatterEnd = page.indexOf("\n---", 1);
    atomicWriteFileSync(
      prefPath,
      `${page.slice(0, frontmatterEnd)}\nvisibility: [private]${page.slice(frontmatterEnd)}`,
    );

    emitRecallTelemetry(vault, {
      createdAt: "2026-05-20T19:01:00.000Z",
      host: "mcp-test",
      channel: RECALL_CHANNEL.mcp,
      mode: "search",
      status: "ok",
      durationMs: 1,
      resultCount: 1,
      topArtifacts: [{ id: "pref-withheld" }],
    });

    const local = new MCPServer({ vault, configPath }, { reach: TRANSPORT_REACH.local });
    await initialize(local);
    expect((await callTelemetry(local, { operation: "list" }))["total"]).toBe(1);

    const remote = new MCPServer({ vault, configPath }, { reach: TRANSPORT_REACH.remote });
    await initialize(remote);
    const seen = await callTelemetry(remote, { operation: "list" });
    expect(seen["total"]).toBe(0);
    expect(JSON.stringify(seen)).not.toContain("pref-withheld");

    const summary = await callTelemetry(remote, { operation: "summary" });
    expect(summary["total"]).toBe(0);
  });
});

/**
 * The ownership half of the same filter, under
 * `integrity.owner_scope_delivery: fail`: a record whose artifact refs
 * name another owner's page is withheld at LOCAL reach too - the private
 * partition stays a remote-only withholding, but the owner reference
 * filter is not reach-bound. With the gate off, a local caller still sees
 * everything.
 */
describe("brain_recall_telemetry under integrity.owner_scope_delivery: fail", () => {
  const OWNER_A = "agent-a";
  const CALLER = "agent-b";

  /** The caller's tool handler call, resolved under one enforced identity. */
  function callAs(args: Record<string, unknown>, agentName?: string) {
    const tool = buildToolTable("full").find((t) => t.name === "brain_recall_telemetry")!;
    return tool.handler(
      { vault, configPath, repoRoot: null, agentName, reach: TRANSPORT_REACH.local },
      args,
    );
  }

  function setGate(mode: "fail" | null): void {
    writeFileSync(
      brainConfigPath(vault),
      mode === null
        ? "schema_version: 1\n"
        : "schema_version: 1\nintegrity:\n  owner_scope_delivery: fail\n",
    );
  }

  function seedForeignPref(): void {
    writePreference(vault, {
      slug: "foreign-rule",
      topic: "foreign-rule",
      principle: "A rule owned by another scope.",
      created_at: "2026-05-01T00:00:00Z",
      unconfirmed_until: "2026-05-08T00:00:00Z",
      status: BRAIN_PREFERENCE_STATUS.confirmed,
      evidenced_by: [],
      confirmed_at: "2026-05-02T00:00:00Z",
      owner: OWNER_A,
    });
  }

  function emitForeignRecord(): void {
    emitRecallTelemetry(vault, {
      createdAt: "2026-05-20T16:00:00.000Z",
      host: "owner-scope-test",
      channel: RECALL_CHANNEL.mcp,
      mode: "context_pack",
      status: "ok",
      durationMs: 3,
      resultCount: 1,
      topArtifacts: [{ id: "pref-foreign-rule" }],
    });
  }

  test("a record naming another owner's artifact is withheld at local reach", async () => {
    seedForeignPref();
    emitForeignRecord();
    setGate("fail");

    const list = (await callAs({ operation: "list" }, CALLER)) as Record<string, unknown>;
    expect(list["total"]).toBe(0);
    expect(JSON.stringify(list)).not.toContain("pref-foreign-rule");

    const summary = (await callAs({ operation: "summary" }, CALLER)) as Record<string, unknown>;
    expect(summary["total"]).toBe(0);

    // Not over-filtering: the record travels whole to its own owner.
    const asOwner = (await callAs({ operation: "list" }, OWNER_A)) as Record<string, unknown>;
    expect(asOwner["total"]).toBe(1);
  });

  test("with the gate off, a local caller keeps every record", async () => {
    seedForeignPref();
    emitForeignRecord();
    setGate(null);

    const list = (await callAs({ operation: "list" }, CALLER)) as Record<string, unknown>;
    expect(list["total"]).toBe(1);
  });
});

/**
 * The limit is the caller's page over what it may SEE, not over what the
 * log holds: the visibility filter runs first, then the page is cut. A
 * limit inside the reader would let the newest withheld record consume
 * the page and hide an older visible one behind it.
 */
describe("brain_recall_telemetry limit applies after the visibility filter", () => {
  test("list limit 1 with the newest record withheld returns the older visible one", async () => {
    mkdirSync(join(vault, "notes"), { recursive: true });
    writeFileSync(join(vault, "notes", "open.md"), "---\nkind: note\n---\n\nopen\n");
    writeFileSync(
      join(vault, "notes", "closed.md"),
      "---\nkind: note\nvisibility: [private]\n---\n\nclosed\n",
    );
    // The OLDER record is visible, the NEWER one names a reserved page.
    emitRecallTelemetry(vault, {
      createdAt: "2026-05-20T18:00:00.000Z",
      host: "mcp-test",
      channel: RECALL_CHANNEL.mcp,
      mode: "search",
      status: "ok",
      durationMs: 2,
      resultCount: 1,
      topArtifacts: [{ id: "notes-open", path: "notes/open.md" }],
    });
    emitRecallTelemetry(vault, {
      createdAt: "2026-05-20T18:01:00.000Z",
      host: "mcp-test",
      channel: RECALL_CHANNEL.mcp,
      mode: "search",
      status: "ok",
      durationMs: 2,
      resultCount: 0,
      topArtifacts: [{ id: "notes-closed", path: "notes/closed.md" }],
    });

    const remote = new MCPServer({ vault, configPath }, { reach: TRANSPORT_REACH.remote });
    await initialize(remote);
    const page = await callTelemetry(remote, { operation: "list", limit: 1 });
    expect(page["total"]).toBe(1);
    expect(JSON.stringify(page)).toContain("notes/open.md");
    expect(JSON.stringify(page)).not.toContain("notes/closed.md");
  });

  test("gate_list limit 1 with the newest record private returns the older visible one", async () => {
    appendContinuityRecord(vault, {
      kind: "gate_telemetry",
      createdAt: "2026-05-20T18:00:00.000Z",
      sourceRefs: [],
      payload: { host: "mcp-test", decision: "retrieve", reason: "threshold" },
    });
    appendContinuityRecord(vault, {
      kind: "gate_telemetry",
      createdAt: "2026-05-20T18:01:00.000Z",
      sourceRefs: [],
      private: true,
      payload: { host: "mcp-test", decision: "skip", reason: "private" },
    });

    const remote = new MCPServer({ vault, configPath }, { reach: TRANSPORT_REACH.remote });
    await initialize(remote);
    const page = await callTelemetry(remote, { operation: "gate_list", limit: 1 });
    expect(page["total"]).toBe(1);
    expect(JSON.stringify(page)).toContain('"reason":"threshold"');
    expect(JSON.stringify(page)).not.toContain('"reason":"private"');
  });
});
