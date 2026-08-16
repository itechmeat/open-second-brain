/**
 * Streamable HTTP transport for the MCP server.
 *
 * This stays transport-only: every accepted JSON-RPC request is dispatched
 * through MCPServer.handleRequest, the same core used by stdio.
 *
 * ## Shutdown
 *
 * `close` used to be a bare `server.close()`. That stops the listener and
 * returns; it does not wait for anything, and the promise this module's
 * own request callback returns is floated, so a shutdown landing during a
 * tool call answered it with a dead socket. {@link HttpServerHandle.close}
 * now drains: it stops accepting NEW MCP work, keeps answering `/health`
 * so a supervisor can watch it happen, waits for the in-flight requests to
 * a bounded deadline, and only then shuts the listener down. The listener
 * outliving the refusal is deliberate - "stopped accepting" is about
 * requests, and a `/health` that answers `connection refused` tells a
 * supervisor nothing about which state it is in.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import type { Socket } from "node:net";
import type { Writable } from "node:stream";

import { MCPServer, type MCPServerOptions, type MCPServerRuntimeOptions } from "./server.ts";
import { errorResponse, type JsonRpcResponse } from "./server.ts";
import { INTERNAL_ERROR, INVALID_REQUEST, PARSE_ERROR } from "./protocol.ts";
import { DRAIN_STATE, RequestDrain, resolveDrainDeadlineMs, type DrainOutcome } from "./drain.ts";

export interface ServeHttpOptions {
  readonly host?: string;
  readonly port?: number;
  readonly apiKey?: string | null;
  readonly stderr?: Writable;
  /**
   * How long {@link HttpServerHandle.close} waits for in-flight requests.
   * Defaults to `O2B_MCP_DRAIN_MS`, and to ten seconds without it.
   */
  readonly drainDeadlineMs?: number;
}

export interface HttpServerHandle {
  readonly server: Server;
  readonly host: string;
  readonly port: number;
  readonly url: string;
  /** The in-flight register, so a caller can report what is running. */
  readonly drain: RequestDrain;
  /**
   * Stop accepting, await the in-flight requests to the deadline, close.
   * Returns what happened, including any request the deadline abandoned.
   */
  close(): Promise<DrainOutcome>;
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
  const drain = new RequestDrain();
  const deadlineMs = opts.drainDeadlineMs ?? resolveDrainDeadlineMs(process.env);
  const server = createServer(async (req, res) => {
    // Registered here rather than inside the handler so the whole
    // request - header parsing, body read, dispatch, response write - is
    // inside the window a drain waits for. `finish` runs on `close`
    // rather than on the handler returning: a client that walks away
    // mid-body leaves the handler parked forever, and a drain waiting on
    // it would sit out its whole deadline for a request nobody wants.
    // The health probe is an OBSERVATION of the drain, not work it waits
    // for: counting it would make the number a supervisor reads include
    // the act of reading it, and a probe arriving as the last request
    // finishes would restart the wait it was checking on.
    // A request that arrives once the drain has started is not work
    // either - it is refused with a 503 below and never dispatched - and
    // counting it let a client retrying in a tight loop keep the register
    // non-empty, holding the shutdown open to its whole deadline over
    // requests the server had already declined to do.
    const untracked = isHealthProbe(req) || drain.draining;
    const finish = untracked ? NOTHING_TO_FINISH : drain.begin(requestLabel(req));
    // On `close` rather than on the handler returning, because that is
    // when the response has actually left: a request counted as finished
    // while its bytes are still queued lets the drain proceed to
    // `closeIdleConnections` over a socket that is not idle yet, and the
    // shutdown then waits for a client that is waiting for it.
    res.on("close", finish);
    try {
      await handleHttpRequest(mcp, apiKey, host, drain, req, res);
    } catch (exc) {
      // This promise used to be floated. A throw from the dispatch left
      // the socket open with no response on it and no record anywhere;
      // the client waited until its own timeout for a request the server
      // had already given up on.
      if (!res.headersSent) {
        writeJson(res, errorResponse(null, INTERNAL_ERROR, (exc as Error).message));
      } else {
        res.end();
      }
    }
  });
  // Every accepted socket, tracked so an expired drain can actually drop
  // what it gave up on. `server.closeAllConnections()` is the documented
  // way to do that and, measured on this runtime, does NOT reach a socket
  // parked mid-body: the request stays open, `server.close` never calls
  // back, and a shutdown that promised a bounded deadline waits forever.
  // The set is the fallback that makes the deadline real.
  const sockets = new Set<Socket>();
  server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
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
    drain,
    close: () => closeHttp(server, drain, deadlineMs, sockets),
  };
}

