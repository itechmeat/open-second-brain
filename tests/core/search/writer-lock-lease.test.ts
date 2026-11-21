/**
 * The writer lock as a lease: fresh while its holder is blocked in
 * synchronous work, bounded so a wedged holder still goes stale, and
 * ownership-checked so a holder that lost it never touches its
 * successor's lock.
 *
 * The stale window is shortened through its documented override. A lock
 * is made stale by backdating its directory rather than by waiting, and
 * a takeover is what a contender does on disk: the old directory removed,
 * a new one created. The other writer is a real second process wherever
 * the holder is blocked, since a blocked thread cannot run it itself.
 */

import {
  afterEach,
  beforeEach,
  expect,
  setDefaultTimeout,
  setSystemTime,
  spyOn,
  test,
} from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import lockfile from "proper-lockfile";

import { indexVault, reindexVault } from "../../../src/core/search/indexer.ts";
import { Store } from "../../../src/core/search/store.ts";
import {
  acquireWriterLease,
  acquireWriterLeaseSync,
  isWriterLockHeld,
  keepWriterLeasesFresh,
  writerLeaseCheckIn,
  WRITER_LOCK_STALE_ENV,
  type WriterLease,
} from "../../../src/core/search/store/writer-lock.ts";
import { LockDirectoryRefusedError } from "../../../src/core/fs-lock.ts";
import { SearchError } from "../../../src/core/search/types.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";
import { CHMOD_CANNOT_DENY } from "../../helpers/platform.ts";
import { tempDirs } from "../../helpers/temp-dir.ts";
import { windowsRefusal } from "../../helpers/windows-lock-refusal.ts";

setDefaultTimeout(30_000);

const STALE_MS = 1_500;
const HEARTBEAT_MS = STALE_MS / 3;
const WRITER_LOCK_MODULE = join(import.meta.dir, "../../../src/core/search/store/writer-lock.ts");

const mkTemp = tempDirs();
let dir: string;
let dbPath: string;
let lockDir: string;
let savedStale: string | undefined;

beforeEach(() => {
  dir = mkTemp("o2b-writer-lease-");
  dbPath = join(dir, "index.sqlite");
  lockDir = `${dbPath}.lock`;
  savedStale = process.env[WRITER_LOCK_STALE_ENV];
  process.env[WRITER_LOCK_STALE_ENV] = String(STALE_MS);
});

afterEach(() => {
  if (savedStale === undefined) delete process.env[WRITER_LOCK_STALE_ENV];
  else process.env[WRITER_LOCK_STALE_ENV] = savedStale;
});

/** Make the lock look abandoned: its mtime two stale windows in the past. */
function backdateLock(): void {
  const past = (Date.now() - 2 * STALE_MS) / 1000;
  utimesSync(lockDir, past, past);
}

/** What a takeover leaves on disk: the old directory gone, the successor's in its place. */
function takeOver(): WriterLease {
  rmSync(lockDir, { recursive: true });
  return acquireWriterLeaseSync(dbPath);
}

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    return (err as SearchError).code ?? String(err);
  }
}

/** Run a Bun script as another process, synchronously, with the short window. */
function runChild(name: string, source: string): string {
  const script = join(dir, `${name}.ts`);
  writeFileSync(script, source);
  const r = spawnSync(process.execPath, [script], {
    encoding: "utf8",
    env: { ...process.env, [WRITER_LOCK_STALE_ENV]: String(STALE_MS) },
    timeout: 20_000,
  });
  expect(r.status).toBe(0);
  return r.stdout;
}

const importLease = `import { acquireWriterLeaseSync } from ${JSON.stringify(WRITER_LOCK_MODULE)};`;

