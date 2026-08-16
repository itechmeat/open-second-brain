/**
 * Shutting the MCP transports down without cutting a request in half.
 *
 * Before this unit `HttpServerHandle.close` was a bare `server.close()`:
 * it stopped the listener and returned, while the promise returned by
 * `handleHttpRequest` was floated. A supervisor sending SIGTERM during a
 * tool call got a truncated response and no record of it, and neither
 * transport handled a signal at all.
 *
 * The tests below therefore hold a REAL request open across the drain
 * rather than asserting on a counter. The hold is produced by a client
 * that announces a `Content-Length` and then sends only part of the body,
 * so the server is genuinely parked inside `readBody` - a mock would
 * prove the bookkeeping and nothing about the server.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { connect, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { installMcpSignalDrain } from "../../src/cli/mcp-drain.ts";
import { EXIT_TERMINATED } from "../../src/cli/interrupt.ts";
import {
  DEFAULT_DRAIN_DEADLINE_MS,
  DRAIN_DEADLINE_ENV,
  DRAIN_STATE,
  describeAbandonedRequests,
  resolveDrainDeadlineMs,
} from "../../src/mcp/drain.ts";
import { startHttp, type HttpServerHandle } from "../../src/mcp/http.ts";

const temps: string[] = [];

afterEach(() => {
  while (temps.length > 0) rmSync(temps.pop()!, { recursive: true, force: true });
});

function tempVault(): string {
  const dir = mkdtempSync(join(tmpdir(), "osb-mcp-drain-"));
  temps.push(dir);
  return dir;
}

/**
 * A request the server has begun and cannot finish until the caller says
 * so: the headers promise more body than has been sent, so the server is
 * parked awaiting the rest.
 */
interface HeldRequest {
  readonly socket: Socket;
  /** Send the rest of the body, letting the server complete the request. */
  readonly complete: () => void;
  /** The full HTTP response, once the server writes one. */
  readonly response: Promise<string>;
}

async function holdRequestOpen(handle: HttpServerHandle): Promise<HeldRequest> {
  const held = await openHeldSocket(handle);
  // The socket write returning says nothing about the server having read
  // it. Without this wait the drain below can start before the request
  // has been registered at all, and every assertion about waiting for it
  // would pass over an empty register.
  await until(() => handle.drain.inFlight === 1, "the held request to reach the server");
  return held;
}

