/**
 * MCP-config extraction into the graph (typed graph semantics, unit 4).
 *
 * Parses MCP server config files found in the vault into a typed
 * landscape (server / package / env-requirement), discarding env
 * VALUES. Discovery is vault-relative only.
 */

import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildMcpLandscape,
  isMcpConfigFile,
  MCP_CONFIG_FILENAMES,
  parseMcpConfig,
} from "../../../src/core/graph/mcp-config.ts";

describe("parseMcpConfig (pure)", () => {
  test("extracts server, package (npx) and env-requirement names", () => {
    const json = JSON.stringify({
      mcpServers: {
        memory: {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-memory"],
          env: { MEMORY_TOKEN: "tok-123", REGION: "eu" },
        },
      },
    });
    const servers = parseMcpConfig(json, ".mcp.json");
    expect(servers).toHaveLength(1);
    const s = servers[0]!;
    expect(s.name).toBe("memory");
    expect(s.source).toBe(".mcp.json");
    expect(s.packages).toEqual(["@modelcontextprotocol/server-memory"]);
    expect(s.env.toSorted()).toEqual(["MEMORY_TOKEN", "REGION"]);
  });

  test("env VALUES are discarded - only names survive", () => {
    const json = JSON.stringify({
      mcpServers: {
        secretful: {
          command: "uvx",
          args: ["some-mcp-package"],
          env: { API_KEY: "sk-DO-NOT-LEAK-abc123", PASSWORD: "hunter2" },
        },
      },
    });
    const servers = parseMcpConfig(json, "mcp.json");
    const blob = JSON.stringify(servers);
    expect(blob).not.toContain("sk-DO-NOT-LEAK-abc123");
    expect(blob).not.toContain("hunter2");
    expect(servers[0]!.env.toSorted()).toEqual(["API_KEY", "PASSWORD"]);
    expect(servers[0]!.packages).toEqual(["some-mcp-package"]);
  });

  test("an inline KEY=value positional is never captured as a package", () => {
    const json = JSON.stringify({
      mcpServers: {
        inlined: { command: "npx", args: ["TOKEN=sk-inline-leak-xyz", "@scope/pkg"] },
      },
    });
    const servers = parseMcpConfig(json, ".mcp.json");
    expect(servers[0]!.packages).toEqual(["@scope/pkg"]);
    expect(JSON.stringify(servers)).not.toContain("sk-inline-leak-xyz");
  });

  test("a local-binary command yields no package edge", () => {
    const json = JSON.stringify({
      mcpServers: { local: { command: "node", args: ["./server.js"] } },
    });
    const servers = parseMcpConfig(json, ".mcp.json");
    expect(servers[0]!.packages).toEqual([]);
  });

  test("the `servers` key is accepted as well as `mcpServers`", () => {
    const json = JSON.stringify({ servers: { x: { command: "npx", args: ["pkg-x"] } } });
    expect(parseMcpConfig(json, ".mcp.json")).toHaveLength(1);
  });

  test("malformed JSON yields an empty list, never throws", () => {
    expect(parseMcpConfig("{ not json", ".mcp.json")).toEqual([]);
  });
});

describe("isMcpConfigFile", () => {
  test("recognises the four supported filenames, by basename", () => {
    for (const name of MCP_CONFIG_FILENAMES) {
      expect(isMcpConfigFile(name)).toBe(true);
      expect(isMcpConfigFile(`nested/dir/${name}`)).toBe(true);
    }
    expect(isMcpConfigFile("package.json")).toBe(false);
    expect(isMcpConfigFile("notes/foo.md")).toBe(false);
  });
});

describe("buildMcpLandscape (vault-relative discovery)", () => {
  let vault: string;
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "o2b-mcp-config-"));
  });
  afterEach(() => rmSync(vault, { recursive: true, force: true }));

  test("discovers config files across the vault and groups by server", () => {
    writeFileSync(
      join(vault, ".mcp.json"),
      JSON.stringify({ mcpServers: { a: { command: "npx", args: ["-y", "pkg-a"] } } }),
    );
    mkdirSync(join(vault, "tools"), { recursive: true });
    writeFileSync(
      join(vault, "tools", "claude_desktop_config.json"),
      JSON.stringify({ mcpServers: { b: { command: "uvx", args: ["pkg-b"], env: { B_KEY: "x" } } } }),
    );
    const land = buildMcpLandscape(vault);
    const names = land.servers.map((s) => s.name).toSorted();
    expect(names).toEqual(["a", "b"]);
    const b = land.servers.find((s) => s.name === "b")!;
    expect(b.packages).toEqual(["pkg-b"]);
    expect(b.env).toEqual(["B_KEY"]);
  });

  test("does not scan ignored directories like .git", () => {
    mkdirSync(join(vault, ".git"), { recursive: true });
    writeFileSync(
      join(vault, ".git", "mcp.json"),
      JSON.stringify({ mcpServers: { ghost: { command: "npx", args: ["ghost"] } } }),
    );
    const land = buildMcpLandscape(vault);
    expect(land.servers.map((s) => s.name)).not.toContain("ghost");
  });
});
