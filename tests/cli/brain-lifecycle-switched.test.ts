/**
 * The single-record lifecycle verbs on a switched vault, through the CLI
 * and the MCP tool (fourth owner rerun, items 1, 2 and 36): with the
 * frozen legacy tree on disk and after it left, `o2b brain lifecycle
 * tombstone` and `brain_lifecycle` tombstone take the legacy path, the
 * bare id and `store:<id>`, write the store record only, and refuse a
 * target the store does not hold. `o2b brain signal retire` says the
 * signal stays searchable and names the verb that forgets it.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { writeSignal } from "../../src/core/brain/signal.ts";
import { readSignals } from "../../src/core/store/read/signals.ts";
import { JSONRPC_VERSION, MCPServer, PROTOCOL_VERSION } from "../../src/mcp/index.ts";
import { makeStoreEnv, type StoreEnv } from "../core/store/fixtures/store-env.ts";
import { switchDevice } from "../core/brain/store-only/fixtures.ts";
import { runCli } from "../helpers/run-cli.ts";
import { CLI_SPAWN_BUDGET_MS } from "../helpers/cli-timeout.ts";

setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

let env: StoreEnv | undefined;
afterEach(() => {
  env?.cleanup();
  env = undefined;
});

const signalInput = (slug: string) => ({
  topic: `topic ${slug}`,
  signal: "positive" as const,
  agent: "claude",
  principle: `Principle of ${slug}`,
  created_at: "2026-11-20T10:00:00Z",
  date: "2026-11-20",
  slug,
});

function statusOf(vault: string, id: string): unknown {
  return readSignals({ vault }, { states: "all" }).find((s) => s.id === id)?.frontmatter["_status"];
}

function cliEnv(e: StoreEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of [
    "OPEN_SECOND_BRAIN_CONFIG",
    "OPEN_SECOND_BRAIN_STORE_ROOT",
    "O2B_DEVICE_ID",
    "HOME",
    "XDG_STATE_HOME",
    "LOCALAPPDATA",
  ]) {
    const value = process.env[key];
    if (value !== undefined) out[key] = value;
  }
  out["OPEN_SECOND_BRAIN_CONFIG"] = e.configPath;
  return out;
}

async function mcpCall(server: MCPServer, args: Record<string, unknown>) {
  return (await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 9,
    method: "tools/call",
    params: { name: "brain_lifecycle", arguments: args },
  })) as {
    result?: { content: ReadonlyArray<{ text: string }>; isError?: boolean };
    error?: unknown;
  };
}

async function mcpServer(e: StoreEnv): Promise<MCPServer> {
  const server = new MCPServer({ vault: e.vault, configPath: e.configPath });
  await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "forget-test", version: "0" },
    },
  });
  await server.handleRequest({ jsonrpc: JSONRPC_VERSION, method: "notifications/initialized" });
  return server;
}

describe("a switched vault with the legacy tree still on disk", () => {
  test("the CLI tombstone writes the store record, not the legacy page", async () => {
    env = makeStoreEnv("osb-forget-cli-", { dualWrite: true });
    const sig = writeSignal(env.vault, signalInput("cli-forget"));
    switchDevice(env.storeRoot);
    const page = readFileSync(sig.path, "utf8");
    const out = await runCli(
      [
        "brain",
        "lifecycle",
        "tombstone",
        `Brain/inbox/${sig.id}.md`,
        "--reason",
        "wrong",
        "--json",
      ],
      { env: cliEnv(env) },
    );
    expect(out.returncode).toBe(0);
    expect(JSON.parse(out.stdout)).toMatchObject({ changed: true, tombstoned: true });
    expect(readFileSync(sig.path, "utf8")).toBe(page);
    expect(statusOf(env.vault, sig.id)).toBe("tombstoned");
  });

  test("the MCP tombstone takes the bare id and writes the store record", async () => {
    env = makeStoreEnv("osb-forget-mcp-", { dualWrite: true });
    const sig = writeSignal(env.vault, signalInput("mcp-forget"));
    switchDevice(env.storeRoot);
    const page = readFileSync(sig.path, "utf8");
    const server = await mcpServer(env);
    const res = await mcpCall(server, { action: "tombstone", path: sig.id, reason: "wrong" });
    expect(res.error).toBeUndefined();
    expect(JSON.parse(res.result!.content[0]!.text)).toMatchObject({ changed: true });
    expect(readFileSync(sig.path, "utf8")).toBe(page);
    expect(statusOf(env.vault, sig.id)).toBe("tombstoned");
  });
});

describe("a switched vault whose legacy tree left", () => {
  test("the CLI takes store:<id> and refuses an id the store does not hold", async () => {
    env = makeStoreEnv("osb-forget-cli-gone-", { dualWrite: true });
    const sig = writeSignal(env.vault, signalInput("cli-gone"));
    switchDevice(env.storeRoot);
    rmSync(join(env.vault, "Brain"), { recursive: true, force: true });
    const ok = await runCli(
      ["brain", "lifecycle", "tombstone", `store:${sig.id}`, "--reason", "wrong"],
      { env: cliEnv(env) },
    );
    expect(ok.returncode).toBe(0);
    expect(ok.stdout).toContain(`tombstoned Brain/inbox/${sig.id}.md`);
    expect(statusOf(env.vault, sig.id)).toBe("tombstoned");
    const missing = await runCli(
      ["brain", "lifecycle", "tombstone", "sig-2026-11-20-nothing-here", "--reason", "x"],
      { env: cliEnv(env) },
    );
    expect(missing.returncode).toBe(1);
    expect(missing.stderr).toContain("the brain store holds no signal");
  });

  test("the MCP tool refuses a path the store does not hold, by name", async () => {
    env = makeStoreEnv("osb-forget-mcp-gone-", { dualWrite: true });
    switchDevice(env.storeRoot);
    rmSync(join(env.vault, "Brain"), { recursive: true, force: true });
    const server = await mcpServer(env);
    const res = await mcpCall(server, {
      action: "tombstone",
      path: "Brain/inbox/sig-2026-11-20-nothing-here.md",
      reason: "x",
    });
    const refused = res.error !== undefined || res.result?.isError === true;
    expect(refused).toBe(true);
    // Reach is asked before the store is: the refusal reads the same whether
    // or not such a record exists.
    expect(JSON.stringify(res)).toContain("note does not exist");
  });

  test("signal retire says the signal stays searchable and names the verb that forgets it", async () => {
    env = makeStoreEnv("osb-forget-retire-", { dualWrite: true });
    const sig = writeSignal(env.vault, signalInput("retire-note"));
    switchDevice(env.storeRoot);
    const out = await runCli(["brain", "signal", "retire", sig.id, "--reason", "old"], {
      env: cliEnv(env),
    });
    expect(out.returncode).toBe(0);
    expect(out.stdout).toContain(`retired: ${sig.id}`);
    expect(out.stderr).toContain(`o2b brain lifecycle tombstone ${sig.id}`);
  });

  test("4650588373: the retire note keeps the vault the retire was told to use", async () => {
    env = makeStoreEnv("osb-forget-retire-vault-", { dualWrite: true });
    const sig = writeSignal(env.vault, signalInput("retire-vault"));
    switchDevice(env.storeRoot);
    const out = await runCli(
      ["brain", "signal", "retire", sig.id, "--reason", "old", "--vault", env.vault],
      { env: cliEnv(env) },
    );
    expect(out.returncode).toBe(0);
    expect(out.stderr).toContain(`--vault '${env.vault}'`);
  });
});
