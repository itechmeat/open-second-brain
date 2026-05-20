/**
 * Gemini CLI adapter — JSON-merge into `~/.gemini/settings.json` under
 * the `mcpServers` key, per `google-gemini/gemini-cli` MCP docs.
 */

import { join } from "node:path";

import { createJsonMcpAdapter } from "./_json-mcp.ts";
import { defaultRegistry } from "../registry.ts";
import type { InstallEnv } from "../types.ts";

function configPath(env: InstallEnv): string {
  return join(env.home, ".gemini", "settings.json");
}

export const geminiCliAdapter = createJsonMcpAdapter({
  target: "gemini-cli",
  label: "Google Gemini CLI",
  resolveConfigPath: configPath,
  postNotes: [
    "Start `gemini` to load the registered MCP servers.",
  ],
});

defaultRegistry.register(geminiCliAdapter);
