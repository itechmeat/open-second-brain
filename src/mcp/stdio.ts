/**
 * Newline-delimited JSON stdio loop for the MCP server.
 *
 * Mirrors `serve_stdio` from the legacy Python implementation. The server
 * only writes JSON-RPC frames to stdout; logs go to stderr.
 */

import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

import { MCPServer, type MCPServerOptions, type MCPServerRuntimeOptions } from "./server.ts";
import { errorResponse, type JsonRpcResponse } from "./server.ts";
import { INVALID_REQUEST, PARSE_ERROR } from "./protocol.ts";

export interface ServeStdioOptions {
  readonly stdin?: Readable;
  readonly stdout?: Writable;
  readonly stderr?: Writable;
}

/**
 * Stream-based stdio loop. Resolves to 0 on normal EOF.
 *
 * The implementation reads line-by-line and dispatches each line as a
 * JSON-RPC request. Invalid JSON yields a `-32700` parse-error response;
 * batch requests (an array at the top level) yield a `-32600` invalid-request
 * response, matching the 2025-06-18 spec which removed batch support.
 */
export async function serveStdio(
  ctx: MCPServerOptions,
  ioOpts: ServeStdioOptions = {},
  runtimeOpts: MCPServerRuntimeOptions = {},
): Promise<number> {
  const server = new MCPServer(ctx, runtimeOpts);
  const stdin = ioOpts.stdin ?? process.stdin;
  const stdout = ioOpts.stdout ?? process.stdout;
  const rl = createInterface({ input: stdin, crlfDelay: Infinity });

  for await (const rawLine of rl) {
    const line = rawLine.trim();
    if (!line) continue;
    let request: unknown;
    try {
      request = JSON.parse(line);
    } catch (exc) {
      writeFrame(stdout, errorResponse(null, PARSE_ERROR, `invalid JSON: ${(exc as Error).message}`));
      continue;
    }
    if (Array.isArray(request)) {
      writeFrame(
        stdout,
        errorResponse(null, INVALID_REQUEST, "batch requests are not supported by the 2025-06-18 spec"),
      );
      continue;
    }
    if (typeof request !== "object" || request === null) {
      writeFrame(stdout, errorResponse(null, INVALID_REQUEST, "request must be an object"));
      continue;
    }
    const response = await server.handleRequest(request as Record<string, unknown>);
    if (response !== null) writeFrame(stdout, response);
  }
  return 0;
}

function writeFrame(out: Writable, response: JsonRpcResponse): void {
  let line = JSON.stringify(response);
  if (line.includes("\n")) line = line.replace(/\n/g, " ");
  out.write(line + "\n");
}

/**
 * Synchronous-style serveStdio fallback for embedded test harnesses that pass
 * an in-memory string buffer instead of a real stream. Tests use this to
 * bypass the readline async iteration.
 *
 * Returns newline-joined output (one JSON-RPC frame per line, trailing newline).
 */
export async function serveStdioFromString(
  ctx: MCPServerOptions,
  input: string,
  opts: MCPServerRuntimeOptions = {},
): Promise<string> {
  const server = new MCPServer(ctx, opts);
  const out: string[] = [];
  for (const rawLine of input.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    let request: unknown;
    try {
      request = JSON.parse(line);
    } catch (exc) {
      out.push(JSON.stringify(errorResponse(null, PARSE_ERROR, `invalid JSON: ${(exc as Error).message}`)));
      continue;
    }
    if (Array.isArray(request)) {
      out.push(
        JSON.stringify(
          errorResponse(null, INVALID_REQUEST, "batch requests are not supported by the 2025-06-18 spec"),
        ),
      );
      continue;
    }
    if (typeof request !== "object" || request === null) {
      out.push(JSON.stringify(errorResponse(null, INVALID_REQUEST, "request must be an object")));
      continue;
    }
    const response = await server.handleRequest(request as Record<string, unknown>);
    if (response !== null) out.push(JSON.stringify(response));
  }
  return out.join("\n") + (out.length > 0 ? "\n" : "");
}
