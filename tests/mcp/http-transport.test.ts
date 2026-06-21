import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JSONRPC_VERSION, PROTOCOL_VERSION, startHttp } from "../../src/mcp/index.ts";

interface JsonObject {
  readonly [key: string]: any;
}

async function responseJson(res: Response): Promise<JsonObject> {
  return (await res.json()) as JsonObject;
}

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-mcp-http-"));
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function rpc(method: string, id: number, params: Record<string, unknown> = {}) {
  return { jsonrpc: JSONRPC_VERSION, id, method, params };
}

async function post(
  url: string,
  body: unknown,
  opts: { key?: string; accept?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: opts.accept ?? "application/json",
  };
  if (opts.key !== undefined) headers.authorization = `Bearer ${opts.key}`;
  return fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
}

describe("Streamable HTTP MCP transport", () => {
  test("refuses to start without an API key", async () => {
    await expect(startHttp({ vault }, { host: "127.0.0.1", port: 0 })).rejects.toThrow(/api-key/i);
  });

  test("uses generic 401 for missing and wrong API keys", async () => {
    const handle = await startHttp({ vault }, { apiKey: "secret", host: "127.0.0.1", port: 0 });
    try {
      const req = rpc("ping", 1);
      const missing = await post(handle.url, req);
      const wrong = await post(handle.url, req, { key: "wrong" });
      expect(missing.status).toBe(401);
      expect(wrong.status).toBe(401);
      expect(await missing.text()).toBe("Unauthorized\n");
      expect(await wrong.text()).toBe("Unauthorized\n");
    } finally {
      await handle.close();
    }
  });

  test("authenticated initialize and tools/list round-trip through JSON responses", async () => {
    const handle = await startHttp({ vault }, { apiKey: "secret", host: "127.0.0.1", port: 0 });
    try {
      const initRes = await post(
        handle.url,
        rpc("initialize", 1, { protocolVersion: PROTOCOL_VERSION, capabilities: {} }),
        { key: "secret" },
      );
      expect(initRes.status).toBe(200);
      expect(initRes.headers.get("mcp-session-id")).toBeTruthy();
      const init = await responseJson(initRes);
      expect(init.result.protocolVersion).toBe(PROTOCOL_VERSION);

      const listRes = await post(handle.url, rpc("tools/list", 2), { key: "secret" });
      const list = await responseJson(listRes);
      expect(list.jsonrpc).toBe(JSONRPC_VERSION);
      expect(Array.isArray(list.result.tools)).toBe(true);
      expect(list.result.tools.length).toBeGreaterThan(0);
    } finally {
      await handle.close();
    }
  });

  test("returns one SSE event when the client accepts event-stream", async () => {
    const handle = await startHttp({ vault }, { apiKey: "secret", host: "127.0.0.1", port: 0 });
    try {
      const res = await post(handle.url, rpc("ping", 3), {
        key: "secret",
        accept: "application/json, text/event-stream",
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type") ?? "").toContain("text/event-stream");
      const text = await res.text();
      expect(text).toContain("event: message");
      expect(text).toContain('"id":3');
    } finally {
      await handle.close();
    }
  });

  test("rejects JSON-RPC batch bodies like stdio", async () => {
    const handle = await startHttp({ vault }, { apiKey: "secret", host: "127.0.0.1", port: 0 });
    try {
      const res = await post(handle.url, [rpc("ping", 1)], { key: "secret" });
      const body = await responseJson(res);
      expect(body.error.code).toBe(-32600);
      expect(body.error.message).toContain("batch requests are not supported");
    } finally {
      await handle.close();
    }
  });
});
