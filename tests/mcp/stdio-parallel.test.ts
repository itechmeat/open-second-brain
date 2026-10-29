/**
 * Parallel reads with exclusive writes on the real stdio loop.
 *
 * The production loop used to await each request inside its `for await`
 * body, so one slow read head-of-line blocked every later request. It
 * now dispatches read-classified requests without awaiting them, up to
 * {@link STDIO_READ_CONCURRENCY} in flight, and runs every write alone:
 * a write waits for the reads already in flight to settle, and no new
 * line is read while a write is running (writes kept exclusive on the
 * stdio transport; see `src/mcp/stdio.ts`).
 *
 * The fixture is the real `serveStdio` over a real PassThrough pair
 * (the pattern from `progress-token.test.ts`), dispatching against a
 * scripted `MCPServer` subclass whose handlers the test holds and
 * releases - the controllability the HTTP drain tests get from a
 * half-sent body (`http-drain.test.ts`), which a line-delimited
 * transport cannot reproduce. The real dispatch path is covered with
 * the real table by `mcp.test.ts` and `progress-token.test.ts`; this
 * file pins the transport's concurrency invariants.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { serveStdio, STDIO_READ_CONCURRENCY } from "../../src/mcp/stdio.ts";
import { RequestDrain, type DrainOutcome } from "../../src/mcp/drain.ts";
import { MCPServer, type JsonRpcRequest, type JsonRpcResponse } from "../../src/mcp/server.ts";
import { INTERNAL_ERROR, JSONRPC_VERSION, PROTOCOL_VERSION } from "../../src/mcp/protocol.ts";
import { PROGRESS_NOTIFICATION_METHOD } from "../../src/mcp/progress.ts";
import { bootstrapBrain } from "../../src/core/brain/init.ts";

const temps: string[] = [];

afterEach(() => {
  while (temps.length > 0) rmSync(temps.pop()!, { recursive: true, force: true });
});

function tempVault(): string {
  const dir = mkdtempSync(join(tmpdir(), "osb-stdio-parallel-"));
  temps.push(dir);
  return dir;
}

/** Poll a condition the loop reaches on its own schedule, or say what failed. */
async function until(condition: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (condition()) return;
    await Bun.sleep(5);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/**
 * When a scripted handler may finish: held until the test releases the
 * id, or immediate.
 */
const RELEASES = new Map<unknown, Array<() => void>>();

/** Release one held handler. */
function release(id: unknown): void {
  const next = RELEASES.get(id)?.shift();
  if (next === undefined) throw new Error(`no held handler for id ${String(id)}`);
  next();
}

beforeEach(() => {
  // The held-handler register is module-level and the tests reuse ids
  // (1..6): a failure that leaves resolvers queued would strand every
  // LATER test's hold() behind stale entries and turn one failure into a
  // pile of 5000 ms timeouts. Each test starts from an empty register.
  RELEASES.clear();
});

/** Hold every handler until released, one `hold()` per in-flight call. */
function hold(id: unknown): Promise<void> {
  return new Promise((resolve) => {
    const queue = RELEASES.get(id) ?? [];
    queue.push(resolve);
    RELEASES.set(id, queue);
  });
}

interface LogEntry {
  readonly id: unknown;
  readonly event: "start" | "end";
  readonly write: boolean;
}

/**
 * A dispatcher the test observes and controls: every call is logged and
 * write-classified calls can be held independently of reads.
 */
class ScriptedServer extends MCPServer {
  readonly log: LogEntry[] = [];

  override async handleRequest(request: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    const write = this.classifiesWrite(request);
    this.log.push({ id: request.id, event: "start", write });
    await hold(request.id);
    this.log.push({ id: request.id, event: "end", write });
    return { jsonrpc: JSONRPC_VERSION, id: request.id, result: { echo: request.id } };
  }
}

/** One `tools/call` frame; `name` picks the read/write class. */
function call(id: number, name: string): string {
  return JSON.stringify({
    jsonrpc: JSONRPC_VERSION,
    id,
    method: "tools/call",
    params: { name, arguments: {} },
  });
}

/** The read and write names this fixture classifies through the real table. */
const READ_TOOL = "brain_search";
const WRITE_TOOL = "brain_note";

/** Start a loop over a scripted server; returns everything the test drives. */
function startScripted(opts: { drainDeadlineMs?: number } = {}): {
  loop: Promise<number>;
  server: ScriptedServer;
  stdin: PassThrough;
  frames: () => string[];
  close: () => Promise<DrainOutcome>;
} {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const chunks: string[] = [];
  stdout.on("data", (c: Buffer) => chunks.push(c.toString("utf8")));
  const server = new ScriptedServer({ vault: tempVault() });
  let drain: RequestDrain | undefined;
  const loop = serveStdio(
    { vault: server.vault },
    {
      stdin,
      stdout,
      ...(opts.drainDeadlineMs !== undefined ? { drainDeadlineMs: opts.drainDeadlineMs } : {}),
      onStart: (handle) => {
        drain = handle.drain;
      },
      server,
    },
  );
  return {
    loop,
    server,
    stdin,
    frames: () => chunks.join("").split("\n").filter(Boolean),
    // A later call with a longer deadline is how a test waits out work a
    // first drain's deadline abandoned.
    close: (deadlineMs?: number) => drain!.drain(deadlineMs ?? opts.drainDeadlineMs ?? 10_000),
  };
}

describe("stdio parallel reads", () => {
  test("a second read dispatches while a first is still in flight", async () => {
    const { loop, server, stdin } = startScripted();
    stdin.write(call(1, READ_TOOL) + "\n");
    await until(
      () => server.log.some((e) => e.id === 1 && e.event === "start"),
      "the first read to dispatch",
    );
    stdin.write(call(2, READ_TOOL) + "\n");
    // The assertion the sequential loop fails: the second read reaches
    // its handler while the first is still held.
    await until(
      () => server.log.some((e) => e.id === 2 && e.event === "start"),
      "the second read to dispatch beside the held first",
    );
    release(1);
    release(2);
    stdin.end();
    expect(await loop).toBe(0);
  });

  test("responses carry their own ids whatever order the handlers settle in", async () => {
    const { loop, server, stdin, frames } = startScripted();
    stdin.write(call(1, READ_TOOL) + "\n" + call(2, READ_TOOL) + "\n");
    await until(() => server.log.filter((e) => e.event === "start").length === 2, "both reads");
    release(2);
    await until(() => frames().length >= 1, "the first response frame");
    release(1);
    stdin.end();
    await loop;
    const ids = frames().map((f) => (JSON.parse(f) as JsonRpcResponse).id);
    expect(ids).toEqual([2, 1]);
  });

  test("in-flight reads never exceed the cap, which backpressures the loop", async () => {
    const { loop, server, stdin } = startScripted();
    const ids = [1, 2, 3, 4, 5, 6];
    for (const id of ids) stdin.write(call(id, READ_TOOL) + "\n");
    await until(
      () => server.log.filter((e) => e.event === "start").length === STDIO_READ_CONCURRENCY,
      `${STDIO_READ_CONCURRENCY} reads to dispatch`,
    );
    await Bun.sleep(25);
    // The cap held: the lines beyond it were not dispatched - and were
    // not even read, which is the backpressure.
    expect(server.log.filter((e) => e.event === "start").length).toBe(STDIO_READ_CONCURRENCY);
    release(1);
    release(2);
    await until(
      () => server.log.some((e) => e.id === 5 && e.event === "start"),
      "the fifth read to dispatch as slots free",
    );
    release(3);
    release(4);
    await until(
      () => server.log.some((e) => e.id === 6 && e.event === "start"),
      "the sixth read to dispatch",
    );
    release(5);
    release(6);
    stdin.end();
    expect(await loop).toBe(0);
  });

  test("a write waits for the reads in flight and runs alone", async () => {
    const { loop, server, stdin } = startScripted();
    stdin.write(call(1, READ_TOOL) + "\n");
    await until(
      () => server.log.some((e) => e.id === 1 && e.event === "start"),
      "the held read to dispatch",
    );
    stdin.write(call(2, WRITE_TOOL) + "\n");
    await Bun.sleep(25);
    // The write gate: the write has not started while the read is held.
    expect(server.log.some((e) => e.id === 2 && e.event === "start")).toBe(false);
    release(1);
    await until(() => server.log.some((e) => e.id === 2 && e.event === "start"), "the write");
    // No new read starts beside the write either: the loop does not read
    // another line until the write has settled.
    stdin.write(call(3, READ_TOOL) + "\n");
    await Bun.sleep(25);
    expect(server.log.some((e) => e.id === 3 && e.event === "start")).toBe(false);
    release(2);
    await until(() => server.log.some((e) => e.id === 3 && e.event === "start"), "the late read");
    release(3);
    stdin.end();
    expect(await loop).toBe(0);

    // The interleaving log, as intervals: no two dispatch intervals
    // overlap when either one is a write, and a write never overlaps a
    // write.
    const intervals = new Map<unknown, { start: number; end: number; write: boolean }>();
    server.log.forEach((e, index) => {
      if (e.event === "start") intervals.set(e.id, { start: index, end: -1, write: e.write });
      else intervals.get(e.id)!.end = index;
    });
    const all = [...intervals.entries()];
    const overlapping: Array<[unknown, unknown]> = [];
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        const [, a] = all[i]!;
        const [, b] = all[j]!;
        const disjoint = a.end < b.start || b.end < a.start;
        if (!disjoint && (a.write || b.write)) overlapping.push([all[i]![0], all[j]![0]]);
      }
    }
    expect(overlapping).toEqual([]);
  });

  test("EOF does not resolve the loop while a dispatched read is still running", async () => {
    const { loop, server, stdin } = startScripted();
    stdin.write(call(1, READ_TOOL) + "\n");
    await until(() => server.log.some((e) => e.id === 1 && e.event === "start"), "the read");
    stdin.end();
    // The loop must be pending: EOF arrived, the read is still held.
    let settled = false;
    void loop.then(() => {
      settled = true;
    });
    await Bun.sleep(25);
    expect(settled).toBe(false);
    release(1);
    expect(await loop).toBe(0);
  });

  test("EOF does not resolve the loop while a dispatched write is still running", async () => {
    const { loop, server, stdin, frames } = startScripted();
    stdin.write(call(1, WRITE_TOOL) + "\n");
    await until(() => server.log.some((e) => e.id === 1 && e.event === "start"), "the write");
    stdin.end();
    // The loop must be pending under the floating write, exactly as it is
    // under a floating read: the exit barrier covers both paths.
    let settled = false;
    void loop.then(() => {
      settled = true;
    });
    await Bun.sleep(25);
    expect(settled).toBe(false);
    // The write completes and answers before the loop resolves: its
    // response frame exists while the exit barrier is still holding.
    release(1);
    await until(() => frames().length === 1, "the write's answer");
    expect(await loop).toBe(0);
    expect(frames().length).toBe(1);
  });
});

