/**
 * grok install-artifact helpers: the grok-specific Brain identity and how it
 * threads into the MCP env and the hooks file, so grok's writes attribute to
 * grok rather than the shared (Claude) identity.
 */

import { describe, expect, test } from "bun:test";

import {
  grokAgentName,
  grokHooksJson,
  grokMcpServers,
} from "../../../src/core/install/grok-asset.ts";
import type { McpPayload } from "../../../src/core/install/types.ts";

describe("grokAgentName", () => {
  test("swaps the vendor token of a <vendor>-<host>-agent name", () => {
    expect(grokAgentName("claude-dev-agent")).toBe("grok-dev-agent");
    expect(grokAgentName("claude-vps-agent")).toBe("grok-vps-agent");
  });
  test("prefixes a single-token name", () => {
    expect(grokAgentName("agent")).toBe("grok-agent");
  });
  test("defaults a missing name to grok-agent", () => {
    expect(grokAgentName(undefined)).toBe("grok-agent");
    expect(grokAgentName("")).toBe("grok-agent");
  });
});

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
  test("uses an absolute bun command and forces the grok identity, keeping other env", () => {
    const servers = grokMcpServers(PAYLOAD, "grok-dev-agent");
    const full = servers["open-second-brain"]!;
    expect(full.command).toBe(process.execPath);
    expect(full.args).toEqual([
      "run",
      expect.stringContaining("src/cli/main.ts"),
      "mcp",
      "--vault",
      "/v",
    ]);
    expect(full.env).toEqual({ VAULT_AGENT_NAME: "grok-dev-agent", VAULT_TIMEZONE: "UTC" });
    expect(servers["open-second-brain-writer"]!.env?.["VAULT_AGENT_NAME"]).toBe("grok-dev-agent");
  });
});

describe("grokHooksJson", () => {
  test("stamps the grok identity on every hook command's env", () => {
    const parsed = JSON.parse(grokHooksJson("grok-dev-agent"));
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
