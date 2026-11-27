/**
 * A background worker a hook starts is not a descendant of the hook.
 *
 * Claude Code ends a SessionStart hook that runs past its `timeout` by
 * signalling the hook's whole process tree, found by parent pid; a
 * session of its own does not hide a child from that walk. The automatic
 * dream worker, started by such a hook, died 10 s after its start. The
 * spawn helper (`spawnSelfDetached`) now starts every background worker
 * through a launcher that exits at once, so the worker is reparented
 * before the hook goes on.
 *
 * Proved with real processes: a parent standing in for the hook starts a
 * worker stand-in through the helper and stays alive; its tree is then
 * signalled the way the host does. The direct child
 * (`spawnSelfDetachedChild`) is the control: the same walk finds it and
 * ends it.
 *
 * Skipped on Windows: the helper starts the child directly there, as
 * before, and Windows has no parent-pid reparenting to prove.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { spawnSelfDetached } from "../../../src/core/maintenance/o2b-command.ts";

const FIXTURES = join(import.meta.dir, "fixtures");
const PARENT = join(FIXTURES, "reparent-parent.ts");
const STANDIN = join(FIXTURES, "reparent-standin.ts");

const dirs: string[] = [];
const started: number[] = [];

afterEach(() => {
  // Only the processes this test started, by pid.
  for (const pid of started.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Every live process with its parent, from `ps` (Linux and macOS). */
function processTable(): Array<{ pid: number; ppid: number }> {
  const out = Bun.spawnSync(["ps", "-A", "-o", "pid=", "-o", "ppid="]).stdout.toString();
  return out
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter((row): row is [number, number] => row.length === 2 && row.every(Number.isFinite))
    .map(([pid, ppid]) => ({ pid, ppid }));
}

/** The descendants of `root`, found by parent pid as the host walks them. */
function descendants(root: number): number[] {
  const table = processTable();
  const found: number[] = [];
  const queue = [root];
  while (queue.length > 0) {
    const parent = queue.shift() as number;
    for (const row of table) {
      if (row.ppid === parent && !found.includes(row.pid)) {
        found.push(row.pid);
        queue.push(row.pid);
      }
    }
  }
  return found;
}

/** SIGTERM to `root` and every descendant it has now: the host's hook timeout. */
function signalTree(root: number): void {
  for (const pid of [root, ...descendants(root)]) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // gone between the walk and the signal
    }
  }
}

/** Whether `pid` runs (a zombie does not). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  const stat = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)])
    .stdout.toString()
    .trim();
  return stat.length > 0 && !stat.startsWith("Z");
}

async function until(check: () => boolean, ms = 10_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    // oxlint-disable-next-line no-await-in-loop
    await Bun.sleep(25);
  }
  return check();
}

/** Start the hook stand-in; resolves with it and the worker pid the helper returned. */
async function startHook(
  mode: "reparented" | "child",
): Promise<{ hook: ReturnType<typeof Bun.spawn>; spawned: number; report: string }> {
  const dir = mkdtempSync(join(tmpdir(), "osb-reparent-"));
  dirs.push(dir);
  const report = join(dir, "standin.json");
  const hook = Bun.spawn([process.execPath, "run", PARENT, mode, STANDIN, report], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "inherit",
  });
  started.push(hook.pid);
  const reader = hook.stdout.getReader();
  let text = "";
  while (!text.includes("\n")) {
    // oxlint-disable-next-line no-await-in-loop
    const { value, done } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  const spawned = Number(/^spawned:(\d+)$/m.exec(text)?.[1]);
  expect(Number.isInteger(spawned)).toBe(true);
  started.push(spawned);
  expect(await until(() => existsSync(report))).toBe(true);
  return { hook, spawned, report };
}

function standinReport(report: string): { pid: number; ppid: number } {
  return JSON.parse(readFileSync(report, "utf8")) as { pid: number; ppid: number };
}

describe.skipIf(process.platform === "win32")(
  "a background worker outlives its hook's tree",
  () => {
    test("the worker the helper starts is no child of the hook, and a signal to the hook's tree leaves it running", async () => {
      const { hook, spawned, report } = await startHook("reparented");
      const worker = standinReport(report);
      // The helper returns the worker's own pid, not the launcher's.
      expect(worker.pid).toBe(spawned);
      expect(worker.ppid).not.toBe(hook.pid);
      expect(descendants(hook.pid)).not.toContain(worker.pid);

      signalTree(hook.pid);
      await hook.exited;
      // Given the time a signal needs to land.
      await Bun.sleep(300);
      expect(alive(worker.pid)).toBe(true);
    });

    test("a worker that cannot be started is an error the start sees, with its cause", () => {
      // The launcher reports it: a start that throws gives its claim back.
      expect(() => spawnSelfDetached([join(FIXTURES, "no-such-program"), "x"])).toThrow(
        /could not start .*no-such-program: .*ENOENT/,
      );
    });

    test("control: a direct child is found by the same walk and ends with the hook", async () => {
      const { hook, spawned, report } = await startHook("child");
      const worker = standinReport(report);
      expect(worker.pid).toBe(spawned);
      expect(worker.ppid).toBe(hook.pid);
      expect(descendants(hook.pid)).toContain(worker.pid);

      signalTree(hook.pid);
      await hook.exited;
      expect(await until(() => !alive(worker.pid))).toBe(true);
    });
  },
);
