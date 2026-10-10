/**
 * Transport authentication and request-scoped identity (write-side-trust,
 * Task 7).
 *
 * The token map is the first credential source, the shared key the
 * second (it keeps the process config identity), and a presented
 * credential that matches neither is refused with the same generic 401
 * body the shared key has always answered with - no oracle distinguishes
 * a revoked token from an unknown one. With no tokens configured every
 * existing posture is byte-identical: the suites that predate this one
 * pass unmodified.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startHttp, type HttpServerHandle } from "../../src/mcp/index.ts";
import { fakeCredential } from "../helpers/fake-credentials.ts";
import {
  MCP_TOKENS_REQUIRED_CONFIG_KEY,
  authenticateRequest,
  resolveMcpTokensRequired,
  type RequestIdentity,
} from "../../src/mcp/http.ts";
import type { IncomingMessage } from "node:http";
import { JSONRPC_VERSION } from "../../src/mcp/protocol.ts";
import { brainConfigPath } from "../../src/core/brain/paths.ts";
import { GATE_MODE } from "../../src/core/integrity/stamp.ts";
import { writePreference } from "../../src/core/brain/preference.ts";
import { BRAIN_CONFIDENCE, BRAIN_PREFERENCE_STATUS } from "../../src/core/brain/types.ts";
import { mintAgentToken, rotateAgentToken } from "../../src/core/brain/secrets/token-store.ts";

let vault: string;
let handle: HttpServerHandle | null = null;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-http-token-"));
});

afterEach(async () => {
  if (handle !== null) await handle.close();
  handle = null;
  rmSync(vault, { recursive: true, force: true });
});

function rpc(method: string, id: number, params: Record<string, unknown> = {}) {
  return { jsonrpc: JSONRPC_VERSION, id, method, params };
}

async function post(
  body: unknown,
  opts: { key?: string; header?: "authorization" | "x-api-key" } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
  };
  if (opts.key !== undefined) {
    if (opts.header === "x-api-key") headers["x-api-key"] = opts.key;
    else headers.authorization = `Bearer ${opts.key}`;
  }
  return fetch(handle!.url, { method: "POST", headers, body: JSON.stringify(body) });
}

async function postJson(body: unknown, opts: { key?: string } = {}): Promise<Record<string, any>> {
  const res = await post(body, opts);
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, any>;
}

async function start(opts: Parameters<typeof startHttp>[1] = {}): Promise<void> {
  handle = await startHttp({ vault }, { host: "127.0.0.1", port: 0, ...opts });
}

/** The identity a token caller named, via a foreign-scope probe under the fail gate. */
async function resolvedIdentityInRefusal(
  tokenMaterial: string,
  requestedScope: string,
): Promise<string | null> {
  const body = await postJson(
    rpc("tools/call", 1, {
      name: "brain_context_pack",
      arguments: { max_tokens: 4000, agent_scope: requestedScope },
    }),
    { key: tokenMaterial },
  );
  const message = body.error?.message as string | undefined;
  if (message === undefined) return null;
  const match = /resolved for the caller, "([^"]+)"/.exec(message);
  return match?.[1] ?? null;
}

function setGate(mode: string): void {
  mkdirSync(join(vault, "Brain"), { recursive: true });
  writeFileSync(
    brainConfigPath(vault),
    `schema_version: 1\nintegrity:\n  owner_scope_delivery: ${mode}\n`,
  );
}

function makePref(slug: string, owner?: string): void {
  mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
  writePreference(vault, {
    slug,
    topic: slug,
    principle: `principle for ${slug}`,
    created_at: "2026-05-01T00:00:00Z",
    unconfirmed_until: "2026-05-08T00:00:00Z",
    status: BRAIN_PREFERENCE_STATUS.confirmed,
    evidenced_by: [`[[sig-2026-05-01-${slug}]]`],
    confirmed_at: "2026-05-02T00:00:00Z",
    applied_count: 1,
    violated_count: 0,
    last_evidence_at: "2026-05-02T00:00:00Z",
    confidence: BRAIN_CONFIDENCE.high,
    confidence_value: 0.8,
    ...(owner !== undefined ? { owner } : {}),
  });
}

