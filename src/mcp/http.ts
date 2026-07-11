/**
 * Streamable HTTP transport for the MCP server.
 *
 * This stays transport-only: every accepted JSON-RPC request is dispatched
 * through MCPServer.handleRequest, the same core used by stdio.
 */

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import type { Writable } from "node:stream";

import { MCPServer, type MCPServerOptions, type MCPServerRuntimeOptions } from "./server.ts";
import { errorResponse, type JsonRpcResponse } from "./server.ts";
import { INVALID_REQUEST, PARSE_ERROR } from "./protocol.ts";

export interface ServeHttpOptions {
  readonly host?: string;
  readonly port?: number;
  readonly apiKey?: string | null;
  readonly stderr?: Writable;
}

export interface HttpServerHandle {
  readonly server: Server;
  readonly host: string;
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
}

const MAX_BODY_BYTES = 1024 * 1024;

export async function startHttp(
  ctx: MCPServerOptions,
  opts: ServeHttpOptions = {},
  runtimeOpts: MCPServerRuntimeOptions = {},
): Promise<HttpServerHandle> {
  const apiKey = opts.apiKey ?? null;
  const host = opts.host ?? "127.0.0.1";
  // Safe by default: on the loopback default a bearer is optional (the
  // loopback bind + Host/Origin rebinding guard are the baseline defence).
  // Binding to a NON-loopback interface exposes the Brain on the network, so
  // a bearer is mandatory there - no permissive fallback.
  if (!isLoopbackHost(host) && (apiKey === null || apiKey === "")) {
    throw new Error(
      "HTTP MCP transport bound to a non-loopback host requires --api-key " +
        `(host=${host}); refusing to expose an unauthenticated endpoint on the network`,
    );
  }
  const port = opts.port ?? 0;
  const mcp = new MCPServer(ctx, runtimeOpts);
  const server = createServer(async (req, res) => {
    await handleHttpRequest(mcp, apiKey, host, req, res);
  });
  server.listen(port, host);
  await once(server, "listening");
  const addr = server.address();
  const actualPort = typeof addr === "object" && addr !== null ? addr.port : port;
  return {
    server,
    host,
    port: actualPort,
    url: `http://${host}:${actualPort}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

export async function serveHttp(
  ctx: MCPServerOptions,
  opts: ServeHttpOptions = {},
  runtimeOpts: MCPServerRuntimeOptions = {},
): Promise<number> {
  const handle = await startHttp(ctx, opts, runtimeOpts);
  await once(handle.server, "close");
  return 0;
}

async function handleHttpRequest(
  mcp: MCPServer,
  apiKey: string | null,
  boundHost: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  // DNS-rebinding guard (always enforced, never bypassable): a malicious web
  // page that resolves its own domain to 127.0.0.1 still sends its Host /
  // Origin, so rejecting any non-loopback Host/Origin blocks the rebind even
  // when the socket is loopback-bound.
  if (!hostAllowed(req, boundHost)) {
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    res.end("Forbidden: Host not allowed\n");
    return;
  }
  if (!originAllowed(req, boundHost)) {
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    res.end("Forbidden: Origin not allowed\n");
    return;
  }

  const path = (req.url ?? "/").split("?")[0];

  // Health endpoint: an unauthenticated liveness probe (still behind the Host
  // guard), so a supervisor can check the transport without a bearer.
  if (req.method === "GET" && path === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", transport: "http" }) + "\n");
    return;
  }

  // Bearer is optional on loopback (guards are the baseline) but enforced when
  // configured; a non-loopback bind always has a key (see startHttp).
  if (apiKey !== null && apiKey !== "" && !authorized(req, apiKey)) {
    res.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
    res.end("Unauthorized\n");
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(405, { allow: "POST", "content-type": "text/plain; charset=utf-8" });
    res.end("Method Not Allowed\n");
    return;
  }

  let raw: string;
  try {
    raw = await readBody(req);
  } catch (exc) {
    writeJson(res, errorResponse(null, INVALID_REQUEST, (exc as Error).message));
    return;
  }

  let request: unknown;
  try {
    request = JSON.parse(raw);
  } catch (exc) {
    writeJson(res, errorResponse(null, PARSE_ERROR, `invalid JSON: ${(exc as Error).message}`));
    return;
  }
  if (Array.isArray(request)) {
    writeJson(
      res,
      errorResponse(
        null,
        INVALID_REQUEST,
        "batch requests are not supported by the 2025-06-18 spec",
      ),
    );
    return;
  }
  if (typeof request !== "object" || request === null) {
    writeJson(res, errorResponse(null, INVALID_REQUEST, "request must be an object"));
    return;
  }

  const jsonReq = request as Record<string, unknown>;
  const response = await mcp.handleRequest(jsonReq);
  if (response === null) {
    res.writeHead(204);
    res.end();
    return;
  }
  const headers: Record<string, string> = {};
  if (jsonReq["method"] === "initialize") headers["mcp-session-id"] = randomUUID();
  const accept = String(req.headers.accept ?? "");
  if (accept.includes("text/event-stream")) writeSse(res, response, headers);
  else writeJson(res, response, headers);
}

function authorized(req: IncomingMessage, apiKey: string): boolean {
  const presented = bearerToken(req.headers.authorization) ?? firstHeader(req.headers["x-api-key"]);
  if (presented === undefined) return false;
  return constantTimeEqual(presented, apiKey);
}

/** Canonical loopback host names a rebinding guard trusts. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(normaliseHostname(host));
}

/** Strip a port and IPv6 brackets, lowercase - `[::1]:8080` -> `::1`. */
function normaliseHostname(value: string): string {
  let host = value.trim().toLowerCase();
  if (host.startsWith("[")) {
    // Bracketed IPv6, optionally with :port after the bracket.
    const end = host.indexOf("]");
    return end === -1 ? host.slice(1) : host.slice(1, end);
  }
  // IPv4/hostname: drop a trailing :port (a bare IPv6 has multiple colons).
  const colon = host.indexOf(":");
  if (colon !== -1 && host.indexOf(":", colon + 1) === -1) host = host.slice(0, colon);
  return host;
}

/**
 * DNS rebinding exploits a LOOPBACK-bound server reached from a victim's
 * browser (a malicious site rebinds its own domain to 127.0.0.1). The guard is
 * therefore meaningful only for a loopback bind, where the trusted Host set is
 * the enumerable loopback names. A non-loopback bind is an explicit network
 * exposure that always carries a mandatory bearer (see startHttp), so the
 * bearer - not a Host allowlist we cannot enumerate for a wildcard bind - is
 * the auth boundary there; blocking the machine's real IP / DNS Host would
 * make `0.0.0.0` unusable. Skip the guard for non-loopback binds.
 */
function hostGuardApplies(boundHost: string): boolean {
  return isLoopbackHost(boundHost);
}

/**
 * The `Host` header must name a loopback address or the exact bound host.
 * A present-but-foreign Host is the DNS-rebinding signal and is rejected; an
 * absent Host (uncommon; not a browser rebind) is allowed.
 */
function hostAllowed(req: IncomingMessage, boundHost: string): boolean {
  if (!hostGuardApplies(boundHost)) return true;
  const host = req.headers.host;
  if (host === undefined) return true;
  const hostname = normaliseHostname(host);
  return isLoopbackHost(hostname) || hostname === normaliseHostname(boundHost);
}

/**
 * When an `Origin` is present (a browser request), its host must be loopback
 * or the bound host; a cross-origin browser request is rejected. A missing
 * Origin (non-browser client) is allowed.
 */
function originAllowed(req: IncomingMessage, boundHost: string): boolean {
  if (!hostGuardApplies(boundHost)) return true;
  const origin = firstHeader(req.headers.origin);
  if (origin === undefined || origin === "" || origin === "null") return origin !== "null";
  let hostname: string;
  try {
    hostname = new URL(origin).hostname.toLowerCase();
  } catch {
    return false;
  }
  return isLoopbackHost(hostname) || hostname === normaliseHostname(boundHost);
}

function bearerToken(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(value.trim());
  return m?.[1];
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function constantTimeEqual(a: string, b: string): boolean {
  const da = createHash("sha256").update(a).digest();
  const db = createHash("sha256").update(b).digest();
  return timingSafeEqual(da, db);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > MAX_BODY_BYTES) throw new Error("request body too large");
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function writeJson(
  res: ServerResponse,
  response: JsonRpcResponse,
  extraHeaders: Record<string, string> = {},
): void {
  res.writeHead(200, { "content-type": "application/json", ...extraHeaders });
  res.end(JSON.stringify(response));
}

function writeSse(
  res: ServerResponse,
  response: JsonRpcResponse,
  extraHeaders: Record<string, string> = {},
): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    ...extraHeaders,
  });
  res.end(`event: message\ndata: ${JSON.stringify(response)}\n\n`);
}