/**
 * The frame-integrity invariants, on a real stream against the real
 * dispatch table (no scripted server): whatever the concurrency does to
 * ORDER, it must never touch FRAMES.
 */
describe("stdio frame integrity under concurrency", () => {
  function realLoop(vault: string): {
    loop: Promise<number>;
    stdin: PassThrough;
    chunks: () => string;
  } {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const collected: string[] = [];
    stdout.on("data", (c: Buffer) => collected.push(c.toString("utf8")));
    const loop = serveStdio({ vault }, { stdin, stdout });
    return { loop, stdin, chunks: () => collected.join("") };
  }

  test("every frame stays newline-terminated and parses under N concurrent calls", async () => {
    const vault = tempVault();
    bootstrapBrain(vault);
    const { loop, stdin, chunks } = realLoop(vault);
    stdin.write(
      JSON.stringify({
        jsonrpc: JSONRPC_VERSION,
        id: 0,
        method: "initialize",
        params: { protocolVersion: PROTOCOL_VERSION },
      }) + "\n",
    );
    const N = 8;
    for (let id = 1; id <= N; id++) {
      stdin.write(
        JSON.stringify({
          jsonrpc: JSONRPC_VERSION,
          id,
          method: "tools/call",
          params: { name: "second_brain_status", arguments: {} },
        }) + "\n",
      );
    }
    stdin.end();
    expect(await loop).toBe(0);

    // Frame atomicity: every write was exactly one newline-terminated
    // frame, so the joined stream splits into clean JSON lines and no
    // chunk ever ends mid-frame.
    const raw = chunks();
    for (const chunk of raw.split("\n").slice(0, -1)) {
      expect(() => JSON.parse(chunk)).not.toThrow();
    }
    const frames = raw
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as JsonRpcResponse);
    const ids = frames.map((f) => f.id).toSorted();
    expect(ids).toEqual([0, ...Array.from({ length: N }, (_, i) => i + 1)].toSorted());
    // N+1 distinct answers for N+1 requests: an id was neither lost nor
    // answered twice.
    expect(new Set(ids).size).toBe(N + 1);
  });

  test("cross-request progress interleaving is legal and adjacency holds per request", async () => {
    const vault = tempVault();
    bootstrapBrain(vault);
    const { loop, stdin, chunks } = realLoop(vault);
    const briefCall = (id: number, token: string): string =>
      JSON.stringify({
        jsonrpc: JSONRPC_VERSION,
        id,
        method: "tools/call",
        params: {
          name: "brain_brief",
          arguments: { view: "operator" },
          _meta: { progressToken: token },
        },
      });
    // Two read-classified calls issued back-to-back: both dispatch
    // concurrently on the real stream.
    stdin.write(briefCall(2, "tok-a") + "\n");
    stdin.write(briefCall(3, "tok-b") + "\n");
    await until(() => chunks().includes('"id":2'), "response 2");
    await until(() => chunks().includes('"id":3'), "response 3");
    stdin.end();
    expect(await loop).toBe(0);

    const frames = chunks()
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    // No spliced frame anywhere: the split above parsed every line
    // cleanly, which only holds when no notification was spliced inside
    // a response frame.
    // Per-request adjacency: ALL of a request's progress notifications
    // precede ITS response, whichever order the two responses arrive in.
    const indexOf = (id: number) => frames.findIndex((f) => f["id"] === id);
    const response2 = indexOf(2);
    const response3 = indexOf(3);
    expect(response2).toBeGreaterThan(-1);
    expect(response3).toBeGreaterThan(-1);
    const notifications = frames
      .map((f, i) => ({ f, i }))
      .filter(({ f }) => f["method"] === PROGRESS_NOTIFICATION_METHOD);
    expect(notifications.length).toBeGreaterThan(0);
    for (const { f, i } of notifications) {
      const token = (f["params"] as Record<string, unknown>)["progressToken"];
      expect(i).toBeLessThan(token === "tok-a" ? response2 : response3);
    }
    // Both requests were answered by their own ids, whatever the order.
    expect(new Set([frames[response2]!["id"], frames[response3]!["id"]])).toEqual(new Set([2, 3]));
  });
});

