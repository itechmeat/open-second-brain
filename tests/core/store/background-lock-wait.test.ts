/**
 * A dream pass waits for a busy store lock as a long background operation
 * (`withBackgroundLockWait`, `local-lock.ts`): two minutes, pinned from
 * both sides on an injected clock (a hold shorter than the bound is waited
 * out, one past it is refused with its holder named), scoped to one
 * synchronous call (no lock outside it, and no lock that passes its own
 * budget, inherits it). The holder is a real second process; the injected
 * sleep tells it to release through a file (a signal would end it on
 * Windows without its handler) and waits for its acknowledgement without
 * moving the injected clock, so nothing sleeps to synchronise. Also: the
 * holder record belongs to one lock directory and to its own holder, and
 * the device clock file is flushed before it is renamed into place, its
 * directory entry before any update returns.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  clockFilePath,
  observeClock,
  readClock,
  tickClock,
} from "../../../src/core/store/clock-store.ts";
import { formatHlc, parseHlc } from "../../../src/core/store/hlc.ts";
import {
  acquireDirLock,
  BACKGROUND_LOCK_WAIT_MS,
  describeLockHolder,
  LOCK_HOLDER_SUFFIX,
  LockBusyError,
  STORE_LOCK_STALE_MS,
  storeLockWaitMs,
  withBackgroundLockWait,
  withLocalLock,
} from "../../../src/core/store/local-lock.ts";
import { acquireProcessLock } from "../../../src/core/store/process-lock.ts";

const LOCAL_LOCK = resolve(import.meta.dir, "../../../src/core/store/local-lock.ts");
const DEVICE = "dev-a";
/** The directory flush a clock update ends with: none on Windows. */
const DIR_FLUSH: readonly string[] = process.platform === "win32" ? [] : ["fsync dir"];

let parent: string;
let stateDir: string;
let running: ReturnType<typeof Bun.spawn> | null = null;

beforeEach(() => {
  parent = mkdtempSync(join(tmpdir(), "osb-bg-lock-"));
  stateDir = join(parent, "state");
});