describe("HTTP token authentication", () => {
  test("a valid token authenticates with per-caller identity", async () => {
    const { tokenMaterial } = mintAgentToken(vault, "mcp_token_edge", "edge-agent");
    // Preferences land before any gate exists, so their owners are the
    // ones this fixture states rather than ones a write-time gate stamped.
    makePref("shared-pref");
    makePref("edge-owned", "edge-agent");
    makePref("other-owned", "someone-else");
    setGate(GATE_MODE.fail);
    await start({});
    // Own scope: answered, and isolated to what this caller may read.
    const own = await postJson(
      rpc("tools/call", 1, {
        name: "brain_context_pack",
        arguments: { max_tokens: 4000, agent_scope: "edge-agent" },
      }),
      { key: tokenMaterial },
    );
    const payload = JSON.stringify(own.result);
    expect(payload).toContain("shared-pref");
    expect(payload).toContain("edge-owned");
    expect(payload).not.toContain("other-owned");
  });

  test("a foreign scope under the fail gate is refused, naming the token's agent", async () => {
    const { tokenMaterial } = mintAgentToken(vault, "mcp_token_edge", "edge-agent");
    setGate(GATE_MODE.fail);
    await start({});
    const body = await postJson(
      rpc("tools/call", 1, {
        name: "brain_context_pack",
        arguments: { max_tokens: 4000, agent_scope: "someone-else" },
      }),
      { key: tokenMaterial },
    );
    const message = body.error?.message as string;
    expect(message).toContain("foreign-owner");
    expect(message).toContain("edge-agent");
    expect(message).toContain("someone-else");
  });

  test("concurrent requests with different tokens never observe each other's identity", async () => {
    const a = mintAgentToken(vault, "mcp_token_caller_a", "caller-a").tokenMaterial;
    const b = mintAgentToken(vault, "mcp_token_caller_b", "caller-b").tokenMaterial;
    setGate(GATE_MODE.fail);
    await start({});
    // Eight rounds of two in-flight requests whose refusal messages would
    // name the WRONG token's agent if either request observed the other's
    // identity - the failure an instance field would produce.
    const rounds = await Promise.all(
      Array.from({ length: 8 }, () =>
        Promise.all([
          resolvedIdentityInRefusal(a, "owner-x"),
          resolvedIdentityInRefusal(b, "owner-y"),
        ]),
      ),
    );
    for (const [identityA, identityB] of rounds) {
      expect(identityA).toBe("caller-a");
      expect(identityB).toBe("caller-b");
    }
  });

  test("the shared key still authenticates, carrying the process identity", async () => {
    const sharedKey = fakeCredential("shared", "-master-", "77f1");
    const savedAgent = process.env["VAULT_AGENT_NAME"];
    process.env["VAULT_AGENT_NAME"] = "operator";
    try {
      setGate(GATE_MODE.fail);
      await start({ apiKey: sharedKey });
      const own = await postJson(
        rpc("tools/call", 1, {
          name: "brain_context_pack",
          arguments: { max_tokens: 4000, agent_scope: "operator" },
        }),
        { key: sharedKey },
      );
      expect(own.error).toBeUndefined();
    } finally {
      if (savedAgent === undefined) delete process.env["VAULT_AGENT_NAME"];
      else process.env["VAULT_AGENT_NAME"] = savedAgent;
    }
  });

  test("the token map is consulted before the shared key", async () => {
    const sharedKey = fakeCredential("shared", "-master-", "77f1");
    const { tokenMaterial } = mintAgentToken(vault, "mcp_token_edge", "edge-agent");
    setGate(GATE_MODE.fail);
    await start({ apiKey: sharedKey });
    const identity = await resolvedIdentityInRefusal(tokenMaterial, "someone-else");
    // The refusal names the TOKEN's agent, so the map answered first.
    expect(identity).toBe("edge-agent");
  });

  test("a revoked token answers the same generic 401 as an unknown one", async () => {
    const sharedKey = fakeCredential("shared", "-master-", "77f1");
    const minted = mintAgentToken(vault, "mcp_token_edge", "edge-agent");
    await start({ apiKey: sharedKey });
    rotateAgentToken(vault, "mcp_token_edge");
    const revoked = await post(rpc("ping", 1), { key: minted.tokenMaterial });
    const unknown = await post(rpc("ping", 2), {
      key: fakeCredential("osbt_", "never-minted"),
    });
    expect(revoked.status).toBe(401);
    expect(await revoked.text()).toBe("Unauthorized\n");
    expect(await unknown.text()).toBe("Unauthorized\n");
  });

  test("mcp_tokens_required with a non-empty map refuses credential-less and invalid calls", async () => {
    const { tokenMaterial } = mintAgentToken(vault, "mcp_token_edge", "edge-agent");
    await start({ tokensRequired: true });
    const missing = await post(rpc("ping", 1));
    const invalid = await post(rpc("ping", 2), { key: fakeCredential("osbt_", "garbage") });
    const valid = await post(rpc("ping", 3), { key: tokenMaterial });
    expect(missing.status).toBe(401);
    expect(await missing.text()).toBe("Unauthorized\n");
    expect(invalid.status).toBe(401);
    expect(await invalid.text()).toBe("Unauthorized\n");
    expect(valid.status).toBe(200);
  });

  test("mcp_tokens_required with an empty map does not refuse (warn only)", async () => {
    await start({ tokensRequired: true });
    const res = await post(rpc("ping", 1));
    expect(res.status).toBe(200);
  });

  test("a non-loopback bind accepts a token map without an api key", async () => {
    const { tokenMaterial } = mintAgentToken(vault, "mcp_token_edge", "edge-agent");
    handle = await startHttp({ vault }, { host: "0.0.0.0", port: 0 });
    const keyless = await post(rpc("ping", 1));
    expect(keyless.status).toBe(401);
    const withToken = await post(rpc("ping", 2), { key: tokenMaterial });
    expect(withToken.status).toBe(200);
  });

  test("a rotation takes effect on the next request with no server restart", async () => {
    const first = mintAgentToken(vault, "mcp_token_edge", "edge-agent");
    await start({ tokensRequired: true });
    expect((await post(rpc("ping", 1), { key: first.tokenMaterial })).status).toBe(200);
    const second = rotateAgentToken(vault, "mcp_token_edge");
    expect((await post(rpc("ping", 2), { key: first.tokenMaterial })).status).toBe(401);
    expect((await post(rpc("ping", 3), { key: second.tokenMaterial })).status).toBe(200);
  });

  test("a token is accepted through the x-api-key header too", async () => {
    const { tokenMaterial } = mintAgentToken(vault, "mcp_token_edge", "edge-agent");
    await start({ tokensRequired: true });
    const res = await post(rpc("ping", 1), { key: tokenMaterial, header: "x-api-key" });
    expect(res.status).toBe(200);
  });
});

