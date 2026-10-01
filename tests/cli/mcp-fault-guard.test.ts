/**
 * The MCP fault guard, in process.
 *
 * Every case installs the guard with an injected `stderr`, `exit` and
 * `now`, and releases it in `finally`: the listeners are process-global
 * and one left behind would swallow a rejection from the next suite. The
 * real behaviour of the process (it keeps serving after a rejection, it
 * exits 70 through the exit hooks after an exception) is proved by
 * `mcp-fault-guard-spawn.test.ts`; this file pins the wording, the rate
 * limit and the bookkeeping.
 */

import { describe, expect, test } from "bun:test";

import {
  EXIT_INTERNAL_FAULT,
  FAULT_KIND,
  installMcpFaultGuard,
  REJECTION_LOG_BURST,
  REJECTION_LOG_WINDOW_MS,
} from "../../src/cli/mcp-fault-guard.ts";

interface Harness {
  readonly lines: string[];
  readonly exits: number[];
  readonly clock: { ms: number };
  readonly guard: ReturnType<typeof installMcpFaultGuard>;
}

const START_MS = Date.parse("2026-10-01T03:00:00.000Z");

function harness(opts: { throwingStderr?: boolean } = {}): Harness {
  const lines: string[] = [];
  const exits: number[] = [];
  const clock = { ms: START_MS };
  const guard = installMcpFaultGuard({
    stderr: {
      write(chunk: string): void {
        if (opts.throwingStderr) throw new Error("EPIPE: stderr closed");
        lines.push(chunk);
      },
    },
    exit: (code) => exits.push(code),
    now: () => new Date(clock.ms),
  });
  return { lines, exits, clock, guard };
}

/** The rejection count, checked after each synchronous dispatch. */
function expectRejections(h: Harness, expected: number): void {
  expect(h.guard.counts().unhandled_rejection).toBe(expected);
}

/**
 * Dispatch an unhandled rejection the way the runtime does.
 *
 * Not a bare `Promise.reject`: the Bun test runner fails the running test
 * on any real unhandled rejection, whatever listeners the process has, so
 * in process the event is emitted directly. The spawned-process suite
 * proves the runtime path with a genuinely detached promise.
 */
function emitRejection(reason: unknown): void {
  const promise = Promise.resolve();
  process.emit("unhandledRejection", reason, promise);
}

describe("installMcpFaultGuard: unhandled rejections", () => {
  test("names the rejection with its first stack frame and keeps serving", () => {
    const h = harness();
    try {
      emitRejection(new Error("probe"));
      expectRejections(h, 1);
      const out = h.lines.join("");
      expect(out).toContain("[mcp] unhandled_rejection #1: Error: probe (server keeps serving)\n");
      expect(out).toMatch(/\[mcp\] {3}at .*mcp-fault-guard\.test\.ts/);
      expect(h.exits).toEqual([]);
    } finally {
      h.guard.release();
    }
  });

  test("a non-Error reason is still named", () => {
    const h = harness();
    try {
      emitRejection("x");
      emitRejection(undefined);
      expectRejections(h, 2);
      const out = h.lines.join("");
      expect(out).toContain(
        '[mcp] unhandled_rejection #1: non-error reason: "x" (server keeps serving)',
      );
      expect(out).toContain(
        "[mcp] unhandled_rejection #2: non-error reason: undefined (server keeps serving)",
      );
    } finally {
      h.guard.release();
    }
  });

  test("logs a burst in full, then one summary line per window", () => {
    const h = harness();
    try {
      for (let i = 0; i < 8; i += 1) emitRejection(new Error(`flood ${i}`));
      expectRejections(h, 8);
      const full = () => h.lines.filter((l) => l.startsWith("[mcp] unhandled_rejection #"));
      expect(full()).toHaveLength(REJECTION_LOG_BURST);

      // The window rolls over on the next fault: the summary for the old
      // window comes first, then the new fault is logged in full again.
      h.clock.ms += REJECTION_LOG_WINDOW_MS + 1;
      emitRejection(new Error("after the window"));
      expectRejections(h, 9);
      const summaries = h.lines.filter((l) => l.includes("suppressed"));
      expect(summaries).toEqual([
        `[mcp] unhandled_rejection: 3 more suppressed in the last ${REJECTION_LOG_WINDOW_MS}ms\n`,
      ]);
      expect(full()).toHaveLength(REJECTION_LOG_BURST + 1);
      expect(full().at(-1)).toContain("#9: Error: after the window");
    } finally {
      h.guard.release();
    }
  });

  test("release flushes a pending summary so a suppressed count is never lost", () => {
    const h = harness();
    try {
      for (let i = 0; i < REJECTION_LOG_BURST + 2; i += 1) emitRejection(new Error("x"));
      expectRejections(h, REJECTION_LOG_BURST + 2);
    } finally {
      h.guard.release();
    }
    expect(h.lines.filter((l) => l.includes("2 more suppressed"))).toHaveLength(1);
  });
});

