/**
 * Cursor adapter — JSON-merge into `~/.cursor/mcp.json`.
 *
 * Default scope: user-global. Project-scope (`<cwd>/.cursor/mcp.json`)
 * is deferred per the v0.10.11 design doc §12.
 *
 * Cursor needs an app-restart to pick up MCP server changes. The
 * `verify` step reports the disk state cleanly; restart is a
 * note rather than a failure.
 */

import { join } from "node:path";

import { createJsonMcpAdapter } from "./_json-mcp.ts";
import { defaultRegistry } from "../registry.ts";
import type { InstallEnv } from "../types.ts";

function configPath(env: InstallEnv): string {
  return join(env.home, ".cursor", "mcp.json");
}

export const cursorAdapter = createJsonMcpAdapter({
  target: "cursor",
  label: "Cursor",
  resolveConfigPath: configPath,
  postNotes: ["Restart the Cursor app to load the new MCP servers."],
  notes: ["scope: user-global (~/.cursor/mcp.json)"],
});

defaultRegistry.register(cursorAdapter);
