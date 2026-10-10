/**
 * Write-side decisions answer for the credential's agent (write-side
 * trust, Task 7 over HTTP).
 *
 * A token minted for an agent is the identity every write-side gate
 * answers for when that token calls: the permissions document is
 * consulted under the token's agent, the owner-write gate resolves to
 * it, the decision ledger names it, and a caller-supplied `agent`
 * argument claiming somebody else is refused outright. The process
 * config identity (`operator` throughout this suite) must never appear
 * where the token's agent decides.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startHttp, type HttpServerHandle } from "../../src/mcp/index.ts";
import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { brainConfigPath } from "../../src/core/brain/paths.ts";
import { queryDecisionLedger } from "../../src/core/brain/permissions/ledger.ts";
import { mintAgentToken } from "../../src/core/brain/secrets/token-store.ts";
import { GATE_MODE } from "../../src/core/integrity/stamp.ts";
import { JSONRPC_VERSION } from "../../src/mcp/protocol.ts";

let vault: string;
let handle: HttpServerHandle | null = null;
const envSaved = new Map<string, string | undefined>();

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-http-write-identity-"));
  bootstrapBrain(vault, {});
  setEnv("VAULT_AGENT_NAME", "operator");
});

afterEach(async () => {
  if (handle !== null) await handle.close();
  handle = null;
  rmSync(vault, { recursive: true, force: true });
  for (const [key, value] of envSaved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  envSaved.clear();
});

function setEnv(key: string, value: string | undefined): void {
  if (!envSaved.has(key)) envSaved.set(key, process.env[key]);
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function rpc(method: string, id: number, params: Record<string, unknown> = {}) {
  return { jsonrpc: JSONRPC_VERSION, id, method, params };
}

async function post(body: unknown, key?: string): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
  };
  if (key !== undefined) headers.authorization = `Bearer ${key}`;
  return fetch(handle!.url, { method: "POST", headers, body: JSON.stringify(body) });
}

async function postJson(body: unknown, key?: string): Promise<Record<string, any>> {
  const res = await post(body, key);
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, any>;
}

async function start(): Promise<void> {
  handle = await startHttp({ vault }, { host: "127.0.0.1", port: 0 });
}

function writeDoc(text: string): void {
  mkdirSync(join(vault, "Brain"), { recursive: true });
  writeFileSync(join(vault, "Brain", "_permissions.yaml"), text, "utf8");
}

function setGate(mode: string): void {
  mkdirSync(join(vault, "Brain"), { recursive: true });
  writeFileSync(
    brainConfigPath(vault),
    `schema_version: 1\nintegrity:\n  owner_scope_writes: ${mode}\n`,
  );
}

function inboxEntries(): string[] {
  const dir = join(vault, "Brain", "inbox");
  return existsSync(dir) ? readdirSync(dir).filter((n) => n.includes("prefer-tests")) : [];
}

describe("write-side decisions answer for the token's agent", () => {
  test("a document deny for the token's agent refuses its create, naming the rule", async () => {
    const { tokenMaterial } = mintAgentToken(vault, "mcp_token_bob", "bob");
    writeDoc("version: 1\ndefault_action: allow\nagents:\n  bob:\n    write: deny\n");
    await start();
    const body = await postJson(
      rpc("tools/call", 1, {
        name: "brain_create_note",
        arguments: { path: "Notes/Bob Page.md", content: "bob bytes" },
      }),
      tokenMaterial,
    );
    const error = body.error as Record<string, any>;
    expect(error).toBeDefined();
    expect(error.code).toBe(-32602);
    expect(error.data.code).toBe("write-refused");
    expect(error.data.agent).toBe("bob");
    expect(error.data.rule).toBe("agent:bob");
    // Nothing was written, and the ledger names the token agent arriving
    // by token - never the process config identity.
    expect(existsSync(join(vault, "Notes/Bob Page.md"))).toBe(false);
    const rows = queryDecisionLedger(vault, { verdict: "deny" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor: "bob",
      via: "token",
      action: "write",
      target: "Notes/Bob Page.md",
      source: "agent:bob",
    });
  });

  test("a cross-owner claim under the fail gate is refused, answering for the token's agent", async () => {
    const { tokenMaterial } = mintAgentToken(vault, "mcp_token_bob", "bob");
    setGate(GATE_MODE.fail);
    await start();
    const body = await postJson(
      rpc("tools/call", 1, {
        name: "brain_create_note",
        arguments: {
          path: "Notes/Claimed.md",
          content: "claimed bytes",
          frontmatter: { owner: "alice" },
        },
      }),
      tokenMaterial,
    );
    const error = body.error as Record<string, any>;
    expect(error).toBeDefined();
    expect(error.data.code).toBe("owner_write_refused");
    // The gate resolved the caller to the token's agent, so the claim on
    // alice's name is a cross-owner write and the refusal says whose.
    expect(JSON.stringify(error)).toContain("alice");
    expect(JSON.stringify(error)).toContain("bob");
    expect(existsSync(join(vault, "Notes/Claimed.md"))).toBe(false);
  });

  test("a token caller cannot sign another agent's name to a feedback write", async () => {
    const { tokenMaterial } = mintAgentToken(vault, "mcp_token_bob", "bob");
    await start();
    const body = await postJson(
      rpc("tools/call", 1, {
        name: "brain_feedback",
        arguments: {
          topic: "prefer tests",
          signal: "positive",
          principle: "always test first",
          agent: "alice",
        },
      }),
      tokenMaterial,
    );
    const error = body.error as Record<string, any>;
    expect(error).toBeDefined();
    expect(error.code).toBe(-32602);
    expect(error.message).toContain("agent-claim-refused");
    expect(error.message).toContain("alice");
    expect(error.message).toContain("bob");
    // The refusal fired before any byte: no signal, no preference page.
    expect(inboxEntries()).toEqual([]);
  });

  test("a staged create's review row names the token agent, not the config identity", async () => {
    const { tokenMaterial } = mintAgentToken(vault, "mcp_token_bob", "bob");
    writeDoc("version: 1\ndefault_action: ask\n");
    await start();
    const body = await postJson(
      rpc("tools/call", 1, {
        name: "brain_create_note",
        arguments: { path: "Notes/Bob Ask.md", content: "reviewed bytes" },
      }),
      tokenMaterial,
    );
    const result = (body.result as Record<string, any>).structuredContent as Record<string, any>;
    expect(body.error).toBeUndefined();
    expect(result.staged).toBe(true);
    expect(result.pending_id).toBeDefined();
    const rows = queryDecisionLedger(vault, { verdict: "ask" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor: "bob",
      via: "token",
      action: "write",
      target: "Notes/Bob Ask.md",
      source: "default",
    });
  });
});