describe("installMcpFaultGuard: uncaught exceptions", () => {
  test("logs by name and exits 70, without draining", () => {
    const h = harness();
    try {
      process.emit("uncaughtException", new Error("boom"));
      expect(h.exits).toEqual([EXIT_INTERNAL_FAULT]);
      expect(EXIT_INTERNAL_FAULT).toBe(70);
      const out = h.lines.join("");
      expect(out).toContain(`[mcp] ${FAULT_KIND.uncaughtException}: Error: boom`);
      expect(out).toContain(`exiting ${EXIT_INTERNAL_FAULT}`);
      expect(h.guard.counts().uncaught_exception).toBe(1);
    } finally {
      h.guard.release();
    }
  });

  test("a second exception while exiting goes straight to exit", () => {
    const h = harness();
    try {
      process.emit("uncaughtException", new Error("first"));
      const linesAfterFirst = h.lines.length;
      process.emit("uncaughtException", new Error("second"));
      expect(h.exits).toEqual([EXIT_INTERNAL_FAULT, EXIT_INTERNAL_FAULT]);
      expect(h.lines.length).toBe(linesAfterFirst);
    } finally {
      h.guard.release();
    }
  });
});

describe("installMcpFaultGuard: robustness and bookkeeping", () => {
  test("a throwing stderr does not escape either handler", () => {
    const h = harness({ throwingStderr: true });
    try {
      emitRejection(new Error("quiet"));
      expectRejections(h, 1);
      expect(() => process.emit("uncaughtException", new Error("loud"))).not.toThrow();
      expect(h.exits).toEqual([EXIT_INTERNAL_FAULT]);
      expect(h.guard.counts().uncaught_exception).toBe(1);
    } finally {
      h.guard.release();
    }
  });

  test("release restores the listener counts and is idempotent", () => {
    const rejectionsBefore = process.listenerCount("unhandledRejection");
    const exceptionsBefore = process.listenerCount("uncaughtException");
    const h = harness();
    expect(process.listenerCount("unhandledRejection")).toBe(rejectionsBefore + 1);
    expect(process.listenerCount("uncaughtException")).toBe(exceptionsBefore + 1);
    h.guard.release();
    h.guard.release();
    expect(process.listenerCount("unhandledRejection")).toBe(rejectionsBefore);
    expect(process.listenerCount("uncaughtException")).toBe(exceptionsBefore);
  });

  test("last_fault_at is null before any fault and the time of the latest after", () => {
    const h = harness();
    try {
      expect(h.guard.counts()).toEqual({
        unhandled_rejection: 0,
        uncaught_exception: 0,
        last_fault_at: null,
      });
      emitRejection(new Error("one"));
      expectRejections(h, 1);
      expect(h.guard.counts().last_fault_at).toBe(new Date(START_MS).toISOString());
      h.clock.ms += 1234;
      process.emit("uncaughtException", new Error("two"));
      expect(h.guard.counts().last_fault_at).toBe(new Date(START_MS + 1234).toISOString());
    } finally {
      h.guard.release();
    }
  });
});
