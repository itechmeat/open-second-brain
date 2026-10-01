/**
 * The fault guard in a real process.
 *
 * The in-process suite (`mcp-fault-guard.test.ts`) dispatches faults with
 * `process.emit`, because the test runner fails a test on any genuine
 * unhandled rejection. Only a spawned process proves the two claims the
 * guard makes about the runtime: a detached rejection does NOT end the
 * server, and an uncaught exception ends it with 70 THROUGH the exit
 * hooks (the lock file the hook unlinks is gone afterwards).
 *
 * Children get a throwaway HOME and TMPDIR under this run's own temp
 * directory, so no product code they run reaches the operator's config.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EXIT_INTERNAL_FAULT, FAULT_KIND } from "../../src/cli/mcp-fault-guard.ts";
import { IS_WINDOWS, homeEnv } from "../helpers/platform.ts";

const REPO_ROOT = join(import.meta.dir, "../..");
const FIXTURES = join(import.meta.dir, "../fixtures/mcp-fault-guard");
const CLI = join(REPO_ROOT, "src/cli/main.ts");
/** The runtime running this suite, so children never pick another Bun from PATH. */
const BUN = process.execPath;
/** A generous ceiling: each child starts and finishes in well under a second. */
const SPAWN_TIMEOUT_MS = 30_000;

const temps: string[] = [];

afterEach(() => {
  while (temps.length > 0) rmSync(temps.pop()!, { recursive: true, force: true });
});

function sandbox(): { vault: string; env: Record<string, string> } {
  const root = mkdtempSync(join(tmpdir(), "osb-mcp-fault-guard-"));
  temps.push(root);
  const vault = join(root, "vault");
  const home = join(root, "home");
  const tmp = join(root, "tmp");
  for (const dir of [vault, home, tmp]) mkdirSync(dir, { recursive: true });
  return {
    vault,
    env: {
      PATH: process.env["PATH"] ?? "",
      // Without it a Windows child cannot initialise Winsock.
      ...(process.env["SYSTEMROOT"] ? { SYSTEMROOT: process.env["SYSTEMROOT"] } : {}),
      ...homeEnv(home),
      TMPDIR: tmp,
      TMP: tmp,
      TEMP: tmp,
    },
  };
}

