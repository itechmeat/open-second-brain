/**
 * brain_codegraph_report MCP tool (t_a1e76788).
 *
 * Read-only partner report. Registered in the full (read) tool table, never
 * the writer table, and returns a schema-versioned envelope without mutating
 * the project or vault. codegraph presence and the resolved code project are
 * environment-dependent, so assertions target the stable report envelope.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

import { JSONRPC_VERSION, MCPServer, PROTOCOL_VERSION } from "../../src/mcp/index.ts";
import { buildToolTable } from "../../src/mcp/tools.ts";
import { TRANSPORT_REACH } from "../../src/core/graph/transport-reach.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-codegraph-report-tool-"));
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

async function initialize(server: MCPServer): Promise<void> {
  await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "codegraph-report-test", version: "0" },
    },
  });
  await server.handleRequest({ jsonrpc: JSONRPC_VERSION, method: "notifications/initialized" });
}

async function call(): Promise<{ result?: unknown; error?: unknown }> {
  const server = new MCPServer({ vault, configPath: null });
  await initialize(server);
  return (await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 9,
    method: "tools/call",
    params: { name: "brain_codegraph_report", arguments: {} },
  })) as { result?: unknown; error?: unknown };
}

function payload(response: { result?: unknown }): Record<string, unknown> {
  const result = response.result as { content: ReadonlyArray<{ type: string; text: string }> };
  return JSON.parse(result.content[0]!.text);
}

describe("brain_codegraph_report tool", () => {
  test("registered in the full table only", () => {
    expect(buildToolTable("full").find((t) => t.name === "brain_codegraph_report")).toBeDefined();
    expect(
      buildToolTable("writer").find((t) => t.name === "brain_codegraph_report"),
    ).toBeUndefined();
  });

  // Budget, not a guess. `buildCodegraphReport` spawns the `codegraph`
  // binary once per discovered code project under a per-spawn deadline of
  // `CODEGRAPH_PARTNER_TIMEOUT_MS` (10s) - twice bun's 5s default for a
  // test. Measured at 4.21s on an idle machine WITH the binary installed,
  // i.e. 84% of that default, and it crossed it at 5306ms during a loaded
  // full-suite run. A test whose subject may legitimately outlive the
  // harness's default needs the deadline stated rather than the flake
  // rediscovered; the ceiling here sits above the spawn deadline, so a
  // real hang still fails rather than hanging the suite.
  const CODEGRAPH_SPAWN_BUDGET_MS = 20_000;

  test(
    "returns a schema-versioned read-only report envelope",
    async () => {
      const response = await call();
      expect(response.error).toBeUndefined();
      const report = payload(response as { result?: unknown });
      expect(report["schema_version"]).toBe(1);
      expect(report).toHaveProperty("cli");
      expect(report).toHaveProperty("index");
      expect(report).toHaveProperty("cargo_workspace");
      expect(report).toHaveProperty("cargo_workspace_reason");
    },
    CODEGRAPH_SPAWN_BUDGET_MS,
  );

  // A folder outside every root the egress pass knows (vault, store,
  // device state, home, temp, config, view): on Linux `/dev/shm` is one.
  const OUTSIDE_ROOTS = "/dev/shm";
  test.skipIf(process.platform !== "linux" || !existsSync(OUTSIDE_ROOTS))(
    "at remote reach the CLI path outside every known root is not a host path",
    async () => {
      const bin = mkdtempSync(join(OUTSIDE_ROOTS, "o2b-codegraph-bin-"));
      const savedPath = process.env["PATH"];
      try {
        const cli = join(bin, "codegraph");
        writeFileSync(cli, "#!/bin/sh\nexit 1\n");
        chmodSync(cli, 0o755);
        process.env["PATH"] = `${bin}${delimiter}${savedPath ?? ""}`;
        const server = new MCPServer(
          { vault, configPath: null },
          { reach: TRANSPORT_REACH.remote },
        );
        const result = (await server.callTool("brain_codegraph_report", {})) as {
          content: ReadonlyArray<{ text: string }>;
        };
        const text = result.content[0]!.text;
        const report = JSON.parse(text) as { cli: { available: boolean; path: string | null } };
        expect(report.cli.available).toBe(true);
        expect(report.cli.path).not.toBeNull();
        expect(isAbsolute(report.cli.path!)).toBe(false);
        expect(text).not.toContain(bin);
      } finally {
        if (savedPath === undefined) delete process.env["PATH"];
        else process.env["PATH"] = savedPath;
        rmSync(bin, { recursive: true, force: true });
      }
    },
    CODEGRAPH_SPAWN_BUDGET_MS,
  );
});
