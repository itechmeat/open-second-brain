/**
 * End-to-end happy path for the v0.10.10 pull-channels release.
 *
 * Exercises the CLI surface across multiple invocations:
 *   1. `o2b init` + `o2b brain init` bootstrap a fresh vault.
 *   2. `o2b brain note <text>` writes one note event to today's
 *      Brain log + JSONL sidecar with the resolved agent identity.
 *   3. `o2b status` reports semantic search as `off` for a fresh
 *      vault that has no embedding key, with the expected hint
 *      pointing the operator at `o2b search check`.
 *   4. The MCP `brain_context` tool, invoked through the full
 *      MCPServer path, returns the regenerated `Brain/active.md`
 *      with the new `most_applied_30d` count and the resulting
 *      `content` string.
 *
 * If any seam between CLI / core / MCP breaks, the chain surfaces it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../helpers/run-cli.ts";
import {
  JSONRPC_VERSION,
  MCPServer,
  PROTOCOL_VERSION,
} from "../../src/mcp/index.ts";

let tmp: string;
let vault: string;
let config: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-v0-10-10-e2e-"));
  vault = join(tmp, "vault");
  config = join(tmp, "config.yaml");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

describe("v0.10.10 pull-channels e2e", () => {
  test("init → brain note → status → brain_context MCP call", async () => {
    // 1. Bootstrap the vault and the Brain layer through the CLI.
    let r = await runCli(
      ["init", "--vault", vault, "--name", "Pull Channels Test", "--agent-name", "tester"],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config, VAULT_AGENT_NAME: "" } },
    );
    expect(r.returncode).toBe(0);

    r = await runCli(["brain", "init", "--vault", vault], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config, VAULT_AGENT_NAME: "" },
    });
    expect(r.returncode).toBe(0);

    // 2. CLI mirror of brain_note lands one event in Brain/log/<today>.md
    //    plus the JSONL sidecar, with the configured identity.
    r = await runCli(
      ["brain", "note", "v0.10.10 released", "--vault", vault, "--json"],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config, VAULT_AGENT_NAME: "" } },
    );
    expect(r.returncode).toBe(0);
    const noteResult = JSON.parse(r.stdout);
    expect(noteResult.agent).toBe("tester");

    const logMdPath = join(vault, "Brain", "log", `${today()}.md`);
    const logJsonlPath = logMdPath.replace(/\.md$/, ".jsonl");
    const md = readFileSync(logMdPath, "utf8");
    expect(md).toContain("— note");
    expect(md).toContain("- text: v0.10.10 released");
    expect(md).toContain("- agent: tester");

    const jsonl = readFileSync(logJsonlPath, "utf8");
    expect(jsonl).toContain('"kind":"note"');
    expect(jsonl).toContain('"text":"v0.10.10 released"');

    // 3. `o2b status` (no semantic key configured) prints the hint and
    //    surfaces the matching keys in --json.
    r = await runCli(["status", "--config", config, "--json"], {
      env: {
        OPEN_SECOND_BRAIN_CONFIG: config,
        VAULT_AGENT_NAME: "",
        OPEN_SECOND_BRAIN_SEARCH_SEMANTIC: "",
        OPEN_SECOND_BRAIN_EMBEDDING_KEY: "",
      },
    });
    expect(r.returncode).toBe(0);
    const statusJson = JSON.parse(r.stdout);
    expect(statusJson.semantic_enabled).toBe(false);
    expect(statusJson.embedding_key_present).toBe(false);
    expect(statusJson.semantic_hint).toContain("o2b search check");

    // 4. MCP `brain_context` returns the regenerated active.md body
    //    plus counts (with the v0.10.10 `most_applied_30d` field).
    const server = new MCPServer({ vault, configPath: config });
    await server.handleRequest({
      jsonrpc: JSONRPC_VERSION,
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "v0.10.10-e2e", version: "0" },
      },
    });
    await server.handleRequest({
      jsonrpc: JSONRPC_VERSION,
      method: "notifications/initialized",
    });
    const call = (await server.handleRequest({
      jsonrpc: JSONRPC_VERSION,
      id: 2,
      method: "tools/call",
      params: { name: "brain_context", arguments: {} },
    })) as { result: { content: ReadonlyArray<{ text: string }> } };
    const ctx = JSON.parse(call.result.content[0]!.text);
    expect(ctx.present).toBe(true);
    expect(typeof ctx.content).toBe("string");
    expect(ctx.content).toContain("# Active Brain Preferences");
    expect(typeof ctx.counts.most_applied_30d).toBe("number");
  });
});
