import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JSONRPC_VERSION, PROTOCOL_VERSION, startHttp } from "../../src/mcp/index.ts";

interface RawResponse {
  readonly status: number;
  readonly body: string;
}

/**
 * Raw HTTP request with fully-controllable headers (fetch forbids overriding
 * Host). Used to exercise the DNS-rebinding guard.
 */
function rawRequest(
  url: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<RawResponse> {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        method: opts.method ?? "GET",
        headers: opts.headers ?? {},
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

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
  test("refuses to bind a non-loopback host without an API key", async () => {
    await expect(startHttp({ vault }, { host: "0.0.0.0", port: 0 })).rejects.toThrow(/api-key/i);
  });

  test("starts on loopback without an API key (guards are the baseline)", async () => {
    const handle = await startHttp({ vault }, { host: "127.0.0.1", port: 0 });
    try {
      const res = await post(
        handle.url,
        rpc("initialize", 1, { protocolVersion: PROTOCOL_VERSION, capabilities: {} }),
      );
      expect(res.status).toBe(200);
      const body = await responseJson(res);
      expect(body.result.protocolVersion).toBe(PROTOCOL_VERSION);
    } finally {
      await handle.close();
    }
  });

  test("GET /health returns 200 without a bearer", async () => {
    const handle = await startHttp({ vault }, { apiKey: "secret", host: "127.0.0.1", port: 0 });
    try {
      const res = await rawRequest(`${handle.url}/health`, { method: "GET" });
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body).status).toBe("ok");
    } finally {
      await handle.close();
    }
  });

  test("rejects a mismatched Host header (DNS-rebinding guard)", async () => {
    const handle = await startHttp({ vault }, { apiKey: "secret", host: "127.0.0.1", port: 0 });
    try {
      const res = await rawRequest(handle.url, {
        method: "POST",
        headers: { host: "evil.example.com", "content-type": "application/json" },
        body: JSON.stringify(rpc("ping", 1)),
      });
      expect(res.status).toBe(403);
      expect(res.body).toContain("Host not allowed");
    } finally {
      await handle.close();
    }
  });

  test("rejects a cross-origin Origin header", async () => {
    const handle = await startHttp({ vault }, { apiKey: "secret", host: "127.0.0.1", port: 0 });
    try {
      const res = await rawRequest(handle.url, {
        method: "POST",
        headers: {
          host: `127.0.0.1:${handle.port}`,
          origin: "http://evil.example.com",
          authorization: "Bearer secret",
          "content-type": "application/json",
        },
        body: JSON.stringify(rpc("ping", 1)),
      });
      expect(res.status).toBe(403);
      expect(res.body).toContain("Origin not allowed");
    } finally {
      await handle.close();
    }
  });

  test("a non-loopback (0.0.0.0) bind accepts the machine's real Host/Origin", async () => {
    // Binding a wildcard is an explicit network exposure gated by the mandatory
    // bearer; the DNS-rebinding Host/Origin guard (a loopback-only concern)
    // must not reject the machine's real IP / DNS Host, which would make
    // 0.0.0.0 unusable. We connect over loopback but present a foreign Host.
    const handle = await startHttp({ vault }, { apiKey: "secret", host: "0.0.0.0", port: 0 });
    try {
      const res = await rawRequest(`http://127.0.0.1:${handle.port}`, {
        method: "POST",
        headers: {
          host: "box.internal.example",
          origin: "http://box.internal.example",
          authorization: "Bearer secret",
          "content-type": "application/json",
        },
        body: JSON.stringify(rpc("ping", 1)),
      });
      expect(res.status).toBe(200);
    } finally {
      await handle.close();
    }
  });

  test("a non-loopback bind still enforces the bearer", async () => {
    const handle = await startHttp({ vault }, { apiKey: "secret", host: "0.0.0.0", port: 0 });
    try {
      const res = await rawRequest(`http://127.0.0.1:${handle.port}`, {
        method: "POST",
        headers: { host: "box.internal.example", "content-type": "application/json" },
        body: JSON.stringify(rpc("ping", 1)),
      });
      expect(res.status).toBe(401);
    } finally {
      await handle.close();
    }
  });

  test("accepts a loopback Origin", async () => {
    const handle = await startHttp({ vault }, { apiKey: "secret", host: "127.0.0.1", port: 0 });
    try {
      const res = await rawRequest(handle.url, {
        method: "POST",
        headers: {
          host: `127.0.0.1:${handle.port}`,
          origin: `http://127.0.0.1:${handle.port}`,
          authorization: "Bearer secret",
          "content-type": "application/json",
        },
        body: JSON.stringify(rpc("ping", 1)),
      });
      expect(res.status).toBe(200);
    } finally {
      await handle.close();
    }
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