/** How one in-flight request is named in a drain report. */
function requestLabel(req: IncomingMessage): string {
  return `${req.method ?? "?"} ${requestPath(req)}`;
}

function requestPath(req: IncomingMessage): string {
  return (req.url ?? "/").split("?")[0] ?? "/";
}

/** The unauthenticated liveness probe, recognised before anything is counted. */
const HEALTH_PATH = "/health";

function isHealthProbe(req: IncomingMessage): boolean {
  return req.method === "GET" && requestPath(req) === HEALTH_PATH;
}

/** The finish for a request the drain does not track. */
const NOTHING_TO_FINISH = (): void => {};

/**
 * Drain, then shut the listener.
 *
 * The order matters and the connection handling is the part that is easy
 * to get wrong. `server.close()` refuses new CONNECTIONS but resolves
 * only once every existing socket is gone, and HTTP keep-alive means an
 * answered request leaves its socket open - so closing without touching
 * the idle ones hangs until the client happens to disconnect.
 * `closeIdleConnections` releases exactly those. Sockets still carrying
 * an abandoned request are dropped only after the deadline has expired,
 * and the outcome returned here still names those requests so the caller
 * can report them rather than dropping them silently.
 */
async function closeHttp(
  server: Server,
  drain: RequestDrain,
  deadlineMs: number,
  sockets: ReadonlySet<Socket>,
): Promise<DrainOutcome> {
  const outcome = await drain.drain(deadlineMs);
  const closed = new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  server.closeIdleConnections();
  if (outcome.state === DRAIN_STATE.deadlineExpired) {
    for (const socket of sockets) socket.destroy();
  }
  await closed;
  return outcome;
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
  drain: RequestDrain,
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

  // Health endpoint: an unauthenticated liveness probe (still behind the Host
  // guard), so a supervisor can check the transport without a bearer.
  if (isHealthProbe(req)) {
    // Three fields rather than one, because a supervisor's next action
    // differs per state: `ok` keep going, `draining` stop sending work
    // and wait, and the count says how long that wait has left in it.
    // The health probe itself is never refused during a drain - a
    // shutdown a supervisor cannot observe is a shutdown it will report
    // as a crash. The drain counts this request like any other; it
    // answers within the same tick, so it never holds one open.
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        status: drain.draining ? DRAIN_STATE.draining : "ok",
        transport: "http",
        in_flight: drain.inFlight,
      }) + "\n",
    );
    return;
  }

  // Stopped accepting. The listener is deliberately still up (see the
  // module docblock), so this is where "no more work" is actually said,
  // and it is said with a code a client retries rather than one it reads
  // as a protocol error.
  if (drain.draining) {
    res.writeHead(503, {
      "content-type": "text/plain; charset=utf-8",
      connection: "close",
      "retry-after": "1",
    });
    res.end("Service Unavailable: the MCP transport is shutting down\n");
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
  // No `mcp-session-id`. The header is a promise of per-session state, and
  // this transport has none: one MCPServer instance serves every request
  // (see `startHttp`), identity and scope are process-global, and the id
  // that used to be minted here was never read back on any later request.
  // A client that received it would be entitled to expect the server to
  // recognise it - and to be told 404 once it expired - so advertising one
  // was a claim nothing behind it could honour.
  const accept = String(req.headers.accept ?? "");
  if (accept.includes("text/event-stream")) writeSse(res, response);
  else writeJson(res, response);
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

function writeJson(res: ServerResponse, response: JsonRpcResponse): void {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(response));
}

function writeSse(res: ServerResponse, response: JsonRpcResponse): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
  });
  res.end(`event: message\ndata: ${JSON.stringify(response)}\n\n`);
}
