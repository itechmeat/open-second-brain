/**
 * grok install-artifact helpers: grok attributes its Brain writes to its OWN
 * host-qualified id (vendor `grok` + the operator host, e.g. `grok-dev-agent`)
 * in both the MCP env and the hooks file - it never inherits the operator's
 * vendor token, and both artifacts agree on one derived name.
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
    // grok keeps the operator host ("dev") but swaps the vendor to its own.
    expect(full.env).toEqual({ VAULT_AGENT_NAME: "grok-dev-agent", VAULT_TIMEZONE: "UTC" });
    expect(servers["open-second-brain-writer"]!.env?.["VAULT_AGENT_NAME"]).toBe("grok-dev-agent");
  });

  test("falls back to the bare vendor id when no operator name is configured", () => {
    const servers = grokMcpServers({
      full: { command: "o2b", args: ["mcp", "--vault", "/v"] },
      writer: { command: "o2b", args: ["mcp", "--writer-only", "--vault", "/v"] },
    });
    expect(servers["open-second-brain"]!.env).toEqual({ VAULT_AGENT_NAME: "grok" });
  });
});

describe("grokHooksJson", () => {
  test("stamps grok's host-qualified id on every hook command's env", () => {
    const parsed = JSON.parse(grokHooksJson(PAYLOAD));
    const commands = Object.values(
      parsed.hooks as Record<string, Array<{ hooks: Array<{ env: Record<string, string> }> }>>,
    )
      .flat()
      .flatMap((g) => g.hooks);
    expect(commands.length).toBeGreaterThan(0);
    for (const h of commands) {
      expect(h.env["VAULT_AGENT_NAME"]).toBe("grok-dev-agent");
    }
  });
});
