import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

// Resolve relative to this test file so the suite runs from any checkout
// path (CI, contributor clones, worktrees).
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const PLUGIN_JSON_PATH = resolve(REPO_ROOT, ".claude-plugin", "plugin.json");

interface ServerEntry {
  command: string;
  args: string[];
  alwaysLoad?: boolean;
}

describe("Claude Code plugin MCP servers", () => {
  const manifest = JSON.parse(readFileSync(PLUGIN_JSON_PATH, "utf8")) as {
    mcpServers: Record<string, ServerEntry>;
  };
  const servers = manifest.mcpServers;

  test("are declared inline in plugin.json", () => {
    expect(Object.keys(servers).toSorted()).toEqual([
      "open-second-brain",
      "open-second-brain-writer",
    ]);
  });

  // Both registrations name the harness that launches them, so the
  // server can match `Brain/standing-rules/harness/claude-code.md`
  // without trusting anything a caller says about itself.
  test("full server runs o2b mcp from the plugin root without alwaysLoad", () => {
    const f = servers["open-second-brain"]!;
    expect(f).toEqual({
      command: "${CLAUDE_PLUGIN_ROOT}/scripts/o2b",
      args: ["mcp", "--harness", "claude-code"],
    });
    expect(f.alwaysLoad).toBeUndefined();
  });

  test("writer server passes --scope writer, the harness and alwaysLoad: true", () => {
    expect(servers["open-second-brain-writer"]).toEqual({
      command: "${CLAUDE_PLUGIN_ROOT}/scripts/o2b",
      args: ["mcp", "--scope", "writer", "--harness", "claude-code"],
      alwaysLoad: true,
    });
  });

  // Claude Code also reads a `.mcp.json` in the working directory as a
  // project-scoped config. At the repository root `CLAUDE_PLUGIN_ROOT` is
  // unset there, so a root manifest spawns `/scripts/o2b` and fails.
  test("no .mcp.json at the repository root", () => {
    expect(existsSync(resolve(REPO_ROOT, ".mcp.json"))).toBe(false);
  });
});