describe("the stdio drain under parallel dispatch", () => {
  test("the drain deadline names the reads it abandoned", async () => {
    const { loop, server, stdin, close } = startScripted({ drainDeadlineMs: 60 });
    stdin.write(call(1, READ_TOOL) + "\n" + call(2, READ_TOOL) + "\n");
    await until(() => server.log.filter((e) => e.event === "start").length === 2, "both reads");
    const outcome = await close();
    expect(outcome.state).toBe("deadline_expired");
    expect(outcome.abandoned.map((r) => r.label).toSorted()).toEqual([
      "tools/call (id 1)",
      "tools/call (id 2)",
    ]);
    // The abandoned reads still settle and still answer: abandoning the
    // WAIT is not dropping the work.
    release(1);
    release(2);
    stdin.end();
    expect(await loop).toBe(0);
    expect(server.log.filter((e) => e.event === "end").length).toBe(2);
  });

  test("close() resolves drained once the held reads settle, however many", async () => {
    const { loop, server, stdin, close } = startScripted({ drainDeadlineMs: 5_000 });
    stdin.write([1, 2, 3].map((id) => call(id, READ_TOOL)).join("\n") + "\n");
    await until(() => server.log.filter((e) => e.event === "start").length === 3, "all three");
    const closing = close();
    release(1);
    release(2);
    release(3);
    const outcome = await closing;
    expect(outcome.state).toBe("drained");
    expect(outcome.abandoned).toEqual([]);
    stdin.end();
    expect(await loop).toBe(0);
  });

  test("a line parked behind the read cap is left unread once a drain has started", async () => {
    const { loop, server, stdin, frames, close } = startScripted({ drainDeadlineMs: 5_000 });
    // Fill the cap and park one more line behind it: the fifth line is
    // READ by the loop, then held at the backpressure gate.
    stdin.write([1, 2, 3, 4, 5].map((id) => call(id, READ_TOOL)).join("\n") + "\n");
    await until(
      () => server.log.filter((e) => e.event === "start").length === STDIO_READ_CONCURRENCY,
      "the cap to fill",
    );
    await Bun.sleep(25);
    expect(server.log.some((e) => e.id === 5)).toBe(false);
    // Drain while the fifth line is parked. Every dispatched read is
    // released together, so the drain's register empties before the
    // parked line's wake-up runs again.
    const closing = close();
    release(1);
    release(2);
    release(3);
    release(4);
    const outcome = await closing;
    expect(outcome.state).toBe("drained");
    // Let any post-drain dispatch surface before judging.
    await Bun.sleep(25);
    // The parked line was left unread, not served outside the drain's
    // wait: no dispatch, no answer.
    expect(server.log.some((e) => e.id === 5)).toBe(false);
    expect(frames().length).toBe(STDIO_READ_CONCURRENCY);
    stdin.end();
    expect(await loop).toBe(0);
  });

  test("the drain deadline names the write it abandoned, and the write still settles", async () => {
    const { loop, server, stdin, frames, close } = startScripted({ drainDeadlineMs: 60 });
    stdin.write(call(1, WRITE_TOOL) + "\n");
    await until(() => server.log.some((e) => e.id === 1 && e.event === "start"), "the held write");
    const outcome = await close();
    // The deadline names the write it abandoned: the label is the
    // write's, so an operator reading the report knows the exclusive
    // path is what was still open.
    expect(outcome.state).toBe("deadline_expired");
    expect(outcome.abandoned.map((r) => r.label)).toEqual(["tools/call (id 1)"]);
    // Abandoning the wait is not dropping the work: released, the write
    // settles and answers, and a second drain resolves drained.
    release(1);
    await until(() => frames().length === 1, "the write's answer");
    const settled = await close(5_000);
    expect(settled.state).toBe("drained");
    expect(settled.abandoned).toEqual([]);
    stdin.end();
    expect(await loop).toBe(0);
  });
});

