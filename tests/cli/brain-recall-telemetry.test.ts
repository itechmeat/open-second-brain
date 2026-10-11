import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { emitObservedUse } from "../../src/core/brain/observed-use.ts";
import { emitRecallTelemetry, RECALL_CHANNEL } from "../../src/core/brain/recall-telemetry.ts";
import { TRANSPORT_REACH, type TransportReach } from "../../src/core/graph/transport-reach.ts";
import { JSONRPC_VERSION, MCPServer, PROTOCOL_VERSION } from "../../src/mcp/index.ts";
import { INVALID_PARAMS } from "../../src/mcp/protocol.ts";
import { buildToolTable } from "../../src/mcp/tools.ts";
import { runCli } from "../helpers/run-cli.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-recall-telemetry-cli-"));
  mkdirSync(join(vault, "Brain"), { recursive: true });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

test("brain recall-telemetry lists records and summarizes gaps", async () => {
  emitRecallTelemetry(vault, {
    createdAt: "2026-05-20T16:00:00.000Z",
    host: "cli-test",
    channel: RECALL_CHANNEL.cli,
    mode: "context_pack",
    status: "ok",
    durationMs: 8,
    resultCount: 2,
    topArtifacts: [{ id: "pref-alpha" }],
  });
  emitRecallTelemetry(vault, {
    createdAt: "2026-05-20T16:01:00.000Z",
    host: "cli-test",
    channel: RECALL_CHANNEL.cli,
    mode: "search",
    status: "empty",
    durationMs: 12,
    resultCount: 0,
    gaps: ["no_matching_context"],
  });

  const list = await runCli([
    "brain",
    "recall-telemetry",
    "list",
    "--vault",
    vault,
    "--mode",
    "context_pack",
    "--json",
  ]);
  expect(list.returncode).toBe(0);
  const listJson = JSON.parse(list.stdout);
  expect(listJson.total).toBe(1);
  expect(listJson.records[0].payload).toMatchObject({
    mode: "context_pack",
    result_count: 2,
  });

  const summary = await runCli([
    "brain",
    "recall-telemetry",
    "summary",
    "--vault",
    vault,
    "--host",
    "cli-test",
    "--json",
  ]);
  expect(summary.returncode).toBe(0);
  const summaryJson = JSON.parse(summary.stdout);
  expect(summaryJson).toMatchObject({
    total: 2,
    by_mode: { context_pack: 1, search: 1 },
    by_status: { ok: 1, empty: 1 },
    total_results: 2,
    empty_runs: 1,
    gap_counts: { no_matching_context: 1 },
  });
});

test("brain recall-telemetry filters by channel and rejects one that does not exist", async () => {
  emitRecallTelemetry(vault, {
    createdAt: "2026-05-20T16:02:00.000Z",
    host: "cli-test",
    channel: RECALL_CHANNEL.hook,
    mode: "search",
    status: "empty",
    durationMs: 3,
    resultCount: 0,
  });
  emitRecallTelemetry(vault, {
    createdAt: "2026-05-20T16:03:00.000Z",
    host: "cli-test",
    channel: RECALL_CHANNEL.mcp,
    mode: "query",
    status: "ok",
    durationMs: 3,
    resultCount: 1,
  });

  const list = await runCli([
    "brain",
    "recall-telemetry",
    "list",
    "--vault",
    vault,
    "--channel",
    "hook",
    "--json",
  ]);
  expect(list.returncode).toBe(0);
  expect(JSON.parse(list.stdout).total).toBe(1);

  const summary = await runCli([
    "brain",
    "recall-telemetry",
    "summary",
    "--vault",
    vault,
    "--json",
  ]);
  expect(JSON.parse(summary.stdout).by_channel).toEqual({ hook: 1, mcp: 1 });

  const rejected = await runCli([
    "brain",
    "recall-telemetry",
    "list",
    "--vault",
    vault,
    "--channel",
    "hermes",
  ]);
  expect(rejected.returncode).not.toBe(0);
  // The message renders the closed set rather than restating it in prose.
  expect(rejected.stderr).toContain("mcp, cli, hook");
});