test("an ENOENT stat race never removes the next writer's fresh lock", () => {
  mkdirSync(lockDir);
  let raced = false;
  const realStat = fs.statSync;
  // Every other call reaches the real stat with its options intact, and
  // the spy is undone before the test ends: other files in this process
  // stat with `bigint` and `throwIfNoEntry`.
  const spy = spyOn(fs, "statSync").mockImplementation(((path: fs.PathLike, ...rest: unknown[]) => {
    if (path === lockDir && !raced) {
      raced = true;
      rmSync(lockDir, { recursive: true, force: true });
      mkdirSync(lockDir);
      throw Object.assign(new Error("released before stat"), { code: "ENOENT" });
    }
    return (realStat as (...args: unknown[]) => unknown)(path, ...rest);
  }) as typeof fs.statSync);
  try {
    expect(() => acquireWriterLeaseSync(dbPath)).toThrow();
  } finally {
    spy.mockRestore();
  }
  expect(raced).toBe(true);
  expect(existsSync(lockDir)).toBe(true);
});

test("a holder blocked in a child process keeps the lock past two stale windows", () => {
  const lease = acquireWriterLeaseSync(dbPath);
  try {
    // Two windows into the block, long after an event-loop heartbeat alone
    // would have let the lock go stale, another writer is still refused.
    const got = keepWriterLeasesFresh(60_000, () =>
      runChild(
        "contender",
        [
          importLease,
          `Bun.sleepSync(${2 * STALE_MS});`,
          "try {",
          `  acquireWriterLeaseSync(${JSON.stringify(dbPath)}).release();`,
          '  process.stdout.write("acquired");',
          "} catch (err) {",
          "  process.stdout.write(String(err.code ?? err));",
          "}",
        ].join("\n"),
      ),
    );
    expect(got).toBe("INDEX_LOCKED");
    expect(lease.lost).toBe(false);
    expect(() => lease.assertHeld()).not.toThrow();
  } finally {
    lease.release();
  }
  expect(existsSync(lockDir)).toBe(false);
});

test("a holder still blocked past its budget goes stale and is taken over", () => {
  const lease = acquireWriterLeaseSync(dbPath);
  try {
    const budgetMs = 300;
    // The contender keeps trying from the earliest moment a takeover could
    // succeed, so a refresher that started late cannot make it give up:
    // what it proves is that the lock does go stale while the holder
    // stays blocked. When the block ends, the call refuses: the lock is
    // not this holder's any more.
    let got = "";
    const refused = codeOf(() =>
      keepWriterLeasesFresh(budgetMs, () => {
        got = runChild(
          "late-contender",
          [
            importLease,
            `Bun.sleepSync(${budgetMs + STALE_MS});`,
            "const deadline = Date.now() + 10_000;",
            "let got = 'INDEX_LOCKED';",
            "while (Date.now() < deadline) {",
            "  try {",
            `    acquireWriterLeaseSync(${JSON.stringify(dbPath)}).release();`,
            "    got = 'acquired';",
            "    break;",
            "  } catch (err) {",
            "    if (err.code !== 'INDEX_LOCKED') throw err;",
            "  }",
            "}",
            "process.stdout.write(got);",
          ].join("\n"),
        );
      }),
    );
    expect(got).toBe("acquired");
    expect(refused).toBe("INDEX_LOCKED");
    expect(codeOf(() => lease.assertHeld())).toBe("INDEX_LOCKED");
  } finally {
    lease.release();
  }
});

test("a takeover while the refresher runs is not refreshed, and the call refuses when it returns", () => {
  const losses: string[] = [];
  const lease = acquireWriterLeaseSync(dbPath, { onLost: (err) => void losses.push(err.code) });
  try {
    // The successor takes the lock over and then sleeps through several
    // of the refresher's beats; its lock's mtime must be exactly what it
    // stamped when it woke up.
    let got = "";
    const refused = codeOf(() =>
      keepWriterLeasesFresh(60_000, () => {
        got = runChild(
          "successor",
          [
            'import { rmSync, statSync } from "node:fs";',
            importLease,
            `rmSync(${JSON.stringify(lockDir)}, { recursive: true });`,
            `const lease = acquireWriterLeaseSync(${JSON.stringify(dbPath)});`,
            `const before = statSync(${JSON.stringify(lockDir)}).mtimeMs;`,
            `Bun.sleepSync(${4 * HEARTBEAT_MS});`,
            `const after = statSync(${JSON.stringify(lockDir)}).mtimeMs;`,
            'process.stdout.write(after === before ? "untouched" : "stamped");',
            "lease.release();",
          ].join("\n"),
        );
      }),
    );
    expect(got).toBe("untouched");
    expect(refused).toBe("INDEX_LOCKED");
    expect(lease.lost).toBe(true);
    expect(losses).toEqual(["INDEX_LOCKED"]);
  } finally {
    lease.release();
  }
});