function frame(id: number, method: string, params: Record<string, unknown> = {}): string {
  return `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
}

/**
 * Collect stdout lines as they arrive, so a test can wait for one by id.
 * A wait still pending when stdout ends is rejected by name: a child that
 * died fails the test at once instead of at the timeout.
 */
function lineReader(stream: ReadableStream<Uint8Array>): {
  waitFor: (pred: (line: string) => boolean) => Promise<string>;
} {
  interface Waiter {
    readonly pred: (line: string) => boolean;
    readonly done: (line: string) => void;
    readonly fail: (error: Error) => void;
  }
  const lines: string[] = [];
  let waiters: Waiter[] = [];
  let ended = false;
  const settle = (line: string): void => {
    lines.push(line);
    waiters = waiters.filter((w) => {
      if (!w.pred(line)) return true;
      w.done(line);
      return false;
    });
  };
  void (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of stream) {
      buffer += decoder.decode(chunk, { stream: true });
      const parts = buffer.split("\n");
      buffer = parts.pop() ?? "";
      for (const line of parts) settle(line);
    }
    ended = true;
    for (const w of waiters) w.fail(new Error("child stdout ended before the awaited response"));
    waiters = [];
  })();
  return {
    waitFor: (pred) =>
      new Promise((done, fail) => {
        const hit = lines.find(pred);
        if (hit !== undefined) done(hit);
        else if (ended) fail(new Error("child stdout ended before the awaited response"));
        else waiters.push({ pred, done, fail });
      }),
  };
}

const responseTo =
  (id: number) =>
  (line: string): boolean => {
    try {
      return (JSON.parse(line) as { id?: unknown }).id === id;
    } catch {
      return false;
    }
  };

describe("mcp fault guard in a spawned process", () => {
  test(
    "a detached rejection is named and the server keeps answering",
    async () => {
      const { vault, env } = sandbox();
      const proc = Bun.spawn([BUN, join(FIXTURES, "serve-with-rejection.ts"), vault], {
        cwd: REPO_ROOT,
        env,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      const stderrText = new Response(proc.stderr).text();
      const out = lineReader(proc.stdout);

      proc.stdin.write(
        frame(1, "initialize", {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "fault-guard-spawn", version: "0" },
        }),
      );
      await out.waitFor(responseTo(1));
      proc.stdin.write(frame(2, "tools/call", { name: "brain_context", arguments: {} }));
      proc.stdin.write(frame(3, "tools/list"));
      const [called, listed] = await Promise.all([
        out.waitFor(responseTo(2)),
        out.waitFor(responseTo(3)),
      ]);
      expect(JSON.parse(called)).toHaveProperty("result");
      expect(JSON.parse(listed).result.tools.length).toBeGreaterThan(0);
      expect(proc.exitCode).toBeNull();

      proc.stdin.end();
      const code = await proc.exited;
      const stderr = await stderrText;
      expect(stderr).toContain(
        `[mcp] ${FAULT_KIND.unhandledRejection} #1: Error: fixture rejection nobody awaits (server keeps serving)`,
      );
      expect(code).toBe(0);
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "an uncaught exception exits 70 through the exit hooks",
    async () => {
      const { vault, env } = sandbox();
      const proc = Bun.spawn([BUN, join(FIXTURES, "serve-with-throw.ts"), vault], {
        cwd: REPO_ROOT,
        env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      const lockPath = stdout.trim();
      expect(lockPath).toEndWith(".lock");
      expect(stderr).toContain(
        `[mcp] ${FAULT_KIND.uncaughtException}: Error: fixture exception from a timer`,
      );
      expect(code).toBe(EXIT_INTERNAL_FAULT);
      // The sync lockfile module's `exit` hook ran: the lock is gone.
      expect(existsSync(lockPath)).toBe(false);
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "a rejection inside o2b mcp over HTTP raises the /health count, and the guard is released",
    async () => {
      const { vault, env } = sandbox();
      const proc = Bun.spawn(
        [
          BUN,
          "--preload",
          join(FIXTURES, "reject-once-guarded.ts"),
          CLI,
          "mcp",
          "--transport",
          "http",
          "--port",
          "0",
          "--vault",
          vault,
        ],
        { cwd: REPO_ROOT, env, stdin: "ignore", stdout: "ignore", stderr: "pipe" },
      );
      const err = lineReader(proc.stderr);
      try {
        const named = err.waitFor((line) =>
          line.includes(`[mcp] ${FAULT_KIND.unhandledRejection} #1: Error: fixture rejection`),
        );
        const listening = await err.waitFor((line) => line.includes(" listening on http://"));
        const url = /listening on (http:\/\/\S+)/.exec(listening)?.[1];
        expect(url).toBeDefined();
        await named;
        const body = (await (await fetch(`${url}/health`)).json()) as {
          faults?: { unhandled_rejection: number; last_fault_at: string | null };
        };
        expect(body.faults?.unhandled_rejection).toBe(1);
        expect(Number.isNaN(Date.parse(body.faults?.last_fault_at ?? ""))).toBe(false);
        expect(proc.exitCode).toBeNull();
      } finally {
        proc.kill("SIGTERM");
      }
      await proc.exited;
      // A Windows kill ends the child without running its exit hooks, so
      // only POSIX can watch the verb release the guard on the way out.
      if (!IS_WINDOWS) {
        const exitLine = await err.waitFor((line) => line.includes("listeners at exit: "));
        expect(exitLine).toEndWith("listeners at exit: 0");
      }
    },
    SPAWN_TIMEOUT_MS,
  );
});