test("brain recall-telemetry accepts every recorded mode, `query` included", async () => {
  emitRecallTelemetry(vault, {
    createdAt: "2026-05-20T16:04:00.000Z",
    host: "cli-test",
    channel: RECALL_CHANNEL.mcp,
    mode: "query",
    status: "ok",
    durationMs: 2,
    resultCount: 1,
  });

  const list = await runCli([
    "brain",
    "recall-telemetry",
    "list",
    "--vault",
    vault,
    "--mode",
    "query",
    "--json",
  ]);
  expect(list.returncode).toBe(0);
  expect(JSON.parse(list.stdout).total).toBe(1);
});

// ----- dead_weight (recall-quality, t_1ee67e5b / task D4) --------------------

/** Two pages, one recorded as surfaced once, one observed-used once. */
function seedDeadWeightVault(): void {
  writeFileSync(join(vault, "a.md"), "# A\n\nalpha beta gamma.\n");
  writeFileSync(join(vault, "b.md"), "# B\n\nalpha beta delta.\n");
  writeFileSync(join(vault, "c.md"), "# C\n\nalpha epsilon zeta.\n");
  emitRecallTelemetry(vault, {
    createdAt: "2026-05-20T16:00:00.000Z",
    host: "dw-test",
    channel: RECALL_CHANNEL.cli,
    mode: "search",
    status: "ok",
    durationMs: 5,
    resultCount: 1,
    topArtifacts: [{ id: "doc-a:0", path: "a.md" }],
  });
  emitObservedUse(vault, {
    createdAt: "2026-05-21T09:00:00.000Z",
    host: "dw-test",
    entries: [{ id: "doc-b:0", path: "b.md", verdict: "USED" }],
  });
}

async function callTelemetryTool(
  server: MCPServer,
  args: Record<string, unknown>,
): Promise<{ result?: unknown; error?: { code: number; message: string } }> {
  const response = (await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 9,
    method: "tools/call",
    params: { name: "brain_recall_telemetry", arguments: args },
  })) as { result?: unknown; error?: { code: number; message: string } };
  return response;
}

async function callTelemetryResult(
  server: MCPServer,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = (await callTelemetryTool(server, args)) as {
    result?: { content: ReadonlyArray<{ type: string; text: string }> };
  };
  return JSON.parse(response.result!.content[0]!.text) as Record<string, unknown>;
}

async function initializedServer(reach: TransportReach | undefined): Promise<MCPServer> {
  const configPath = join(vault, "config.yaml");
  writeFileSync(configPath, `vault: ${vault}\n`);
  // `reach` is a runtime option (the transport's own fact), not a plain
  // server option - it rides the second constructor argument.
  const server = new MCPServer({ vault, configPath }, reach !== undefined ? { reach } : {});
  await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "dead-weight-test", version: "0" },
    },
  });
  await server.handleRequest({ jsonrpc: JSONRPC_VERSION, method: "notifications/initialized" });
  return server;
}

