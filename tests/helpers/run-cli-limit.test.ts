/**
 * The per-call time limit of the CLI spawn helper (`run-cli.ts`): a child
 * that never exits is killed below the test's own timeout, and the test
 * fails with the command line, the elapsed time and what the child wrote
 * so far, instead of a silent timeout and a "dangling process" note.
 */

import { describe, expect, setDefaultTimeout, test } from "bun:test";

import {
  CLI_CHILD_LIMIT_MS,
  CLI_SPAWN_BUDGET_MS,
  cliChildLimitFor,
  EXIT_DRAIN_GRACE_MS,
  KILL_REAP_MS,
} from "./cli-timeout.ts";
import { spawnWithLimit } from "./run-cli.ts";
import { OS_PROBE_LIMIT_MS } from "./windows-process-probe.ts";

setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

/** Long enough for a loaded machine to start bun and write two lines. */
const LIMIT_MS = 5_000;

/** How long a grandchild may take to notice its closed pipe. */
const PIPE_CLOSE_WAIT_MS = 10_000;

const HANGS = [
  "process.stdout.write('child-started\\n');",
  "process.stderr.write('child-note\\n');",
  "setInterval(() => {}, 1000);",
].join(" ");

/** Writes to the stdout it inherited until the write fails, then exits. */
const GRANDCHILD = [
  "process.stdout.on('error', () => process.exit(7));",
  "setInterval(() => { try { process.stdout.write('tick\\n'); } catch { process.exit(7); } }, 100);",
  "setTimeout(() => process.exit(0), 60000);",
].join(" ");

/** Starts the grandchild on its own stdout and stderr, names it, then hangs. */
const HANGS_WITH_GRANDCHILD = [
  `const g = Bun.spawn([process.execPath, '-e', ${JSON.stringify(GRANDCHILD)}],`,
  "{ stdio: ['ignore', 'inherit', 'inherit'] });",
  "process.stderr.write('grandchild ' + g.pid + '\\n');",
  "setInterval(() => {}, 1000);",
].join(" ");

/** Stays quiet on the stdout and stderr it inherited, then exits on its own. */
const QUIET_GRANDCHILD = "setTimeout(() => process.exit(0), 60000);";

/**
 * Starts the quiet grandchild detached, on its own stdout and stderr (so it
 * outlives the child and holds both pipes), names it, prints and exits 0.
 */
const EXITS_LEAVING_GRANDCHILD = [
  `const g = Bun.spawn([process.execPath, '-e', ${JSON.stringify(QUIET_GRANDCHILD)}],`,
  "{ stdio: ['ignore', 'inherit', 'inherit'], detached: true });",
  "g.unref();",
  "process.stderr.write('grandchild ' + g.pid + '\\n');",
  "process.stdout.write('child-done\\n');",
  "process.exit(0);",
].join(" ");

/** The text of one captured section (`stdout` or `stderr`) of the error. */
function section(message: string, name: "stdout" | "stderr"): string {
  const header = new RegExp(`^--- ${name} so far \\(\\d+ chars\\) ---$`, "m");
  const start = header.exec(message);
  if (start === null) return "";
  const rest = message.slice(start.index + start[0].length + 1);
  const next = /^--- \w+ so far \(\d+ chars\) ---$/m.exec(rest);
  return next === null ? rest : rest.slice(0, next.index);
}

async function limitError(script: string): Promise<string> {
  try {
    await spawnWithLimit([process.execPath, "-e", script], {
      env: { ...process.env } as Record<string, string>,
      limitMs: LIMIT_MS,
    });
  } catch (err) {
    expect(err).toBeInstanceOf(Error);
    return (err as Error).message;
  }
  throw new Error("the child was expected to outlive the limit");
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Resolves true as soon as `pid` is gone, false after `maxMs`. */
function goneWithin(pid: number, maxMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const poll = setInterval(() => {
      const gone = !alive(pid);
      if (gone || Date.now() - startedAt > maxMs) {
        clearInterval(poll);
        resolve(gone);
      }
    }, 100);
  });
}