test("a holder that lost the lock to a takeover leaves its successor's lock in place", () => {
  const lease = acquireWriterLeaseSync(dbPath);
  backdateLock();
  const successor = acquireWriterLeaseSync(dbPath);
  try {
    lease.release();
    expect(existsSync(lockDir)).toBe(true);
    expect(isWriterLockHeld(dbPath)).toBe(true);
    expect(codeOf(() => lease.assertHeld())).toBe("INDEX_LOCKED");
    expect(() => successor.assertHeld()).not.toThrow();
  } finally {
    successor.release();
  }
  expect(existsSync(lockDir)).toBe(false);
});

test("a lock near the end of its stale window is neither refreshed nor removed, even when it is ours", () => {
  // The holder's own lock, read on a clock that makes it almost stale: a
  // contender may be removing it at this moment, so stamping or removing
  // it could hit the contender's new lock instead.
  const nearlyStale = (): void => {
    setSystemTime(new Date(Date.now() + STALE_MS - 100));
  };
  const kept = acquireWriterLeaseSync(dbPath);
  nearlyStale();
  try {
    kept.release();
  } finally {
    setSystemTime();
  }
  expect(existsSync(lockDir)).toBe(true);
  rmSync(lockDir, { recursive: true });

  const checked = acquireWriterLeaseSync(dbPath);
  const mtime = statSync(lockDir).mtimeMs;
  nearlyStale();
  try {
    expect(codeOf(() => checked.assertHeld())).toBe("INDEX_LOCKED");
  } finally {
    setSystemTime();
  }
  expect(statSync(lockDir).mtimeMs).toBe(mtime);
  checked.release();
  rmSync(lockDir, { recursive: true });
});

test("a holder whose thread stalled past the margin, with nobody taking over, keeps its lease", () => {
  // A window long enough that the commit margin (half a heartbeat, 1.5 s)
  // and the beat's one-second guard below the window are apart.
  const windowMs = 9_000;
  process.env[WRITER_LOCK_STALE_ENV] = String(windowMs);
  const lease = acquireWriterLeaseSync(dbPath);
  try {
    // The next beat after a long stall (a sleeping laptop): the lock is
    // past the commit margin but still this holder's, so the beat
    // refreshes it.
    setSystemTime(new Date(Date.now() + windowMs - 1_200));
    try {
      writerLeaseCheckIn();
    } finally {
      setSystemTime();
    }
    expect(lease.lost).toBe(false);
    expect(() => lease.assertHeld()).not.toThrow();
  } finally {
    lease.release();
  }
});

test("a clock that went backwards does not let a lost lock pass for held", () => {
  const lease = acquireWriterLeaseSync(dbPath);
  const successor = takeOver();
  try {
    // The lock's age now reads as negative; the forced check still looks.
    setSystemTime(new Date(Date.now() - 60 * 60_000));
    expect(codeOf(() => lease.assertHeld())).toBe("INDEX_LOCKED");
  } finally {
    setSystemTime();
    lease.release();
    successor.release();
  }
});

test("with a long stale window the lock still beats often enough for an older release", () => {
  // Older releases judge the lock by a fixed 60-second window, whatever
  // this one is set to: a 25-second-old lock must already be refreshed.
  process.env[WRITER_LOCK_STALE_ENV] = String(5 * 60_000);
  const lease = acquireWriterLeaseSync(dbPath);
  try {
    const stamped = statSync(lockDir).mtimeMs;
    setSystemTime(new Date(Date.now() + 25_000));
    try {
      writerLeaseCheckIn();
    } finally {
      setSystemTime();
    }
    expect(statSync(lockDir).mtimeMs).not.toBe(stamped);
  } finally {
    lease.release();
  }
});

