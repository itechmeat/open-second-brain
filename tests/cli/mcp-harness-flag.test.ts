import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { HARNESS_IDS } from "../../src/core/brain/scoped-rules.ts";
import { MCPServer } from "../../src/mcp/server.ts";
import { runCli } from "../helpers/run-cli.ts";

/** Whole tokens: `copilot-cli` contains `pi`, so containment over ids lies. */
function tokensOf(text: string): ReadonlySet<string> {
  return new Set(text.split(/[^A-Za-z0-9_-]+/).filter((token) => token.length > 0));
}

describe("o2b mcp --harness", () => {
  test("an unknown harness exits 2 with the pinned message listing every harness", async () => {
    const res = await runCli(["mcp", "--harness", "nope"], { stdin: "" });
    expect(res.returncode).toBe(2);
    expect(res.stderr).toBe(
      `o2b mcp: invalid --harness value: nope; expected one of: ${HARNESS_IDS.join(", ")}\n`,
    );
    const offered = tokensOf(res.stderr);
    for (const id of HARNESS_IDS) {
      expect(`${id} offered: ${offered.has(id)}`).toBe(`${id} offered: true`);
    }
  });

  test("a known harness is accepted by the server start path", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "o2b-mcp-harness-"));
    try {
      const res = await runCli(["mcp", "--probe", "--harness", "claude-code"], {
        stdin: "",
        env: { VAULT_DIR: tmp },
      });
      expect(res.stderr).toBe("");
      expect(res.returncode).toBe(0);
      expect(res.stdout).toContain("mcp probe ok");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("ServerContext.ruleScope", () => {
  let vault: string;
  let workspace: string;
  beforeAll(() => {
    vault = mkdtempSync(join(tmpdir(), "o2b-rule-scope-vault-"));
    workspace = mkdtempSync(join(tmpdir(), "o2b-rule-scope-ws-"));
  });
  afterAll(() => {
    rmSync(vault, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });

  test("an explicit harness and workspace directory reach the context", () => {
    const server = new MCPServer({ vault }, { harness: "codex", workspaceDir: workspace });
    expect(server.context.ruleScope).toEqual({ workspaceDir: workspace, harness: "codex" });
  });

  test("the harness wins over the host target", () => {
    const server = new MCPServer({ vault }, { harness: "claude-code", hostTarget: "cursor" });
    expect(server.context.ruleScope?.harness).toBe("claude-code");
  });

  test("the host target is the fallback harness", () => {
    const server = new MCPServer({ vault }, { hostTarget: "cursor" });
    expect(server.context.ruleScope).toEqual({ workspaceDir: null, harness: "cursor" });
  });

  test("neither option resolves no harness and no workspace", () => {
    const server = new MCPServer({ vault });
    expect(server.context.ruleScope).toEqual({ workspaceDir: null, harness: null });
  });
});