describe("brain recall-telemetry dead-weight CLI", () => {
  test("reports the complement envelope and honors --since/--until", async () => {
    seedDeadWeightVault();
    const res = await runCli([
      "brain",
      "recall-telemetry",
      "dead-weight",
      "--vault",
      vault,
      "--json",
    ]);
    expect(res.returncode).toBe(0);
    const report = JSON.parse(res.stdout);
    expect(report).toMatchObject({
      pages_total: 3,
      pages_retrieved: 2,
      dead_count: 1,
      dead: [{ path: "c.md" }],
      window: { since: "2026-05-20T16:00:00.000Z", until: "2026-05-21T09:00:00.000Z" },
    });
    expect(String(report["gate_caveat"]).length).toBeGreaterThan(0);

    const bounded = await runCli([
      "brain",
      "recall-telemetry",
      "dead-weight",
      "--vault",
      vault,
      "--since",
      "2026-05-21T00:00:00.000Z",
      "--json",
    ]);
    expect(JSON.parse(bounded.stdout)).toMatchObject({
      pages_total: 3,
      pages_retrieved: 1,
      window: { since: "2026-05-21T09:00:00.000Z" },
    });

    const text = await runCli(["brain", "recall-telemetry", "dead-weight", "--vault", vault]);
    expect(text.returncode).toBe(0);
    expect(text.stdout).toContain("pages: 3 total");
    expect(text.stdout).toContain("c.md");
  });

  test("dead-weight rejects record-only filters like cost does", async () => {
    for (const flag of ["--mode", "--status", "--channel", "--host"]) {
      const res = await runCli([
        "brain",
        "recall-telemetry",
        "dead-weight",
        "--vault",
        vault,
        flag,
        "search",
      ]);
      expect(res.returncode).not.toBe(0);
      expect(res.stderr).toContain(flag);
    }
  });
});

describe("brain_recall_telemetry dead_weight op", () => {
  test("the operation union grows to seven, in the schema enum and the refusal", async () => {
    const tool = buildToolTable("full").find((t) => t.name === "brain_recall_telemetry");
    expect(tool).toBeDefined();
    const opEnum = (
      (tool!.inputSchema as { properties: { operation: { enum: string[] } } }).properties
        .operation as { enum: string[] }
    ).enum;
    expect(opEnum).toEqual([
      "list",
      "summary",
      "gate_list",
      "gate_summary",
      "observed_reuse",
      "cost",
      "dead_weight",
    ]);

    const server = await initializedServer(TRANSPORT_REACH.local);
    const response = await callTelemetryTool(server, { operation: "nope" });
    expect(response.error?.code).toBe(INVALID_PARAMS);
    expect(response.error?.message).toContain("dead_weight");
  });

  test("follows the observed_reuse envelope with since/until honored at local reach", async () => {
    seedDeadWeightVault();
    const server = await initializedServer(TRANSPORT_REACH.local);
    const report = await callTelemetryResult(server, { operation: "dead_weight" });
    // The vault_path field renders the opaque vault id, not the raw path.
    expect(String(report["vault_path"])).toStartWith("vault://");
    expect(report).toMatchObject({
      pages_total: 3,
      pages_retrieved: 2,
      dead_count: 1,
      dead: [{ path: "c.md" }],
      window: { since: "2026-05-20T16:00:00.000Z", until: "2026-05-21T09:00:00.000Z" },
    });
    expect(String(report["gate_caveat"]).length).toBeGreaterThan(0);

    const bounded = await callTelemetryResult(server, {
      operation: "dead_weight",
      since: "2026-05-21T00:00:00.000Z",
      until: "2026-05-22T00:00:00.000Z",
    });
    expect(bounded).toMatchObject({
      pages_total: 3,
      pages_retrieved: 1,
      window: { since: "2026-05-21T09:00:00.000Z", until: "2026-05-21T09:00:00.000Z" },
    });
  });

  test("record-only filters are refused, mirroring the cost op", async () => {
    const server = await initializedServer(TRANSPORT_REACH.local);
    const response = await callTelemetryTool(server, {
      operation: "dead_weight",
      mode: "search",
    });
    expect(response.error?.code).toBe(INVALID_PARAMS);
    expect(response.error?.message).toContain("mode");
  });

  test("record-only filters other than limit are refused on dead_weight too", async () => {
    const server = await initializedServer(TRANSPORT_REACH.local);
    for (const name of ["status", "channel", "host"] as const) {
      const response = await callTelemetryTool(server, { operation: "dead_weight", [name]: "x" });
      expect(response.error?.code).toBe(INVALID_PARAMS);
      expect(response.error?.message).toContain(name);
    }
  });

  test("remote reach drops hidden pages BEFORE total", async () => {
    writeFileSync(
      join(vault, "secret.md"),
      "---\nvisibility: private\n---\n\n# Secret\n\nhidden from remote callers.\n",
    );
    writeFileSync(join(vault, "open.md"), "# Open\n\nvisible everywhere.\n");
    emitRecallTelemetry(vault, {
      createdAt: "2026-05-20T16:00:00.000Z",
      host: "dw-test",
      channel: RECALL_CHANNEL.cli,
      mode: "search",
      status: "ok",
      durationMs: 5,
      resultCount: 1,
      topArtifacts: [{ id: "doc-open:0", path: "open.md" }],
    });

    const local = await callTelemetryResult(await initializedServer(TRANSPORT_REACH.local), {
      operation: "dead_weight",
    });
    expect(local).toMatchObject({
      pages_total: 2,
      pages_retrieved: 1,
      dead_count: 1,
      dead: [{ path: "secret.md" }],
    });

    // No transport reach minted resolves to the narrowest: the private
    // page is dropped before any count, so nothing - total, dead list,
    // or their sizes - discloses that it exists.
    const remote = await callTelemetryResult(await initializedServer(undefined), {
      operation: "dead_weight",
    });
    expect(remote).toMatchObject({
      pages_total: 1,
      pages_retrieved: 1,
      dead_count: 0,
      dead: [],
    });
  });
});

