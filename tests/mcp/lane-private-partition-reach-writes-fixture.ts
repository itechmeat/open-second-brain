/**
 * Shared helpers of `lane-private-partition-reach-writes.test.ts`: the
 * servers at each reach and the serialized answer of a tool call.
 */

import { TRANSPORT_REACH, type TransportReach } from "../../src/core/graph/transport-reach.ts";
import { MCPServer } from "../../src/mcp/server.ts";
import type { LaneEnv } from "../core/lanes/fixtures/lane-env.ts";

export const REGION = "<private>synthetic region body</private>";
export const AGENT = "tester";

/**
 * A server for `e`: below local reach when `reach` is absent (no reach
 * minted, a remote caller), at `reach` otherwise. A machine with no vault
 * is configured with none.
 */
export function server(e: LaneEnv, reach?: TransportReach): MCPServer {
  const config = { vault: e.mode === "no-vault" ? null : e.vault, configPath: e.env.configPath };
  return reach === undefined ? new MCPServer(config) : new MCPServer(config, { reach });
}

/** A server at the local reach. */
export function localServer(e: LaneEnv): MCPServer {
  return server(e, TRANSPORT_REACH.local);
}

/** The whole answer serialized, or the refusal message as `{"error": ...}`. */
export async function call(
  s: MCPServer,
  tool: string,
  args: Record<string, unknown>,
): Promise<string> {
  try {
    return JSON.stringify(await s.callTool(tool, args));
  } catch (err) {
    return JSON.stringify({ error: (err as Error).message });
  }
}

/** The structured answer of a call, parsed (the refusal as `{ error }`). */
export async function callJson(
  s: MCPServer,
  tool: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const parsed = JSON.parse(await call(s, tool, args)) as Record<string, unknown>;
  return (parsed["structuredContent"] ?? parsed) as Record<string, unknown>;
}

/** Which of `marks` an answer carries. */
export function carried(answer: string, marks: Readonly<Record<string, string>>): string[] {
  return Object.entries(marks)
    .filter(([, mark]) => answer.includes(mark))
    .map(([field]) => field);
}
