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
import { INVALID_REQUEST, PARSE_ERROR, type JsonRpcNotification } from "./protocol.ts";

/**
 * Any frame this transport writes: a response to a request, or a
 * notification the server sent on its own initiative (today, progress).
 */
type OutboundFrame = JsonRpcResponse | JsonRpcNotification;

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
  const stdin = ioOpts.stdin ?? process.stdin;
  const stdout = ioOpts.stdout ?? process.stdout;
  // This transport owns a duplex stream, so it CAN write a frame nobody
  // asked for - which is what lets a `tools/call` carrying a progress
  // token be answered with live notifications instead of a refusal. Set
  // after the caller's options so a transport fact cannot be overridden
  // by a runtime option.
  const server = new MCPServer(ctx, {
    ...runtimeOpts,
    sendNotification: (notification) => writeFrame(stdout, notification),
  });
  const rl = createInterface({ input: stdin, crlfDelay: Infinity });

  for await (const rawLine of rl) {
    const line = rawLine.trim();
    if (!line) continue;
    let request: unknown;
    try {
      request = JSON.parse(line);
    } catch (exc) {
      writeFrame(
        stdout,
        errorResponse(null, PARSE_ERROR, `invalid JSON: ${(exc as Error).message}`),
      );
      continue;
    }
    if (Array.isArray(request)) {
      writeFrame(
        stdout,
        errorResponse(
          null,
          INVALID_REQUEST,
          "batch requests are not supported by the 2025-06-18 spec",
        ),
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

/**
 * One frame as the single line this protocol delimits by.
 *
 * Shared by both loops below so a notification and a response are framed
 * by identical code: the format is the contract, and two copies of it
 * could drift apart the moment one of them gained a case.
 */
function frameLine(frame: OutboundFrame): string {
  const line = JSON.stringify(frame);
  return line.includes("\n") ? line.replace(/\n/g, " ") : line;
}

/**
 * Write one frame in ONE `write` call, terminator included.
 *
 * That single call is what keeps a progress notification from landing
 * inside a response: `Writable.write` appends the whole string to the
 * stream's queue atomically, so no other frame can be spliced between a
 * frame's body and its newline.
 */
function writeFrame(out: Writable, frame: OutboundFrame): void {
  out.write(frameLine(frame) + "\n");
}

/**
 * Synchronous-style serveStdio fallback for embedded test harnesses that pass
 * an in-memory string buffer instead of a real stream. Tests use this to
 * bypass the readline async iteration.
 *
 * Returns newline-joined output (one JSON-RPC frame per line, trailing newline).
 *
 * It carries notifications on the same terms as the real loop, and
 * frames them through the same {@link frameLine}: a harness that dropped
 * the unsolicited frames would report the progress feature as absent
 * wherever it is used, which is the failure mode this release is about.
 */
export async function serveStdioFromString(
  ctx: MCPServerOptions,
  input: string,
  opts: MCPServerRuntimeOptions = {},
): Promise<string> {
  const out: string[] = [];
  const server = new MCPServer(ctx, {
    ...opts,
    sendNotification: (notification) => out.push(frameLine(notification)),
  });
  for (const rawLine of input.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    let request: unknown;
    try {
      request = JSON.parse(line);
    } catch (exc) {
      out.push(
        frameLine(errorResponse(null, PARSE_ERROR, `invalid JSON: ${(exc as Error).message}`)),
      );
      continue;
    }
    if (Array.isArray(request)) {
      out.push(
        frameLine(
          errorResponse(
            null,
            INVALID_REQUEST,
            "batch requests are not supported by the 2025-06-18 spec",
          ),
        ),
      );
      continue;
    }
    if (typeof request !== "object" || request === null) {
      out.push(frameLine(errorResponse(null, INVALID_REQUEST, "request must be an object")));
      continue;
    }
    // Sequential on purpose, and not a candidate for `Promise.all`: the
    // frames this loop collects are ordered, and a request that emits
    // progress must have its notifications land between its predecessor's
    // response and its own. Running the calls in parallel would shuffle
    // them.
    // oxlint-disable-next-line no-await-in-loop
    const response = await server.handleRequest(request as Record<string, unknown>);
    if (response !== null) out.push(frameLine(response));
  }
  return out.join("\n") + (out.length > 0 ? "\n" : "");
}
