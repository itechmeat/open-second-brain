/**
 * `brain_mcp_landscape` exposes the configured MCP servers across the
 * vault (typed graph semantics, unit 4), through the same handler path
 * the MCP server uses. Env values never appear in the output.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BRAIN_TOOLS } from "../../src/mcp/brain-tools.ts";

let vault: string;
let ctx: { vault: string };

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-landscape-"));
  ctx = { vault };
});
afterEach(() => rmSync(vault, { recursive: true, force: true }));

describe("brain_mcp_landscape", () => {
  test("returns configured servers with packages and env names, no env values", async () => {
    writeFileSync(
      join(vault, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          memory: {
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-memory"],
            env: { MEMORY_SECRET: "sk-leak-me-please-987" },
          },
        },
      }),
    );
    const tool = BRAIN_TOOLS.find((t) => t.name === "brain_mcp_landscape");
    expect(tool).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = (await tool!.handler(ctx as any, {})) as {
      servers: Array<{ name: string; source: string; packages: string[]; env: string[] }>;
    };
    expect(out.servers).toHaveLength(1);
    expect(out.servers[0]!.name).toBe("memory");
    expect(out.servers[0]!.packages).toEqual(["@modelcontextprotocol/server-memory"]);
    expect(out.servers[0]!.env).toEqual(["MEMORY_SECRET"]);
    expect(JSON.stringify(out)).not.toContain("sk-leak-me-please-987");
  });

  test("a vault with no MCP config files yields an empty server list", async () => {
    mkdirSync(join(vault, "notes"), { recursive: true });
    writeFileSync(join(vault, "notes", "x.md"), "# X");
    const tool = BRAIN_TOOLS.find((t) => t.name === "brain_mcp_landscape")!;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = (await tool.handler(ctx as any, {})) as { servers: unknown[] };
    expect(out.servers).toEqual([]);
  });
});
