import { describe, expect, test } from "bun:test";
import {
  mergeMcpServers,
  removeMcpServers,
  JsonMergeError,
} from "../../../src/core/install/json-merge.ts";
import type { McpPayload } from "../../../src/core/install/types.ts";

const OSB_PAYLOAD: McpPayload = {
  full: {
    command: "o2b",
    args: ["mcp", "--vault", "/home/u/vault"],
    env: { VAULT_AGENT_NAME: "claude-vps-agent", VAULT_TIMEZONE: "Europe/Belgrade" },
  },
  writer: {
    command: "o2b",
    args: ["mcp", "--writer-only", "--vault", "/home/u/vault"],
    env: { VAULT_AGENT_NAME: "claude-vps-agent", VAULT_TIMEZONE: "Europe/Belgrade" },
  },
};

describe("mergeMcpServers", () => {
  test("creates file from scratch when input is empty", () => {
    const out = mergeMcpServers("", OSB_PAYLOAD);
    const parsed = JSON.parse(out);
    expect(Object.keys(parsed.mcpServers)).toEqual([
      "open-second-brain",
      "open-second-brain-writer",
    ]);
    expect(out.endsWith("\n")).toBe(true);
  });

  test("creates file from null/undefined-ish empty whitespace", () => {
    const out = mergeMcpServers("   \n  ", OSB_PAYLOAD);
    const parsed = JSON.parse(out);
    expect(parsed.mcpServers["open-second-brain"]).toBeDefined();
  });

  test("preserves unrelated mcpServers keys, OSB keys appended", () => {
    const before = `{
  "mcpServers": {
    "other": { "command": "x", "args": [] }
  }
}
`;
    const out = mergeMcpServers(before, OSB_PAYLOAD);
    const parsed = JSON.parse(out);
    expect(Object.keys(parsed.mcpServers)).toEqual([
      "other",
      "open-second-brain",
      "open-second-brain-writer",
    ]);
    expect(parsed.mcpServers.other).toEqual({ command: "x", args: [] });
  });

  test("preserves unrelated top-level keys", () => {
    const before = `{
  "theme": "dark",
  "mcpServers": {}
}
`;
    const out = mergeMcpServers(before, OSB_PAYLOAD);
    const parsed = JSON.parse(out);
    expect(parsed.theme).toBe("dark");
  });

  test("overwrites old OSB keys with current canonical payload", () => {
    const before = `{
  "mcpServers": {
    "open-second-brain": { "command": "o2b", "args": ["mcp", "--vault", "/OLD"] }
  }
}
`;
    const out = mergeMcpServers(before, OSB_PAYLOAD);
    const parsed = JSON.parse(out);
    expect(parsed.mcpServers["open-second-brain"].args).toEqual([
      "mcp",
      "--vault",
      "/home/u/vault",
    ]);
  });

  test("uses different top-level key when overridden (kiro/gemini-style)", () => {
    const before = `{
  "mcp_servers": {
    "other": { "command": "x" }
  }
}
`;
    const out = mergeMcpServers(before, OSB_PAYLOAD, { topLevelKey: "mcp_servers" });
    const parsed = JSON.parse(out);
    expect(parsed.mcp_servers["open-second-brain"]).toBeDefined();
    expect(parsed.mcp_servers.other.command).toBe("x");
  });

  test("preserves 4-space indent", () => {
    const before = `{
    "mcpServers": {
        "other": { "command": "x" }
    }
}
`;
    const out = mergeMcpServers(before, OSB_PAYLOAD);
    // 4-space indent detection: at least one line starts with exactly 4 spaces followed by a quote
    expect(out.split("\n").some((l) => /^ {4}"/.test(l))).toBe(true);
  });

  test("rejects malformed JSON with file context", () => {
    expect(() => mergeMcpServers('{ "mcpServers":', OSB_PAYLOAD)).toThrow(JsonMergeError);
  });
});

describe("removeMcpServers", () => {
  test("removes both OSB keys, preserves others", () => {
    const before = mergeMcpServers(
      `{
  "mcpServers": {
    "other": { "command": "x" }
  }
}
`,
      OSB_PAYLOAD,
    );
    const after = removeMcpServers(before);
    const parsed = JSON.parse(after);
    expect(parsed.mcpServers["open-second-brain"]).toBeUndefined();
    expect(parsed.mcpServers["open-second-brain-writer"]).toBeUndefined();
    expect(parsed.mcpServers.other).toEqual({ command: "x" });
  });

  test("noop when OSB keys not present", () => {
    const before = `{
  "mcpServers": { "other": { "command": "x" } }
}
`;
    const after = removeMcpServers(before);
    const parsed = JSON.parse(after);
    expect(parsed.mcpServers.other).toEqual({ command: "x" });
  });

  test("noop on empty input", () => {
    expect(removeMcpServers("")).toBe("");
  });

  test("custom topLevelKey works for remove too", () => {
    const before = `{
  "mcp_servers": {
    "open-second-brain": { "command": "o2b" },
    "other": { "command": "x" }
  }
}
`;
    const after = removeMcpServers(before, { topLevelKey: "mcp_servers" });
    const parsed = JSON.parse(after);
    expect(parsed.mcp_servers["open-second-brain"]).toBeUndefined();
    expect(parsed.mcp_servers.other.command).toBe("x");
  });
});