afterEach(async () => {
  if (running !== null) {
    running.kill("SIGKILL");
    await running.exited;
    running = null;
  }
  rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** A second process holding a store lock, and how to make it let go. */
interface Holder {
  readonly child: ReturnType<typeof Bun.spawn>;
  /** Asks the holder to release; it then writes `released`. */
  readonly release: string;
  readonly released: string;
}

/**
 * Start a second process that takes the store lock of `target`, says so
 * on its output, and releases it once the file `release` appears, then
 * writes the file `released`.
 */
async function holdLock(target: string): Promise<Holder> {
  const script = join(parent, "hold.ts");
  const release = join(parent, "release");
  const released = join(parent, "released");
  writeFileSync(
    script,
    [
      `import { existsSync, mkdirSync, writeFileSync } from "node:fs";`,
      `import { dirname } from "node:path";`,
      `import { acquireDirLock, STORE_LOCK_STALE_MS } from ${JSON.stringify(LOCAL_LOCK)};`,
      `const [target, ask, ack] = process.argv.slice(2);`,
      `mkdirSync(dirname(target), { recursive: true });`,
      `const release = acquireDirLock(target, { staleMs: STORE_LOCK_STALE_MS, budgetMs: 0, label: "store lock", remedy: "-" });`,
      `const poll = setInterval(() => {`,
      `  if (!existsSync(ask)) return;`,
      `  clearInterval(poll);`,
      `  release();`,
      `  writeFileSync(ack, "released\\n");`,
      `}, 2);`,
      `process.stdout.write("held\\n");`,
    ].join("\n"),
  );
  const child = Bun.spawn([process.execPath, script, target, release, released], {
    stdout: "pipe",
    stderr: "inherit",
  });
  running = child;
  const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
  let seen = "";
  while (!seen.includes("held\n")) {
    // oxlint-disable-next-line no-await-in-loop -- reads the holder's output until it holds
    const { value, done } = await reader.read();
    if (done) throw new Error(`the holder exited before it held the lock: ${seen}`);
    seen += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  return { child, release, released };
}

/** Real time the holder gets to acknowledge a release; the injected clock stands still meanwhile. */
const RELEASE_ACK_MS = 30_000;

/** Ask `holder` to release, and wait (in real time, bounded) until it says it has. */
function releaseAndWait(holder: Holder): void {
  writeFileSync(holder.release, "release\n");
  const deadline = Date.now() + RELEASE_ACK_MS;
  while (!existsSync(holder.released)) {
    if (Date.now() > deadline) {
      throw new Error(`the holder did not acknowledge its release within ${RELEASE_ACK_MS} ms`);
    }
    Bun.sleepSync(1);
  }
}

/** A tick inside a pass whose clock lock is released after `holdMs` of injected time. */
function tickAfterHold(holder: Holder, holdMs: number): number {
  let t = 0;
  let told = false;
  withBackgroundLockWait(
    () => tickClock(stateDir, DEVICE, () => Date.parse("2026-11-26T10:00:00.000Z")),
    {
      now: () => t,
      sleep: () => {
        t += 250;
        if (t >= holdMs && !told) {
          told = true;
          releaseAndWait(holder);
        }
      },
    },
  );
  expect(told).toBe(true);
  return t;
}

/** The pid of a process that has exited. */
async function deadPid(): Promise<number> {
  const child = Bun.spawn([process.execPath, "-e", "0"]);
  await child.exited;
  return child.pid;
}

describe("a store lock inside a dream pass", () => {
  test("the two-minute wait holds for the synchronous call only", async () => {
    expect(storeLockWaitMs()).toBe(5_000);
    let inside = 0;
    withBackgroundLockWait(() => {
      inside = storeLockWaitMs();
    });
    expect(inside).toBe(BACKGROUND_LOCK_WAIT_MS);
    expect(storeLockWaitMs()).toBe(5_000);
    // Work that yields would carry the wait into whatever runs meanwhile.
    expect(() => withBackgroundLockWait(async () => {})).toThrow(TypeError);
    await Promise.resolve();
    expect(storeLockWaitMs()).toBe(5_000);
  });

  test("refused asynchronous work that fails leaves no unhandled rejection", () => {
    // The test runner fails a test that leaves a rejection unhandled.
    let refused: unknown = null;
    try {
      withBackgroundLockWait(async () => {
        throw new Error("refused work failed");
      });
    } catch (err) {
      refused = err;
    }
    expect(refused).toBeInstanceOf(TypeError);
  });

  test("a clock lock another process holds for eight seconds is waited out", async () => {
    const t = tickAfterHold(await holdLock(clockFilePath(stateDir, DEVICE)), 8_000);
    expect(t).toBeGreaterThanOrEqual(8_000);
    expect(readClock(stateDir, DEVICE)).not.toBeNull();
  });

  test("a hold just shorter than the two-minute bound is waited out", async () => {
    const t = tickAfterHold(
      await holdLock(clockFilePath(stateDir, DEVICE)),
      BACKGROUND_LOCK_WAIT_MS - 500,
    );
    expect(t).toBeLessThan(BACKGROUND_LOCK_WAIT_MS);
    expect(readClock(stateDir, DEVICE)).not.toBeNull();
  });

  test("a clock lock held past the bound is refused at the bound with its holder named", async () => {
    const { child } = await holdLock(clockFilePath(stateDir, DEVICE));
    let t = 0;
    let refused: unknown = null;
    try {
      withBackgroundLockWait(() => tickClock(stateDir, DEVICE), {
        now: () => t,
        sleep: () => {
          t += 10_000;
        },
      });
    } catch (err) {
      refused = err;
    }
    expect(refused).toBeInstanceOf(LockBusyError);
    const busy = refused as LockBusyError;
    expect(busy.code).toBe("ELOCKED");
    expect(busy.holder).toContain(`held by process ${child.pid}`);
    expect(busy.message).toContain(`held by process ${child.pid}`);
    expect(busy.message).not.toContain("no longer runs");
    expect(busy.message).toContain(`still held after waiting ${BACKGROUND_LOCK_WAIT_MS} ms`);
    expect(readClock(stateDir, DEVICE)).toBeNull();
  });

  test("the dream pass lock's mutex keeps its own bound inside a pass", async () => {
    const target = join(stateDir, "dream", "pass");
    await holdLock(target);
    let t = 0;
    let refused: unknown = null;
    try {
      withBackgroundLockWait(() => acquireProcessLock(target, { budgetMs: 5_000 }), {
        now: () => t,
        sleep: () => {
          t += 1_000;
        },
      });
    } catch (err) {
      refused = err;
    }
    expect(refused).toBeInstanceOf(LockBusyError);
    expect((refused as Error).message).toContain("still held after waiting 5000 ms");
  });
});

describe("the holder record of a store lock", () => {
  test("a dead process's record beside another lock directory is not read as its holder", async () => {
    const target = join(stateDir, "identity");
    mkdirSync(`${target}.lock`, { recursive: true });
    // A record a killed holder left, beside a lock a binary that writes
    // none took a moment later.
    writeFileSync(
      `${target}${LOCK_HOLDER_SUFFIX}`,
      JSON.stringify({ pid: await deadPid(), command: "o2b hook", at: Date.now() }),
    );
    expect(describeLockHolder(target)).toBeNull();
  });

  test("a dead holder of the lock now held is named with the takeover", async () => {
    const target = join(stateDir, "identity");
    mkdirSync(`${target}.lock`, { recursive: true });
    const pid = await deadPid();
    writeFileSync(
      `${target}${LOCK_HOLDER_SUFFIX}`,
      JSON.stringify({
        pid,
        command: "o2b hook",
        at: Date.now(),
        lock: statSync(`${target}.lock`).ino,
      }),
    );
    expect(describeLockHolder(target)).toContain(`held by process ${pid} (o2b hook)`);
    expect(describeLockHolder(target)).toContain("which no longer runs; the lock is taken over");
  });

  test("taking over a dead holder's lock replaces its record, and the release removes it", async () => {
    const target = join(stateDir, "identity");
    const lockDir = `${target}.lock`;
    mkdirSync(lockDir, { recursive: true });
    const record = `${target}${LOCK_HOLDER_SUFFIX}`;
    writeFileSync(
      record,
      JSON.stringify({ pid: await deadPid(), command: "-", at: 0, lock: statSync(lockDir).ino }),
    );
    const old = new Date(Date.now() - 120_000);
    utimesSync(lockDir, old, old);
    const seen = withLocalLock(target, () => describeLockHolder(target));
    expect(seen).toContain(`held by process ${process.pid}`);
    expect(existsSync(record)).toBe(false);
    expect(fs.readdirSync(dirname(target)).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  test("a holder whose lock was taken over leaves the new holder's record on release", () => {
    const target = join(stateDir, "identity");
    mkdirSync(stateDir, { recursive: true });
    const release = acquireDirLock(target, {
      staleMs: STORE_LOCK_STALE_MS,
      budgetMs: 0,
      label: "store lock",
      remedy: "-",
    });
    // Another process took the lock over (it was older than the stale
    // window) and recorded itself.
    const record = `${target}${LOCK_HOLDER_SUFFIX}`;
    const usurper = JSON.stringify({
      pid: process.pid + 1,
      command: "o2b hook",
      at: Date.now(),
      lock: statSync(`${target}.lock`).ino,
    });
    writeFileSync(record, `${usurper}\n`);
    release();
    expect(fs.readFileSync(record, "utf8")).toBe(`${usurper}\n`);
  });
});

describe("the device clock file", () => {
  test("is flushed before it is renamed into place; only the directory flush follows the release", () => {
    const path = clockFilePath(stateDir, DEVICE);
    const realOpen = fs.openSync;
    const realFsync = fs.fsyncSync;
    const realRename = fs.renameSync;
    const fds = new Map<number, string>();
    const events: string[] = [];
    const open = spyOn(fs, "openSync").mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
      const fd = (realOpen as (...a: unknown[]) => number)(p, ...rest);
      fds.set(fd, String(p));
      return fd;
    }) as typeof fs.openSync);
    const fsync = spyOn(fs, "fsyncSync").mockImplementation((fd: number) => {
      const p = fds.get(fd) ?? "?";
      const kind = p === dirname(path) ? "dir" : p.endsWith(".tmp") ? "tmp" : p;
      events.push(`fsync ${kind}${kind === "dir" && existsSync(`${path}.lock`) ? " locked" : ""}`);
      realFsync(fd);
    });
    const rename = spyOn(fs, "renameSync").mockImplementation(
      (from: fs.PathLike, to: fs.PathLike) => {
        if (String(to) === path) {
          events.push(
            `rename ${String(from).endsWith(".tmp") ? "tmp" : String(from)} locked=${existsSync(`${path}.lock`)}`,
          );
        }
        realRename(from, to);
      },
    );
    try {
      tickClock(stateDir, DEVICE);
    } finally {
      open.mockRestore();
      fsync.mockRestore();
      rename.mockRestore();
    }
    // Windows has no directory flush; the file flush before the rename holds everywhere.
    expect(
      events.filter(
        (e) => e.startsWith("fsync tmp") || e.startsWith("rename") || e.startsWith("fsync dir"),
      ),
    ).toEqual(["fsync tmp", "rename tmp locked=true", ...DIR_FLUSH]);
    expect(formatHlc(readClock(stateDir, DEVICE)!)).not.toBe("");
  });

  test("an observation that raises nothing makes the entry it read durable before it returns", () => {
    const path = clockFilePath(stateDir, DEVICE);
    // Another writer renamed a clock of 100 into place and released the
    // lock; its directory flush has not run yet.
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ hlc: "100.0" })}\n`);
    const remote = parseHlc("50.0")!;
    const dirFlushes = (): number => {
      const realOpen = fs.openSync;
      const realFsync = fs.fsyncSync;
      const dirFds = new Set<number>();
      let flushes = 0;
      const open = spyOn(fs, "openSync").mockImplementation(((
        p: fs.PathLike,
        ...rest: unknown[]
      ) => {
        const fd = (realOpen as (...a: unknown[]) => number)(p, ...rest);
        if (String(p) === dirname(path)) dirFds.add(fd);
        return fd;
      }) as typeof fs.openSync);
      const fsync = spyOn(fs, "fsyncSync").mockImplementation((fd: number) => {
        if (dirFds.has(fd)) flushes += 1;
        realFsync(fd);
      });
      try {
        observeClock(stateDir, DEVICE, remote, () => 10);
      } finally {
        open.mockRestore();
        fsync.mockRestore();
      }
      return flushes;
    };
    expect(dirFlushes()).toBe(DIR_FLUSH.length);
    expect(formatHlc(readClock(stateDir, DEVICE)!)).toBe("100.0");
    // The same entry again: this process made it durable already.
    expect(dirFlushes()).toBe(0);
  });
});