/** A minimal request double: authenticateRequest reads only `headers`. */
const reqWith = (headers: Record<string, string>) => ({ headers }) as unknown as IncomingMessage;

const RESOLVED_TOKEN = fakeCredential("token-material", "-1");

const resolveToken = (presented: string) =>
  presented === RESOLVED_TOKEN ? { agent: "edge-agent" } : null;

describe("authenticateRequest", () => {
  test("the token map answers first, then the shared key, then null", () => {
    const base = {
      apiKey: fakeCredential("key-material-", "2"),
      resolveToken,
    };
    expect(
      authenticateRequest(reqWith({ authorization: `Bearer ${RESOLVED_TOKEN}` }), base),
    ).toEqual({
      agent: "edge-agent",
      via: "token",
    });
    expect(
      authenticateRequest(
        reqWith({ authorization: `Bearer ${fakeCredential("key-material-", "2")}` }),
        {
          ...base,
          sharedKeyAgent: "operator",
        },
      ),
    ).toEqual({ agent: "operator", via: "shared-key" });
    expect(authenticateRequest(reqWith({ authorization: "Bearer neither" }), base)).toBeNull();
    expect(authenticateRequest(reqWith({}), base)).toBeNull();
    // A credential matching BOTH the token map and the shared key resolves
    // through the token map: the minted agent wins and the shared key never
    // overrides it - the consultation order itself is pinned here.
    expect(
      authenticateRequest(reqWith({ authorization: `Bearer ${RESOLVED_TOKEN}` }), {
        ...base,
        apiKey: RESOLVED_TOKEN,
        sharedKeyAgent: "operator",
      }),
    ).toEqual({ agent: "edge-agent", via: "token" });
  });

  test("an empty shared key never matches; x-api-key carries a token too", () => {
    const base = { apiKey: "", resolveToken };
    expect(authenticateRequest(reqWith({ "x-api-key": RESOLVED_TOKEN }), base)).toEqual({
      agent: "edge-agent",
      via: "token",
    });
    expect(authenticateRequest(reqWith({ "x-api-key": "" }), base)).toBeNull();
  });

  test("resolveToken sees exactly the presented credential", () => {
    const seen: string[] = [];
    authenticateRequest(reqWith({ authorization: `Bearer ${RESOLVED_TOKEN}` }), {
      apiKey: null,
      resolveToken: (presented) => {
        seen.push(presented);
        return null;
      },
    });
    expect(seen).toEqual([RESOLVED_TOKEN]);
  });
});

