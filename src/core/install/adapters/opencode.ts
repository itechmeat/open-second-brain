/**
 * opencode adapter — JSON-merge into `~/.config/opencode/mcp.json`.
 *
 * Upstream is `anomalyco/opencode` (formerly hosted under
 * `sst/opencode`). The MCP config file lives under
 * `${XDG_CONFIG_HOME:-$HOME/.config}/opencode/mcp.json` and uses the
 * standard `mcpServers` key. Re-verify against upstream docs if a
 * new opencode release ships before the next OSB release.
 */

import { join } from "node:path";

import { createJsonMcpAdapter } from "./_json-mcp.ts";
import { defaultRegistry } from "../registry.ts";
import type { InstallEnv } from "../types.ts";

function configPath(env: InstallEnv): string {
  const xdg = env.env["XDG_CONFIG_HOME"];
  const base = xdg && xdg.length > 0 ? xdg : join(env.home, ".config");
  return join(base, "opencode", "mcp.json");
}

export const opencodeAdapter = createJsonMcpAdapter({
  target: "opencode",
  label: "opencode",
  resolveConfigPath: configPath,
  postNotes: ["Restart opencode to load the new MCP servers."],
});

defaultRegistry.register(opencodeAdapter);