test.skipIf(CHMOD_CANNOT_DENY)("a commit check that cannot read the lock refuses", () => {
  // The lock behind a directory this process may not search: whose lock
  // it is cannot be found out, which for a commit is not holding it.
  const guarded = join(dir, "guarded");
  mkdirSync(guarded);
  const path = join(guarded, "index.sqlite");
  const lease = acquireWriterLeaseSync(path);
  chmodSync(guarded, 0o600);
  try {
    expect(codeOf(() => lease.assertHeld())).toBe("INDEX_LOCKED");
  } finally {
    chmodSync(guarded, 0o700);
    lease.release();
    rmSync(`${path}.lock`, { recursive: true, force: true });
  }
});

test.skipIf(CHMOD_CANNOT_DENY)(
  "a folder that refuses new entries is that refusal on both acquire paths, not another writer",
  async () => {
    const guarded = join(dir, "readonly");
    mkdirSync(guarded);
    const path = join(guarded, "index.sqlite");
    chmodSync(guarded, 0o500);
    try {
      expect(() => acquireWriterLeaseSync(path)).toThrow(LockDirectoryRefusedError);
      let caught: unknown;
      try {
        await acquireWriterLease(path);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(LockDirectoryRefusedError);
      expect((caught as LockDirectoryRefusedError).code).toBe("EACCES");
    } finally {
      chmodSync(guarded, 0o700);
    }
  },
);

test("a lock the filesystem refuses to stamp is reported as that fault, not as another writer", async () => {
  // Whichever call stamps the directory on this platform refuses it.
  const refuse = (): never => {
    throw Object.assign(new Error("EPERM: operation not permitted, futime"), { code: "EPERM" });
  };
  const spies = [
    spyOn(fs, "futimesSync").mockImplementation(refuse),
    spyOn(fs, "utimesSync").mockImplementation(refuse),
  ];
  let refused: unknown = null;
  try {
    await acquireWriterLease(dbPath);
  } catch (err) {
    refused = err;
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
  expect((refused as NodeJS.ErrnoException | null)?.code).toBe("EPERM");
  expect(String(refused)).toContain("cannot stamp the search index writer lock");
  expect(String(refused)).not.toContain("another writer");
  // The directory the failed attempt made is not left behind.
  expect(existsSync(lockDir)).toBe(false);
});

test("protected work does not start on a lease that is already lost", () => {
  const lease = acquireWriterLeaseSync(dbPath);
  const successor = takeOver();
  try {
    let ran = false;
    expect(
      codeOf(() =>
        keepWriterLeasesFresh(60_000, () => {
          ran = true;
        }),
      ),
    ).toBe("INDEX_LOCKED");
    expect(ran).toBe(false);
  } finally {
    lease.release();
    successor.release();
  }
});

test.skipIf(process.platform === "win32")(
  "the exit hook releases the lock on a signal, and leaves a successor's lock in place",
  async () => {
    const script = join(dir, "holder.ts");
    writeFileSync(
      script,
      [
        importLease,
        `acquireWriterLeaseSync(${JSON.stringify(dbPath)});`,
        'process.stdout.write("ready\\n");',
        "setInterval(() => {}, 1_000);",
      ].join("\n"),
    );
    const holder = async (): Promise<{ kill: () => Promise<void> }> => {
      const child = spawn(process.execPath, [script], {
        env: { ...process.env, [WRITER_LOCK_STALE_ENV]: String(STALE_MS) },
        stdio: ["ignore", "pipe", "ignore"],
      });
      const exited = new Promise<void>((done) => child.once("exit", () => done()));
      await new Promise<void>((ready, fail) => {
        child.stdout.on("data", (chunk: Buffer) => {
          if (chunk.toString().includes("ready")) ready();
        });
        child.once("exit", () => fail(new Error("the holder exited before it was ready")));
      });
      return {
        kill: async () => {
          child.kill("SIGTERM");
          await exited;
        },
      };
    };

    // Its own lock: removed on the way out.
    const first = await holder();
    expect(existsSync(lockDir)).toBe(true);
    await first.kill();
    expect(existsSync(lockDir)).toBe(false);

    // A lock taken over from it: left in place.
    const second = await holder();
    backdateLock();
    const successor = acquireWriterLeaseSync(dbPath);
    try {
      await second.kill();
      expect(existsSync(lockDir)).toBe(true);
      expect(() => successor.assertHeld()).not.toThrow();
    } finally {
      successor.release();
    }
  },
);

test("the lock excludes, and is excluded by, an older release's proper-lockfile", () => {
  const lease = acquireWriterLeaseSync(dbPath);
  try {
    let refused: unknown = null;
    try {
      lockfile.lockSync(dbPath, { stale: 60_000, realpath: false });
    } catch (err) {
      refused = err;
    }
    expect((refused as NodeJS.ErrnoException | null)?.code).toBe("ELOCKED");
    expect(lockfile.checkSync(dbPath, { stale: 60_000, realpath: false })).toBe(true);
  } finally {
    lease.release();
  }

  const release = lockfile.lockSync(dbPath, { stale: 60_000, realpath: false });
  try {
    expect(codeOf(() => acquireWriterLeaseSync(dbPath))).toBe("INDEX_LOCKED");
  } finally {
    release();
  }

  // An older release's abandoned lock is taken over like any other.
  lockfile.lockSync(dbPath, { stale: 60_000, realpath: false, onCompromised: () => {} });
  backdateLock();
  const taken = acquireWriterLeaseSync(dbPath);
  expect(() => taken.assertHeld()).not.toThrow();
  taken.release();
});

test("a write-mode store whose lock was taken over refuses to go on writing", async () => {
  const v = createTempVault("lease-store");
  try {
    const config = makeConfig({ vault: v.vault, dbPath: v.dbPath });
    const store = await Store.open(config, { mode: "write" });
    const successor = (() => {
      rmSync(`${v.dbPath}.lock`, { recursive: true });
      return acquireWriterLeaseSync(v.dbPath);
    })();
    try {
      // The next due beat sees the loss.
      Bun.sleepSync(HEARTBEAT_MS + 100);
      expect(codeOf(() => writerLeaseCheckIn())).toBe("INDEX_LOCKED");
      expect(() => store.setState("after_loss", "1")).toThrow();
    } finally {
      await store.close();
      successor.release();
    }
  } finally {
    v.cleanup();
  }
});

test("a reindex whose lock was taken over refuses its swap and leaves the live index", async () => {
  const v = createTempVault("lease-reindex");
  try {
    writeMd(v.vault, "note.md", "# Note\n\nbody text\n");
    const config = makeConfig({ vault: v.vault, dbPath: v.dbPath });
    await indexVault(config);
    const live = readFileSync(v.dbPath);
    const liveIno = statSync(v.dbPath).ino;
    let successor: WriterLease | null = null;
    let refused: unknown = null;
    try {
      await reindexVault(config, {
        onFile: () => {
          if (successor !== null) return;
          rmSync(`${v.dbPath}.lock`, { recursive: true });
          successor = acquireWriterLeaseSync(v.dbPath);
        },
      });
    } catch (err) {
      refused = err;
    } finally {
      (successor as WriterLease | null)?.release();
    }
    expect((refused as SearchError | null)?.code).toBe("INDEX_LOCKED");
    expect(statSync(v.dbPath).ino).toBe(liveIno);
    expect(readFileSync(v.dbPath).equals(live)).toBe(true);
  } finally {
    v.cleanup();
  }
});

test("a Windows refusal while the previous writer releases the lock is waited out", () => {
  // Windows answers a mkdir of a directory its holder is removing with
  // EPERM, and the name can be gone again by the time anyone looks.
  mkdirSync(lockDir);
  const real = fs.mkdirSync;
  let refusals = 0;
  const spy = spyOn(fs, "mkdirSync").mockImplementation(((
    path: fs.PathLike,
    options?: fs.MakeDirectoryOptions,
  ) => {
    if (String(path) === lockDir && refusals < 2) {
      refusals += 1;
      rmSync(lockDir, { recursive: true, force: true });
      throw windowsRefusal(lockDir);
    }
    return real(path, options);
  }) as typeof fs.mkdirSync);
  try {
    const lease = acquireWriterLeaseSync(dbPath);
    lease.release();
  } finally {
    spy.mockRestore();
  }
  expect(refusals).toBe(2);
});