describe("spawnWithLimit", () => {
  test("a child that never exits is killed and the failure carries the evidence", async () => {
    const message = await limitError(HANGS);
    expect(message).toContain(`${LIMIT_MS} ms`);
    expect(message).toContain("-e");
    expect(message).toContain("setInterval");
    expect(message).toMatch(/elapsed \d+ ms/);
    expect(message).toMatch(/^last output: \d+ ms after the spawn$/m);
    // The command line quotes both markers, so look in the sections only.
    expect(section(message, "stdout").trimEnd()).toBe("child-started");
    expect(section(message, "stderr").trimEnd()).toBe("child-note");
  });

  test.skipIf(process.platform !== "win32")(
    "on Windows the failure also names the child's state from the operating system",
    async () => {
      const message = await limitError(HANGS);
      expect(message).toMatch(/^os at the limit \(/m);
      expect(message).toMatch(/^os after the kill: /m);
    },
  );

  test.skipIf(process.platform === "win32")(
    "elsewhere the failure carries no operating system lines",
    async () => {
      const message = await limitError(HANGS);
      expect(message).not.toMatch(/^os /m);
    },
  );

  // Windows does not end a grandchild's write when the reader goes away
  // the same way, and `process.kill(pid, 0)` is a POSIX probe.
  test.skipIf(process.platform === "win32")(
    "the output readers stop with the failure, even when a grandchild holds the pipes",
    async () => {
      const message = await limitError(HANGS_WITH_GRANDCHILD);
      const pid = Number(/grandchild (\d+)/.exec(section(message, "stderr"))?.[1]);
      expect(pid).toBeGreaterThan(0);
      try {
        // A closed reader breaks the grandchild's pipe, and it exits.
        expect(await goneWithin(pid, PIPE_CLOSE_WAIT_MS)).toBe(true);
      } finally {
        if (alive(pid)) process.kill(pid, "SIGKILL");
      }
    },
  );

  test("the child's exit decides: a grandchild holding the pipes delays the result only briefly, and says so", async () => {
    const r = await spawnWithLimit([process.execPath, "-e", EXITS_LEAVING_GRANDCHILD], {
      env: { ...process.env } as Record<string, string>,
      limitMs: LIMIT_MS,
    });
    const pid = Number(/grandchild (\d+)/.exec(r.stderr)?.[1]);
    try {
      expect(pid).toBeGreaterThan(0);
      expect(r.returncode).toBe(0);
      expect(r.stdout).toBe("child-done\n");
      expect(r.warning).toMatch(/^stdout and stderr still open \d+ ms after the child exited/);
    } finally {
      if (pid > 0 && alive(pid)) process.kill(pid, "SIGKILL");
    }
  });

  test("a child that exits returns its output and code as before", async () => {
    const r = await spawnWithLimit(
      [process.execPath, "-e", "console.log('out'); console.error('err'); process.exit(3)"],
      { env: { ...process.env } as Record<string, string>, limitMs: LIMIT_MS, stdin: "" },
    );
    expect(r).toEqual({ stdout: "out\n", stderr: "err\n", returncode: 3 });
  });
});

/** One `install --apply` call measured on the Windows runner. */
const SLOW_WINDOWS_CALL_MS = 25_300;

/** The latest a call with this limit can end, after a kill or after an exit. */
function latestEnd(limitMs: number): number {
  return Math.max(limitMs + OS_PROBE_LIMIT_MS + KILL_REAP_MS, limitMs + EXIT_DRAIN_GRACE_MS);
}

describe("the per-call limit follows the test's own timeout", () => {
  test("the default fails a hung call inside the spawn budget, and lets a slow call pass", () => {
    expect(latestEnd(CLI_CHILD_LIMIT_MS)).toBeLessThan(CLI_SPAWN_BUDGET_MS);
    expect(CLI_CHILD_LIMIT_MS).toBeGreaterThan(SLOW_WINDOWS_CALL_MS);
  });

  test("a shorter timeout gets a limit that ends inside it", () => {
    expect(latestEnd(cliChildLimitFor(30_000))).toBeLessThan(30_000);
  });

  test("a timeout with no room for the failure path is refused", () => {
    expect(() => cliChildLimitFor(5_000)).toThrow("leaves no room for a per-call limit");
  });
});
