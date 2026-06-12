/**
 * Minimal TOML editor for grok's ~/.grok/config.toml [mcp_servers.<name>]
 * tables. The project ships `dependencies = []`, so this handles only the
 * exact shape the grok adapter writes (string command, string[] args, optional
 * inline-table env) and edits by line-section so unrelated config (other
 * [mcp_servers.*], [marketplace], [[marketplace.sources]], [cli]) survives.
 */

import { describe, expect, test } from "bun:test";

import {
  serializeMcpServerTable,
  upsertMcpServers,
  removeMcpServers,
  hasMcpServers,
} from "../../../src/core/install/grok-config.ts";

const ENTRIES = {
  "open-second-brain": {
    command: "/usr/local/bin/bun",
    args: ["run", "/srv/o2b/src/cli/main.ts", "mcp", "--vault", "/v"],
    env: { VAULT_AGENT_NAME: "a" },
  },
  "open-second-brain-writer": {
    command: "/usr/local/bin/bun",
    args: ["run", "/srv/o2b/src/cli/main.ts", "mcp", "--writer-only", "--vault", "/v"],
  },
};

const EXISTING = `[cli]
installer = "internal"

[marketplace]
official_marketplace_auto_installed = true

[[marketplace.sources]]
name = "xAI Official"
git = "https://github.com/xai-org/plugin-marketplace.git"

[mcp_servers.user-linear]
url = "https://mcp.linear.app/mcp"
enabled = true
`;

describe("serializeMcpServerTable", () => {
  test("emits a valid [mcp_servers.<name>] table with command, args, env", () => {
    const t = serializeMcpServerTable("open-second-brain", ENTRIES["open-second-brain"]);
    expect(t).toContain("[mcp_servers.open-second-brain]");
    expect(t).toContain('command = "/usr/local/bin/bun"');
    expect(t).toContain('args = ["run", "/srv/o2b/src/cli/main.ts", "mcp", "--vault", "/v"]');
    expect(t).toContain('env = { VAULT_AGENT_NAME = "a" }');
  });

  test("omits env when absent", () => {
    expect(serializeMcpServerTable("x", { command: "b", args: ["mcp"] })).not.toContain("env =");
  });

  test("escapes quotes and backslashes in strings", () => {
    const t = serializeMcpServerTable("x", { command: 'a"b\\c', args: [] });
    expect(t).toContain('command = "a\\"b\\\\c"');
  });
});

describe("upsertMcpServers", () => {
  test("adds both tables while preserving unrelated config", () => {
    const out = upsertMcpServers(EXISTING, ENTRIES);
    expect(out).toContain("[cli]");
    expect(out).toContain("[[marketplace.sources]]");
    expect(out).toContain("[mcp_servers.user-linear]"); // foreign mcp server untouched
    expect(out).toContain("[mcp_servers.open-second-brain]");
    expect(out).toContain("[mcp_servers.open-second-brain-writer]");
    expect(hasMcpServers(out, ENTRIES)).toBe(true);
  });

  test("is idempotent: re-upsert does not duplicate or drift", () => {
    const once = upsertMcpServers(EXISTING, ENTRIES);
    const twice = upsertMcpServers(once, ENTRIES);
    expect(twice).toBe(once);
    // exactly one header occurrence each
    expect(once.match(/\[mcp_servers\.open-second-brain\]/g)?.length).toBe(1);
    expect(once.match(/\[mcp_servers\.open-second-brain-writer\]/g)?.length).toBe(1);
  });

  test("replaces a stale entry (different command) in place of drift", () => {
    const stale = upsertMcpServers(EXISTING, {
      "open-second-brain": { command: "o2b", args: ["mcp"] },
      "open-second-brain-writer": { command: "o2b", args: ["mcp", "--writer-only"] },
    });
    expect(stale).toContain('command = "o2b"');
    const fixed = upsertMcpServers(stale, ENTRIES);
    expect(fixed).not.toContain('command = "o2b"\n');
    expect(fixed).toContain('command = "/usr/local/bin/bun"');
    expect(hasMcpServers(fixed, ENTRIES)).toBe(true);
  });

  test("works on an empty config", () => {
    const out = upsertMcpServers("", ENTRIES);
    expect(hasMcpServers(out, ENTRIES)).toBe(true);
  });
});

describe("removeMcpServers", () => {
  test("removes only our tables, keeps foreign mcp servers and other sections", () => {
    const withOurs = upsertMcpServers(EXISTING, ENTRIES);
    const removed = removeMcpServers(withOurs, Object.keys(ENTRIES));
    expect(removed).not.toContain("[mcp_servers.open-second-brain]");
    expect(removed).not.toContain("[mcp_servers.open-second-brain-writer]");
    expect(removed).toContain("[mcp_servers.user-linear]");
    expect(removed).toContain("[cli]");
    expect(removed).toContain("[[marketplace.sources]]");
    expect(hasMcpServers(removed, ENTRIES)).toBe(false);
  });
});

describe("hasMcpServers (drift check)", () => {
  test("false when an expected table is missing or altered", () => {
    expect(hasMcpServers(EXISTING, ENTRIES)).toBe(false);
    const out = upsertMcpServers(EXISTING, ENTRIES);
    const tampered = out.replace('"--vault", "/v"', '"--vault", "/other"');
    expect(hasMcpServers(tampered, ENTRIES)).toBe(false);
  });
});
