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
  if (apiKey === null || apiKey === "") {
    throw new Error("HTTP MCP transport requires --api-key");
  }
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 0;
  const mcp = new MCPServer(ctx, runtimeOpts);
  const server = createServer(async (req, res) => {
    await handleHttpRequest(mcp, apiKey, req, res);
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
  apiKey: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!authorized(req, apiKey)) {
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
