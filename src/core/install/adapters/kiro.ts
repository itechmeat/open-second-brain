/**
 * kiro adapter — JSON-merge into `~/.kiro/settings.json` under the
 * `mcpServers` key.
 *
 * The exact config-file location is pinned to upstream `kiro.dev` docs
 * at impl time; the resolver below can be widened (per-OS / project-
 * scope) without changing callers.
 */

import { join } from "node:path";

import { createJsonMcpAdapter } from "./_json-mcp.ts";
import { defaultRegistry } from "../registry.ts";
import type { InstallEnv } from "../types.ts";

function configPath(env: InstallEnv): string {
  return join(env.home, ".kiro", "settings.json");
}

export const kiroAdapter = createJsonMcpAdapter({
  target: "kiro",
  label: "kiro",
  resolveConfigPath: configPath,
  postNotes: ["Restart kiro to load the new MCP servers."],
});

defaultRegistry.register(kiroAdapter);
