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

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { serveStdio, STDIO_READ_CONCURRENCY } from "../../src/mcp/stdio.ts";
import { MCPServer, type JsonRpcRequest, type JsonRpcResponse } from "../../src/mcp/server.ts";
import { JSONRPC_VERSION } from "../../src/mcp/protocol.ts";

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
function startScripted(): {
  loop: Promise<number>;
  server: ScriptedServer;
  stdin: PassThrough;
  frames: () => string[];
} {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const chunks: string[] = [];
  stdout.on("data", (c: Buffer) => chunks.push(c.toString("utf8")));
  const server = new ScriptedServer({ vault: tempVault() });
  const loop = serveStdio({ vault: server.vault }, { stdin, stdout, server });
  return { loop, server, stdin, frames: () => chunks.join("").split("\n").filter(Boolean) };
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
});
