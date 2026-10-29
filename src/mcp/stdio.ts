/**
 * Newline-delimited JSON stdio loop for the MCP server.
 *
 * Mirrors `serve_stdio` from the legacy Python implementation. The server
 * only writes JSON-RPC frames to stdout; logs go to stderr.
 *
 * ## Shutdown
 *
 * The loop had no shutdown path at all: a SIGTERM took the default
 * disposition and killed the process wherever it happened to be, which
 * for a `tools/call` is mid-dispatch with no frame written. It now shares
 * the HTTP transport's register (`./drain.ts`): a drain stops the loop at
 * a request boundary and waits for every request it has accepted - under
 * the bounded parallel reads that can be several at once, and including a
 * write still parked behind them - and only then closes the reader.
 * Nothing here handles a signal - that
 * belongs to the CLI, which owns the process (`src/cli/mcp-drain.ts`).
 */

import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

import { MCPServer, type MCPServerOptions, type MCPServerRuntimeOptions } from "./server.ts";
import { errorResponse, internalErrorResponse, type JsonRpcResponse } from "./server.ts";
import { INVALID_REQUEST, PARSE_ERROR, type JsonRpcNotification } from "./protocol.ts";
import { RequestDrain, resolveDrainDeadlineMs, type DrainOutcome } from "./drain.ts";
import { ORIGIN_CHANNEL, setOriginChannel } from "../core/origin-channel.ts";
import { TRANSPORT_REACH, type TransportReach } from "../core/graph/transport-reach.ts";

/**
 * What a stdio connection establishes about its caller.
 *
 * `local`, and the reason is the process tree rather than the protocol:
 * this transport is spoken over the stdin and stdout of a process the
 * caller started, so the caller already holds whatever filesystem access
 * that process runs with. It does NOT prove operator intent - a remote
 * host can spawn a stdio subprocess - and the alternative, minting
 * `remote` here, would take an operator's own reserved pages away from
 * their own editor and their own CLI. The limit is stated rather than
 * papered over; see `src/core/graph/transport-reach.ts`.
 */
export const STDIO_TRANSPORT_REACH: TransportReach = TRANSPORT_REACH.local;

/**
 * Any frame this transport writes: a response to a request, or a
 * notification the server sent on its own initiative (today, progress).
 */
type OutboundFrame = JsonRpcResponse | JsonRpcNotification;

/**
 * The shutdown handle for a running stdio loop.
 *
 * The same two members the HTTP handle exposes, so `src/cli/mcp-drain.ts`
 * wires one signal handler for both transports rather than one each. It
 * is handed to {@link ServeStdioOptions.onStart} rather than returned,
 * because this loop does not return until it is over.
 */
export interface StdioTransportHandle {
  readonly drain: RequestDrain;
  /** The reach this transport minted for every request it will carry. */
  readonly reach: TransportReach;
  /** Stop reading new lines, await the in-flight request, end the loop. */
  close(): Promise<DrainOutcome>;
}

export interface ServeStdioOptions {
  readonly stdin?: Readable;
  readonly stdout?: Writable;
  readonly stderr?: Writable;
  /** Defaults to `O2B_MCP_DRAIN_MS`, and to ten seconds without it. */
  readonly drainDeadlineMs?: number;
  /** Called once the loop is live, with the handle that shuts it down. */
  readonly onStart?: (handle: StdioTransportHandle) => void;
  /**
   * Dispatch against this server instead of the one the loop builds.
   *
   * The loop still claims the origin channel, reads the stream and
   * writes every frame; a caller passing a server owns everything else
   * about it - its `sendNotification` wiring and its reach (tests, which
   * need handlers they can hold and release). Production callers leave
   * this unset: the built server is how the transport facts get set
   * after the caller's options, and no production caller can supply a
   * server that carries them.
   */
  readonly server?: MCPServer;
}

/**
 * How many read-classified requests the production loop keeps in flight
 * at once.
 *
 * A constant, not a knob: the number exists to bound this process's
 * concurrent SQLite read connections and its share of the event loop
 * under one slow read, and four answers that for every host this
 * transport runs on. The loop backpressures at the cap - it does not
 * read another line until a slot frees - so the bound holds by
 * construction, not by cooperation. Writes never consume a slot: they
 * run alone behind the write gate below.
 */
export const STDIO_READ_CONCURRENCY = 4;

/**
 * The in-loop write gate: a FIFO async mutex every write-classified
 * dispatch passes through.
 *
 * Dispatch-only by design rule: the gate lives HERE, in the transport
 * loop, never inside a core handler - `brain_write_batch` composes write
 * kernels, so a lower-level lock would self-block the one caller that
 * most needs writes to work. One write runs at a time (FIFO, in arrival
 * order), and - because the same loop is the only reader - the loop does
 * not read another line until the write it dispatched has settled, so no
 * read starts beside a running write either; the gate's dispatch body
 * additionally waits for the reads already in flight to settle first.
 * Cross-request frame order is thereby surrendered in one direction
 * only: reads may complete and be written out of arrival order, which is
 * JSON-RPC-legal, while every write keeps its arrival order and runs
 * exclusively. Clients correlate out-of-order responses by id and
 * interleaved progress by progress token.
 */