/**
 * The bounded `limit` on the dead preview (PR #248 review L10). The dead
 * list used to be pinned at 50 with no way to page, so the full list could
 * never be seen; both surfaces now take a limit that maps onto the fold's
 * `deadLimit`, bounded by the same maximum. 505 dead pages make every
 * claim observable: the default preview holds 50, a larger limit returns
 * more, and a limit above the maximum clamps to it.
 */
describe("dead-weight limit bounds the preview, both surfaces", () => {
  const DEAD_PAGES = 505;

  function seedWideDeadVault(): void {
    writeFileSync(join(vault, "a.md"), "# A\n\nalpha beta gamma.\n");
    emitRecallTelemetry(vault, {
      createdAt: "2026-05-20T16:00:00.000Z",
      host: "dw-limit-test",
      channel: RECALL_CHANNEL.cli,
      mode: "search",
      status: "ok",
      durationMs: 5,
      resultCount: 1,
      topArtifacts: [{ id: "doc-a:0", path: "a.md" }],
    });
    for (let i = 0; i < DEAD_PAGES; i++) {
      writeFileSync(
        join(vault, `dw-${String(i).padStart(3, "0")}.md`),
        `# DW ${i}\n\nquiet page body.\n`,
      );
    }
  }

  test("the CLI default holds 50, a larger limit returns more, over the max clamps", async () => {
    seedWideDeadVault();
    const args = ["brain", "recall-telemetry", "dead-weight", "--vault", vault, "--json"];
    const def = JSON.parse((await runCli(args)).stdout) as {
      dead_count: number;
      dead: ReadonlyArray<unknown>;
    };
    expect(def.dead_count).toBe(DEAD_PAGES);
    expect(def.dead).toHaveLength(50);

    const wider = JSON.parse((await runCli([...args, "--limit", "300"])).stdout) as {
      dead: ReadonlyArray<unknown>;
    };
    expect(wider.dead).toHaveLength(300);

    const clamped = JSON.parse((await runCli([...args, "--limit", "5000"])).stdout) as {
      dead: ReadonlyArray<unknown>;
    };
    expect(clamped.dead).toHaveLength(500);
  }, 30000);

  test("the dead_weight op maps limit onto the same fold", async () => {
    seedWideDeadVault();
    const server = await initializedServer(TRANSPORT_REACH.local);
    // The op accepts limit where it used to refuse it, and the value bites:
    // two rows of the 505-dead fold instead of the preview's full head. The
    // >default and clamp scales are pinned on the CLI above - past ~45 rows
    // the MCP preview budget truncates the payload, so a 300-row response
    // is not readable through this surface.
    const page = await callTelemetryResult(server, { operation: "dead_weight", limit: 2 });
    expect(page["dead"]).toHaveLength(2);
  }, 30000);
});
