/**
 * grok install-artifact helpers: grok attributes its Brain writes to its OWN
 * id ("grok") in both the MCP env and the hooks file - it never inherits the
 * shared operator name.
 */

import { describe, expect, test } from "bun:test";

import { grokHooksJson, grokMcpServers } from "../../../src/core/install/grok-asset.ts";
import type { McpPayload } from "../../../src/core/install/types.ts";

const PAYLOAD: McpPayload = {
  full: {
    command: "o2b",
    args: ["mcp", "--vault", "/v"],
    env: { VAULT_AGENT_NAME: "claude-dev-agent", VAULT_TIMEZONE: "UTC" },
  },
  writer: {
    command: "o2b",
    args: ["mcp", "--writer-only", "--vault", "/v"],
    env: { VAULT_AGENT_NAME: "claude-dev-agent", VAULT_TIMEZONE: "UTC" },
  },
};

describe("grokMcpServers", () => {
  test("uses an absolute bun command and grok's own identity, keeping other env", () => {
    const servers = grokMcpServers(PAYLOAD);
    const full = servers["open-second-brain"]!;
    expect(full.command).toBe(process.execPath);
    expect(full.args).toEqual([
      "run",
      expect.stringContaining("src/cli/main.ts"),
      "mcp",
      "--vault",
      "/v",
    ]);
    // grok writes under its own name, not the inherited operator name.
    expect(full.env).toEqual({ VAULT_AGENT_NAME: "grok", VAULT_TIMEZONE: "UTC" });
    expect(servers["open-second-brain-writer"]!.env?.["VAULT_AGENT_NAME"]).toBe("grok");
  });
});

describe("grokHooksJson", () => {
  test("stamps grok's own id on every hook command's env", () => {
    const parsed = JSON.parse(grokHooksJson());
    const commands = Object.values(
      parsed.hooks as Record<string, Array<{ hooks: Array<{ env: Record<string, string> }> }>>,
    )
      .flat()
      .flatMap((g) => g.hooks);
    expect(commands.length).toBeGreaterThan(0);
    for (const h of commands) {
      expect(h.env["VAULT_AGENT_NAME"]).toBe("grok");
    }
  });
});