class WriteGate {
  #tail: Promise<void> = Promise.resolve();

  run(body: () => Promise<void>): Promise<void> {
    const run = this.#tail.then(body);
    this.#tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

/**
 * Stream-based stdio loop. Resolves to 0 on normal EOF.
 *
 * The implementation reads line-by-line and dispatches each line as a
 * JSON-RPC request. Invalid JSON yields a `-32700` parse-error response;
 * batch requests (an array at the top level) yield a `-32600` invalid-request
 * response, matching the 2025-06-18 spec which removed batch support.
 *
 * Reads (everything `MCPServer.classifiesWrite` declines) are dispatched
 * without being awaited, up to {@link STDIO_READ_CONCURRENCY} in flight;
 * the loop backpressures on a free slot before reading further lines.
 * Writes run one at a time through {@link WriteGate}. Every response is
 * written inside its own drain window: a read is tracked from its
 * dispatch, a write from its ACCEPTANCE - before it parks behind the
 * gate - so a drain that starts while the write is parked waits for it,
 * and no request is marked finished before its answer frame is queued.
 */
export async function serveStdio(
  ctx: MCPServerOptions,
  ioOpts: ServeStdioOptions = {},
  runtimeOpts: MCPServerRuntimeOptions = {},
): Promise<number> {
  // This process serves MCP tool calls, so it claims the `mcp-tool`
  // origin channel for every record written under it (Unit C). Claimed at
  // the TRANSPORT and not in the `MCPServer` constructor: `o2b tool-call`
  // and the MCP probe build a server to invoke a handler from a shell, and
  // stamping those `mcp-tool` would name a transport that carried nothing.
  // Redundant when `o2b mcp` started us - it claimed the same value - and
  // load-bearing when a host embeds this transport directly.
  setOriginChannel(ORIGIN_CHANNEL.mcpTool);
  const stdin = ioOpts.stdin ?? process.stdin;
  const stdout = ioOpts.stdout ?? process.stdout;
  // This transport owns a duplex stream, so it CAN write a frame nobody
  // asked for - which is what lets a `tools/call` carrying a progress
  // token be answered with live notifications instead of a refusal. Set
  // after the caller's options so a transport fact cannot be overridden
  // by a runtime option. The test-supplyable `ioOpts.server` bypasses
  // this constructor on purpose; see its docblock.
  const server =
    ioOpts.server ??
    new MCPServer(ctx, {
      ...runtimeOpts,
      sendNotification: (notification) => writeFrame(stdout, notification),
      // A transport fact, so it is set after the caller's options for the
      // same reason `sendNotification` is: a runtime option must not be
      // able to claim a reach this transport did not establish.
      reach: STDIO_TRANSPORT_REACH,
    });
  const rl = createInterface({ input: stdin, crlfDelay: Infinity });

  const drain = new RequestDrain();
  const deadlineMs = ioOpts.drainDeadlineMs ?? resolveDrainDeadlineMs(process.env);
  ioOpts.onStart?.({
    drain,
    reach: STDIO_TRANSPORT_REACH,
    close: async () => {
      // The wait comes first and the reader is closed after it: closing
      // the interface while a `tools/call` is still running would end the
      // loop before its response frame was written, which is the stdio
      // shape of the truncated HTTP response this unit removes. The
      // register holds every dispatched request - parallel reads included
      // - so this wait covers the whole in-flight set.
      const outcome = await drain.drain(deadlineMs);
      rl.close();
      return outcome;
    },
  });

  // One dispatch, read or write alike: the response write stays INSIDE
  // the tracked window, so a request is never marked finished before its
  // frame is queued (the drain could otherwise end the loop between the
  // dispatch and the answer). The window's `finish` is handed in rather
  // than opened here because the two paths open it at different moments:
  // a read at its dispatch, a WRITE at its acceptance - before it parks
  // behind the gate - so a drain that starts while the write is parked
  // already sees it (see dispatchWrite).
  const dispatch = async (request: Record<string, unknown>, finish: () => void): Promise<void> => {
    try {
      const response = await server.handleRequest(request);
      if (response !== null) writeFrame(stdout, response);
    } catch (exc) {
      // A dispatch failure still answers its id. An unanswered request is
      // worse than a failed one - the caller waits for a correlation that
      // never arrives - so the catch frames the error here rather than
      // letting the rejection escape into the bookkeeping below. The
      // dispatcher's own INTERNAL_ERROR builder, the same framing the
      // HTTP catch-all uses: the prose goes through the redactor for this
      // transport's reach, and the code comes from the classifier.
      writeFrame(stdout, internalErrorResponse(request["id"], exc, server.vault, server.reach));
    } finally {
      finish();
    }
  };

  // The read path. `readsInFlight` is the slot count; the loop is the
  // only reader, so the single-waiter `slotFreed` release is enough.
  const readPromises = new Set<Promise<void>>();
  let readsInFlight = 0;
  let slotFreed: (() => void) | null = null;
  const dispatchRead = (request: Record<string, unknown>): void => {
    // Swallowed ONCE, here, and every hook below derived from the
    // swallow. Deriving the bookkeeping from the RAW promise - a bare
    // `void run.finally(...)` beside a swallowed `run` - creates a SECOND
    // promise that rejects when `run` does, and voiding it leaves an
    // unhandled rejection the runtime kills the process for, while the
    // request it belongs to never sees an error frame. The set holds the
    // settled twin, so every `Promise.all` over it (the write gate's
    // wait, this loop's exit barrier) stays rejection-free by
    // construction.
    const run = dispatch(request, drain.begin(requestLabel(request))).then(
      () => undefined,
      () => undefined,
    );
    readPromises.add(run);
    readsInFlight++;
    void run.finally(() => {
      readsInFlight--;
      readPromises.delete(run);
      slotFreed?.();
      slotFreed = null;
    });
  };

  // The write path. The loop awaits each write, so one write is in
  // flight at a time and no further line is read until it settles; the
  // gate is the FIFO order, and its body first waits out the reads that
  // were already running when the write arrived.
  const writeGate = new WriteGate();
  const writePromises = new Set<Promise<void>>();
  const dispatchWrite = (request: Record<string, unknown>): Promise<void> => {
    // The drain window opens at ACCEPTANCE, not when the write finally
    // dispatches. A write that arrives while reads are in flight parks in
    // the gate body below until they settle, and a write left unregistered
    // through that park was invisible to a drain: a SIGTERM in the window
    // watched the reads empty the register, resolved `drained`, and the
    // CLI exited - leaving the write to run afterward, its mutation landed
    // with no response ever delivered. Begun here, the write holds the
    // drain open from the moment the loop accepted it and is named in a
    // deadline report that beats it; `finish` is idempotent, and the
    // window closes when the response frame is written, inside `dispatch`.
    const finish = drain.begin(requestLabel(request));
    // Swallowed once, for the same reason the read path swallows: the
    // gate body can only settle cleanly when every promise it waits on
    // does, and the loop awaits this twin - a rejection here would fall
    // out of the `for await` and kill the loop a framed error already
    // answered for.
    const run = writeGate
      .run(async () => {
        while (readPromises.size > 0) {
          await Promise.all(readPromises);
        }
        await dispatch(request, finish);
      })
      .then(
        () => undefined,
        () => undefined,
      );
    writePromises.add(run);
    void run.finally(() => {
      writePromises.delete(run);
    });
    return run;
  };

  // EOF, a drain break and `rl.close()` all leave this loop only after
  // every dispatched request has settled: the exit hooks that run after
  // `serveStdio` returns (the search store WAL checkpoint, the
  // sync-lockfile unlink) must never run under floating handlers.
  try {
    readLoop: for await (const rawLine of rl) {
      // Stopped accepting. A line that arrives after a drain has started
      // is left unread rather than answered with an error frame: the
      // client is being disconnected either way, and a half-served
      // shutdown that replies to some requests and not others is harder
      // to reason about than one that stops cleanly at a request
      // boundary.
      if (drain.draining) break;
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
      const record = request as Record<string, unknown>;
      if (server.classifiesWrite(record)) {
        // oxlint-disable-next-line no-await-in-loop -- the await IS the write gate: no new line is read while a write runs
        await dispatchWrite(record);
      } else {
        while (readsInFlight >= STDIO_READ_CONCURRENCY) {
          // oxlint-disable-next-line no-await-in-loop -- backpressure: hold at the cap before reading further lines
          await new Promise<void>((resolve) => {
            slotFreed = resolve;
          });
          // The park sits between the drain-break check above and the
          // dispatch below, so the boundary is re-checked once it is
          // over: this line was read BEFORE the drain began, but it was
          // held behind a full cap, and dispatching it after the drain
          // resolved would serve it outside the drain's wait - past
          // `rl.close()`, where the client may have stopped reading. So
          // it is left unread, under the same rule the check at the top
          // of the loop states: a line that arrives after a drain has
          // started is not answered.
          if (drain.draining) break readLoop;
        }
        dispatchRead(record);
      }
    }
  } finally {
    await Promise.all([...readPromises, ...writePromises]);
  }
  return 0;
}

/** How one in-flight stdio request is named in a drain report. */
function requestLabel(request: Record<string, unknown>): string {
  const method = typeof request["method"] === "string" ? request["method"] : "(no method)";
  const id = request["id"];
  return id === undefined ? method : `${method} (id ${JSON.stringify(id)})`;
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
    reach: STDIO_TRANSPORT_REACH,
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
    // Sequential on purpose, and not because the transport serializes -
    // the production loop does not. This harness collects its frames
    // positionally: a test that writes "initialize, then tools/call"
    // reads the answers back by index, and running the calls in parallel
    // would shuffle collected frames whose whole meaning is their
    // position. Concurrency semantics belong to {@link serveStdio} and
    // its suite; this loop stays the deterministic harness.
    // oxlint-disable-next-line no-await-in-loop
    const response = await server.handleRequest(request as Record<string, unknown>);
    if (response !== null) out.push(frameLine(response));
  }
  return out.join("\n") + (out.length > 0 ? "\n" : "");
}