/** Poll a condition the server reaches on its own schedule, or say what failed. */
async function until(condition: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (condition()) return;
    await Bun.sleep(5);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function openHeldSocket(handle: HttpServerHandle): Promise<HeldRequest> {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
  const head = body.slice(0, 5);
  const tail = body.slice(5);
  return new Promise((ready, failed) => {
    const socket = connect(handle.port, handle.host, () => {
      socket.write(
        `POST / HTTP/1.1\r\nHost: ${handle.host}:${handle.port}\r\n` +
          `content-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\n\r\n` +
          head,
      );
      let seen = "";
      const response = new Promise<string>((resolve) => {
        socket.on("data", (chunk) => {
          seen += String(chunk);
          if (seen.includes("\r\n\r\n")) resolve(seen);
        });
        socket.on("close", () => resolve(seen));
      });
      ready({ socket, complete: () => socket.write(tail), response });
    });
    socket.on("error", failed);
  });
}

async function health(handle: HttpServerHandle): Promise<Record<string, unknown>> {
  const res = await fetch(`${handle.url}/health`);
  return (await res.json()) as Record<string, unknown>;
}

describe("the drain deadline", () => {
  test("defaults to ten seconds", () => {
    expect(DEFAULT_DRAIN_DEADLINE_MS).toBe(10_000);
    expect(resolveDrainDeadlineMs({})).toBe(DEFAULT_DRAIN_DEADLINE_MS);
  });

  test("is overridable by the environment", () => {
    expect(resolveDrainDeadlineMs({ [DRAIN_DEADLINE_ENV]: "250" })).toBe(250);
  });

  test("refuses a value that is not a deadline rather than silently defaulting", () => {
    expect(() => resolveDrainDeadlineMs({ [DRAIN_DEADLINE_ENV]: "soon" })).toThrow(
      new RegExp(DRAIN_DEADLINE_ENV),
    );
    expect(() => resolveDrainDeadlineMs({ [DRAIN_DEADLINE_ENV]: "-1" })).toThrow(
      new RegExp(DRAIN_DEADLINE_ENV),
    );
  });
});

describe("the HTTP transport drains before it closes", () => {
  test("reports draining on the unauthenticated /health while a request is in flight", async () => {
    const handle = await startHttp({ vault: tempVault() }, { host: "127.0.0.1", port: 0 });
    const held = await holdRequestOpen(handle);
    try {
      expect((await health(handle)).status).toBe("ok");

      const closing = handle.close();
      await until(() => handle.drain.draining, "the drain to start");
      // The listener stays up so a supervisor can still be told what is
      // happening; what stops is the acceptance of new MCP work.
      const probe = await health(handle);
      expect(probe.status).toBe(DRAIN_STATE.draining);
      expect(probe.in_flight).toBe(1);

      const refused = await fetch(handle.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }),
      });
      expect(refused.status).toBe(503);

      held.complete();
      const outcome = await closing;
      expect(outcome.state).toBe(DRAIN_STATE.drained);
      expect(outcome.abandoned).toEqual([]);
      expect(await held.response).toContain("200 OK");
    } finally {
      held.socket.destroy();
    }
  });

  test("a request refused with 503 is not counted as work the drain waits for", async () => {
    const handle = await startHttp({ vault: tempVault() }, { host: "127.0.0.1", port: 0 });
    const held = await holdRequestOpen(handle);
    try {
      const closing = handle.close();
      await until(() => handle.drain.draining, "the drain to start");

      const retries = await Promise.all(
        [1, 2, 3].map((id) =>
          fetch(handle.url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id, method: "ping" }),
          }),
        ),
      );
      expect(retries.map((r) => r.status)).toEqual([503, 503, 503]);

      // The register hands out ids in registration order, so the id of
      // the next request IS the count of everything registered before
      // it: 1 is the held request, and 2 means the three refusals above
      // never entered the register. Counting them let a client retrying
      // in a tight loop hold the drain open to its own deadline.
      const finish = handle.drain.begin("probe");
      expect(handle.drain.snapshot().find((r) => r.label === "probe")?.id).toBe(2);
      finish();

      held.complete();
      expect((await closing).state).toBe(DRAIN_STATE.drained);
    } finally {
      held.socket.destroy();
    }
  });

  test("names the still-open requests on stderr when the deadline expires", async () => {
    const handle = await startHttp(
      { vault: tempVault() },
      { host: "127.0.0.1", port: 0, drainDeadlineMs: 120 },
    );
    const held = await holdRequestOpen(handle);
    try {
      const outcome = await handle.close();
      expect(outcome.state).toBe(DRAIN_STATE.deadlineExpired);
      expect(outcome.abandoned).toHaveLength(1);
      expect(outcome.abandoned[0]!.label).toBe("POST /");

      const report = describeAbandonedRequests(outcome);
      expect(report).toContain("POST /");
      expect(report).toContain("120");
    } finally {
      held.socket.destroy();
    }
  });

  test("a close with nothing in flight resolves at once and shuts the listener", async () => {
    const handle = await startHttp({ vault: tempVault() }, { host: "127.0.0.1", port: 0 });
    const outcome = await handle.close();
    expect(outcome.state).toBe(DRAIN_STATE.drained);
    await expect(fetch(`${handle.url}/health`)).rejects.toThrow();
  });
});

describe("a signal drains the transport", () => {
  test("SIGTERM drains, then exits with the signal's code so the exit hooks run", async () => {
    const handle = await startHttp({ vault: tempVault() }, { host: "127.0.0.1", port: 0 });
    const held = await holdRequestOpen(handle);
    const stderr: string[] = [];
    const exits: number[] = [];
    let settled: () => void = () => {};
    const finished = new Promise<void>((resolve) => {
      settled = resolve;
    });

    const installed = installMcpSignalDrain({
      close: () => handle.close(),
      stderr: { write: (chunk: string) => void stderr.push(chunk) },
      exit: (code) => {
        exits.push(code);
        settled();
      },
    });
    try {
      process.kill(process.pid, "SIGTERM");
      // A signal handler is a callback dispatched from the event loop, so
      // it runs a turn or more after delivery (`src/cli/interrupt.ts`
      // measures exactly this). The request is still open when it does,
      // which is the point of the test.
      await until(() => handle.drain.draining, "the signal handler to start a drain");
      expect((await health(handle)).status).toBe(DRAIN_STATE.draining);
      held.complete();
      await finished;

      expect(exits).toEqual([EXIT_TERMINATED]);
      expect(stderr.join("")).toContain("SIGTERM");
    } finally {
      installed.release();
      held.socket.destroy();
    }
  });
});
