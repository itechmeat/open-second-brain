/**
 * Shared setup of the record-project tests: a switched machine that holds
 * the view writer role, an MCP server launched in a given directory at a
 * given reach, and a tool call that fails the test on any error, a
 * JSON-RPC error included.
 */
import { expect } from "bun:test";

import { MCPServer } from "../../../../src/mcp/server.ts";
import { JSONRPC_VERSION } from "../../../../src/mcp/protocol.ts";
import {
  TRANSPORT_REACH,
  type TransportReach,
} from "../../../../src/core/graph/transport-reach.ts";
import { runMigration } from "../../../../src/core/store-migration/migrate.ts";
import { catchUpSettings } from "../../../../src/core/view/catch-up.ts";
import { claimSettled, claimViewWriter } from "../../../../src/core/view/writer.ts";
import { foldViewWriter } from "../../../../src/core/view/writer-fold.ts";
import { makeFleet, type Fleet, type Machine } from "../../store-migration/fixtures/fleet.ts";

/** A one-machine fleet, switched, holding the view writer role. */
export function switchedMachine(): { fleet: Fleet; machine: Machine } {
  const fleet = makeFleet(["dev-a"]);
  const machine = fleet.machine("dev-a");
  machine.use();
  expect(runMigration(machine.vault, { settleMs: 0 }).ok).toBe(true);
  const store = machine.store();
  claimViewWriter(store, { agent: "t" });
  claimSettled(store, foldViewWriter(catchUpSettings(store)!));
  return { fleet, machine };
}

/** An MCP server for `machine`'s vault, launched in `workspaceDir`. */
export function serverIn(
  machine: Machine,
  workspaceDir: string,
  reach: TransportReach = TRANSPORT_REACH.local,
): MCPServer {
  return new MCPServer(
    { vault: machine.vault, configPath: process.env["OPEN_SECOND_BRAIN_CONFIG"]! },
    { reach, workspaceDir },
  );
}

/** Call a tool; a JSON-RPC error, a missing result or a tool error fails the test. */
export async function callTool(
  server: MCPServer,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const r = (await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  })) as { error?: unknown; result?: { isError?: boolean; content?: unknown } };
  expect(r.error, JSON.stringify(r)).toBeUndefined();
  expect(r.result, JSON.stringify(r)).toBeDefined();
  expect(r.result?.isError, JSON.stringify(r)).not.toBe(true);
  return r.result;
}

/** The `project` each written signal and log event of `machine` carries, by its text. */
export function stampedProjects(machine: Machine): Array<{ text: string; project: unknown }> {
  return machine
    .records()
    .filter((r) => r.kind === "log-event" || r.kind === "signal")
    .map((r) => {
      const body = r.body as Record<string, unknown>;
      const fields = (r.kind === "signal" ? body["frontmatter"] : body["body"]) as Record<
        string,
        unknown
      >;
      return {
        text: String(fields["text"] ?? fields["principle"] ?? ""),
        project: fields["project"],
      };
    });
}