/**
 * A dispatcher whose every request fails: the transport, not the server,
 * owns what the caller sees when dispatch itself throws.
 */
class ExplodingServer extends MCPServer {
  override async handleRequest(): Promise<JsonRpcResponse | null> {
    throw new Error("handler exploded");
  }
}

describe("dispatch failures answer their id", () => {
  test("a rejecting handler yields a JSON-RPC error frame and the loop survives", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const chunks: string[] = [];
    stdout.on("data", (c: Buffer) => chunks.push(c.toString("utf8")));
    const server = new ExplodingServer({ vault: tempVault() });
    const loop = serveStdio({ vault: server.vault }, { stdin, stdout, server });
    stdin.write(call(7, READ_TOOL) + "\n" + call(8, READ_TOOL) + "\n");
    stdin.end();
    // The loop resolves cleanly instead of dying on the rejection.
    expect(await loop).toBe(0);
    const frames = chunks
      .join("")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as JsonRpcResponse);
    // Both requests were answered, by their own ids, with error frames.
    expect(frames.map((f) => f.id).toSorted((a, b) => Number(a) - Number(b))).toEqual([7, 8]);
    for (const frame of frames) {
      expect(frame.error?.code).toBe(INTERNAL_ERROR);
      expect(frame.error?.message).toContain("handler exploded");
    }
  });
});