describe("resolveMcpTokensRequired", () => {
  test("the config key and its env twin resolve, env winning", () => {
    const configHome = mkdtempSync(join(tmpdir(), "o2b-http-token-cfg-"));
    const configPath = join(configHome, "config.yaml");
    writeFileSync(configPath, `${MCP_TOKENS_REQUIRED_CONFIG_KEY}: "true"\n`);
    const savedEnv = process.env["OPEN_SECOND_BRAIN_CONFIG"];
    const savedTwin = process.env["OPEN_SECOND_BRAIN_MCP_TOKENS_REQUIRED"];
    try {
      process.env["OPEN_SECOND_BRAIN_CONFIG"] = configPath;
      delete process.env["OPEN_SECOND_BRAIN_MCP_TOKENS_REQUIRED"];
      expect(resolveMcpTokensRequired(undefined)).toBe(true);
      process.env["OPEN_SECOND_BRAIN_MCP_TOKENS_REQUIRED"] = "false";
      expect(resolveMcpTokensRequired(undefined)).toBe(false);
      process.env["OPEN_SECOND_BRAIN_MCP_TOKENS_REQUIRED"] = "true";
      expect(resolveMcpTokensRequired(undefined)).toBe(true);
    } finally {
      if (savedEnv === undefined) delete process.env["OPEN_SECOND_BRAIN_CONFIG"];
      else process.env["OPEN_SECOND_BRAIN_CONFIG"] = savedEnv;
      if (savedTwin === undefined) delete process.env["OPEN_SECOND_BRAIN_MCP_TOKENS_REQUIRED"];
      else process.env["OPEN_SECOND_BRAIN_MCP_TOKENS_REQUIRED"] = savedTwin;
      rmSync(configHome, { recursive: true, force: true });
    }
  });

  test("default off with nothing configured", () => {
    const savedEnv = process.env["OPEN_SECOND_BRAIN_CONFIG"];
    const savedTwin = process.env["OPEN_SECOND_BRAIN_MCP_TOKENS_REQUIRED"];
    try {
      process.env["OPEN_SECOND_BRAIN_CONFIG"] = join(vault, "absent-config.yaml");
      delete process.env["OPEN_SECOND_BRAIN_MCP_TOKENS_REQUIRED"];
      expect(resolveMcpTokensRequired(undefined)).toBe(false);
    } finally {
      if (savedEnv === undefined) delete process.env["OPEN_SECOND_BRAIN_CONFIG"];
      else process.env["OPEN_SECOND_BRAIN_CONFIG"] = savedEnv;
      if (savedTwin === undefined) delete process.env["OPEN_SECOND_BRAIN_MCP_TOKENS_REQUIRED"];
      else process.env["OPEN_SECOND_BRAIN_MCP_TOKENS_REQUIRED"] = savedTwin;
    }
  });
});

// The identity type is part of the pinned surface; a shape check keeps
// the import honest even where the tests above only build one inline.
// The compared value is deliberately outside the `via` vocabulary, so
// the check reads through `string`: a member named here would make the
// comparison look intentional to the compiler and vacuous at runtime.
const SAMPLE_IDENTITY: RequestIdentity = { agent: "edge-agent", via: "token" };
if ((SAMPLE_IDENTITY.via as string) === "never") throw new Error("unreachable");
