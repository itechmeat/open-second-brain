/**
 * MCP landscape discovery across configured servers.
 *
 * Extracted from the former brain-tools.ts monolith; registration
 * happens through the aggregator, which preserves the public
 * BRAIN_TOOLS surface.
 */

import { buildMcpLandscape } from "../../core/graph/mcp-config.ts";
import type { ServerContext, ToolDefinition } from "../tools.ts";

async function toolMcpLandscape(ctx: ServerContext): Promise<Record<string, unknown>> {
  const landscape = buildMcpLandscape(ctx.vault);
  return {
    vault_path: ctx.vault,
    servers: landscape.servers.map((s) => ({
      name: s.name,
      source: s.source,
      packages: s.packages,
      env: s.env,
    })),
  };
}

// ----- Consolidated view tools (token-diet, t_3920db77) ---------------------

export const LANDSCAPE_TOOLS: ReadonlyArray<ToolDefinition> = Object.freeze([
  {
    name: "brain_mcp_landscape",
    description:
      "List the Model Context Protocol servers configured across the vault: each server's name, the config file that declares it, the packages it pulls, and the env-var NAMES it requires. Environment values are never read. Discovery is vault-relative. Read-only.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      required: ["vault_path", "servers"],
      properties: {
        vault_path: { type: "string" },
        servers: {
          type: "array",
          items: {
            type: "object",
            required: ["name", "source", "packages", "env"],
            properties: {
              name: { type: "string" },
              source: { type: "string" },
              packages: { type: "array", items: { type: "string" } },
              env: { type: "array", items: { type: "string" } },
            },
          },
        },
      },
    },
    handler: toolMcpLandscape,
  },
]);
