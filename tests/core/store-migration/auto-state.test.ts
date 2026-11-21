/**
 * The automatic migration's device-local state (change
 * auto-store-migration, design D2): the worker lock (claim by exclusive
 * create, takeover when stale, release by token), the failure and waiting
 * state file with the doubling cooldown, and the one-time success notice.
 *
 * Every budget is judged against one instant a test reads once and hands
 * to both the claim and the assertion (a claim's file time is the real
 * time of its write, so a fixed instant in the past would make every
 * fresh claim look written in the future). The start identity of a
 * process is injected: this process has a fixed one and every other
 * process none, so no test depends on whether the platform's identity
 * query works; the cases where it fails on every process run with the
 * query forced to fail.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import lockfile from "proper-lockfile";
import { dirname, join } from "node:path";

import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";
import * as processIdentity from "../../../src/core/store-migration/process-identity.ts";
import { forgetMachineStateCache } from "../../../src/core/state/machine-state.ts";
import { storesStateDir } from "../../../src/core/store/store-paths.ts";
import {
  autoMigrationLockPath,
  autoMigrationNoticePath,
  autoMigrationStateDir,
  autoMigrationStatePath,
  claimAutoMigrationLock,
  clearAutoMigrationFailure,
  clearAutoMigrationNotice,
  clearAutoMigrationWaiting,
  describeAutoMigrationFailure,
  AUTO_MIGRATION_LIVE_PID_CEILING_MS,
  autoMigrationClaimUndecided,
  AUTO_MIGRATION_LOCK_JUDGE,
  AUTO_MIGRATION_UNREADABLE_LOCK_GRACE_MS,
  handAutoMigrationLock,
  ownsAutoMigrationLock,
  readAutoMigrationFailure,
  readAutoMigrationNotice,
  readAutoMigrationRunning,
  readAutoMigrationWaiting,
  recordAutoMigrationFailure,
  recordAutoMigrationNotice,
  recordAutoMigrationWaiting,
  releaseAutoMigrationLock,
  selfHealMigrationCooldownMs,
} from "../../../src/core/store-migration/auto-state.ts";

let root: string;
let vault: string;

const CLAIM_CHILD = join(import.meta.dir, "fixtures", "claim-lock-child.ts");

/** The pid of a process that ran and is gone. */
function deadPid(): number {
  const child = Bun.spawnSync([process.execPath, "-e", "0"], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  return child.pid;
}

/** Plant a claim as another process would have written it. */
function plantClaim(holder: { pid: number; started: string | null }): void {
  mkdirSync(dirname(autoMigrationLockPath(vault)), { recursive: true });
  writeFileSync(
    autoMigrationLockPath(vault),
    JSON.stringify({ token: "planted", since: new Date().toISOString(), ...holder }),
  );
}

/** A fixed instant for the records whose times are only stored, never judged. */
const T0 = new Date("2026-11-17T10:00:00.000Z");
const HOUR = 60 * 60_000;
const EXACT = { judge: AUTO_MIGRATION_LOCK_JUDGE.exact };
const CHEAP = { judge: AUTO_MIGRATION_LOCK_JUDGE.cheap };

/** The start identity this process has in these tests. */
const SELF = "test:this-process";

let identity: ReturnType<typeof spyOn<typeof processIdentity, "processStartIdentity">>;

/** Set the claim's file time to `at`. */
function touchClaim(at: Date): void {
  utimesSync(autoMigrationLockPath(vault), at, at);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "osb-auto-state-"));
  vault = join(root, "vault");
  // The machine state root is cached per vault; a fresh vault each test.
  forgetMachineStateCache();
  identity = spyOn(processIdentity, "processStartIdentity").mockImplementation((pid) =>
    pid === process.pid ? SELF : null,
  );
});

afterEach(() => {
  identity.mockRestore();
  forgetMachineStateCache();
  rmSync(root, { recursive: true, force: true });
});

describe("the worker lock", () => {
  test("the first claim wins and carries the process and the start time", () => {
    const now = new Date();
    const token = claimAutoMigrationLock(vault, now, EXACT);
    expect(token).not.toBeNull();
    expect(ownsAutoMigrationLock(vault, token!)).toBe(true);
    const running = readAutoMigrationRunning(vault, now, EXACT);
    expect(running?.pid).toBe(process.pid);
    expect(running?.since).toBe(now.toISOString());
  });

  test("a release whose mutex stays busy leaves the claim instead of deleting it unlocked", () => {
    const token = claimAutoMigrationLock(vault, new Date(), EXACT);
    expect(token).not.toBeNull();
    const path = autoMigrationLockPath(vault);
    // Another process holds the lock's mutex (a takeover in flight): the
    // claim cannot be checked and removed as one step, so it stays, and
    // turns stale once its process ends.
    const releaseMutex = lockfile.lockSync(path, { realpath: false });
    try {
      releaseAutoMigrationLock(vault, token!);
      expect(existsSync(path)).toBe(true);
    } finally {
      releaseMutex();
    }
    releaseAutoMigrationLock(vault, token!);
    expect(existsSync(path)).toBe(false);
  });

  test("a second claim while one is live is refused", () => {
    const now = new Date();
    const token = claimAutoMigrationLock(vault, now, EXACT);
    expect(token).not.toBeNull();
    expect(claimAutoMigrationLock(vault, now, EXACT)).toBeNull();
    expect(claimAutoMigrationLock(vault, now, CHEAP)).toBeNull();
    releaseAutoMigrationLock(vault, token!);
    expect(existsSync(autoMigrationLockPath(vault))).toBe(false);
  });

  test("a claim whose process is gone is stale at once, however fresh", () => {
    plantClaim({ pid: deadPid(), started: null });
    const now = new Date();
    expect(claimAutoMigrationLock(vault, now, CHEAP)).not.toBeNull();
    expect(readAutoMigrationRunning(vault, now, EXACT)?.pid).toBe(process.pid);
  });

  test("a claim whose pid now names another process is stale at once", () => {
    // This process is alive, but it is not the process that claimed.
    plantClaim({ pid: process.pid, started: "test:another-process" });
    const now = new Date();
    expect(readAutoMigrationRunning(vault, now, EXACT)).toBeNull();
    expect(claimAutoMigrationLock(vault, now, EXACT)).not.toBeNull();
  });

  test("a live holder keeps its claim however long the run takes", () => {
    const now = new Date();
    const token = claimAutoMigrationLock(vault, now, EXACT);
    expect(token).not.toBeNull();
    touchClaim(new Date(now.getTime() - 5 * HOUR));
    expect(claimAutoMigrationLock(vault, now, EXACT)).toBeNull();
    expect(readAutoMigrationRunning(vault, now, EXACT)?.pid).toBe(process.pid);
  });

  test("a live pid that cannot be told apart holds by the age rule", () => {
    // No start identity recorded: the pid alone cannot prove the holder.
    plantClaim({ pid: process.pid, started: null });
    const now = new Date();
    touchClaim(now);
    expect(claimAutoMigrationLock(vault, now, EXACT)).toBeNull();
    touchClaim(new Date(now.getTime() - 2 * HOUR));
    expect(claimAutoMigrationLock(vault, now, EXACT)).not.toBeNull();
  });

  test("an mtime in the future is stale when the holder cannot be told apart", () => {
    plantClaim({ pid: process.pid, started: null });
    const now = new Date();
    touchClaim(new Date(now.getTime() + 3 * HOUR));
    expect(readAutoMigrationRunning(vault, now, EXACT)).toBeNull();
    expect(claimAutoMigrationLock(vault, now, EXACT)).not.toBeNull();
  });

  test("the worker's hand-over puts the claim in its name and keeps its own identity", () => {
    const now = new Date();
    const token = claimAutoMigrationLock(vault, now, EXACT)!;
    // The worker stamped its own identity first; the parent's late
    // hand-over, which knows none, keeps it.
    expect(handAutoMigrationLock(vault, token, process.pid, SELF)).toBe(true);
    expect(handAutoMigrationLock(vault, token, process.pid, null)).toBe(true);
    const record = JSON.parse(readFileSync(autoMigrationLockPath(vault), "utf8")) as {
      started: unknown;
    };
    expect(record.started).toBe(SELF);
    const child = deadPid();
    expect(handAutoMigrationLock(vault, token, child, null)).toBe(true);
    // Handed to a process that is gone: stale.
    expect(readAutoMigrationRunning(vault, now, EXACT)).toBeNull();
    expect(handAutoMigrationLock(vault, "not-the-token", process.pid, null)).toBe(false);
  });

  test("every spelling of one vault shares one claim", () => {
    if (process.platform === "win32") return;
    mkdirSync(vault, { recursive: true });
    const link = join(root, "vault-link");
    symlinkSync(vault, link);
    expect(autoMigrationStateDir(link)).toBe(autoMigrationStateDir(vault));
    const now = new Date();
    const token = claimAutoMigrationLock(vault, now, EXACT);
    expect(token).not.toBeNull();
    expect(claimAutoMigrationLock(link, now, EXACT)).toBeNull();
    releaseAutoMigrationLock(link, token!);
    expect(claimAutoMigrationLock(vault, now, EXACT)).not.toBeNull();
  });

  test("a claim of another process is not released by this one", () => {
    const token = claimAutoMigrationLock(vault, new Date(), EXACT);
    atomicWriteFileSync(
      autoMigrationLockPath(vault),
      JSON.stringify({ token: "other", pid: 1, since: "x" }),
    );
    releaseAutoMigrationLock(vault, token!);
    expect(existsSync(autoMigrationLockPath(vault))).toBe(true);
  });

  test("a damaged lock file reads as running, names no process, and holds only for a short grace", () => {
    mkdirSync(dirname(autoMigrationLockPath(vault)), { recursive: true });
    writeFileSync(autoMigrationLockPath(vault), "not json");
    const now = new Date();
    touchClaim(now);
    // A claim being written reads like this for an instant: the reader
    // says a worker runs, as the claimer leaves it, without a pid to name.
    expect(readAutoMigrationRunning(vault, now, EXACT)).toEqual({ pid: null, since: null });
    expect(claimAutoMigrationLock(vault, now, EXACT)).toBeNull();
    // Past the grace it is damaged: not running, and taken over.
    const later = new Date(now.getTime() + AUTO_MIGRATION_UNREADABLE_LOCK_GRACE_MS + 1000);
    expect(readAutoMigrationRunning(vault, later, EXACT)).toBeNull();
    expect(claimAutoMigrationLock(vault, later, EXACT)).not.toBeNull();
  });

  test("a lock file that cannot be read is never taken over, however old", () => {
    const token = claimAutoMigrationLock(vault, new Date(), EXACT);
    expect(token).not.toBeNull();
    const path = autoMigrationLockPath(vault);
    const real = fs.readFileSync;
    const refused = spyOn(fs, "readFileSync").mockImplementation(((
      file: fs.PathOrFileDescriptor,
      options?: unknown,
    ) => {
      if (String(file) === path) {
        throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      }
      return real(file, options as BufferEncoding);
    }) as typeof fs.readFileSync);
    const later = new Date(Date.now() + 2 * 24 * 60 * 60_000);
    try {
      expect(claimAutoMigrationLock(vault, later, EXACT)).toBeNull();
      expect(claimAutoMigrationLock(vault, later)).toBeNull();
      expect(readAutoMigrationRunning(vault, later, EXACT)).toEqual({ pid: null, since: null });
    } finally {
      refused.mockRestore();
    }
    expect(ownsAutoMigrationLock(vault, token!)).toBe(true);
  });

  test("a claim create refused while the dead worker's removed claim is delete-pending is retried", () => {
    plantClaim({ pid: deadPid(), started: null, worker: "awaited" } as never);
    const path = autoMigrationLockPath(vault);
    const real = fs.openSync;
    let refusals = 0;
    const refused = spyOn(fs, "openSync").mockImplementation(((
      file: fs.PathOrFileDescriptor,
      ...rest: unknown[]
    ) => {
      if (String(file) === path && refusals < 2) {
        // Windows still deletes the claim this call just removed.
        refusals += 1;
        throw Object.assign(new Error(`EPERM: operation not permitted, open '${path}'`), {
          code: "EPERM",
          syscall: "open",
          path,
        });
      }
      return (real as (...args: unknown[]) => number)(file, ...rest);
    }) as typeof fs.openSync);
    const lost: unknown[] = [];
    let token: string | null;
    try {
      token = claimAutoMigrationLock(vault, new Date(), {
        ...EXACT,
        onLostWorker: (worker) => lost.push(worker),
      });
    } finally {
      refused.mockRestore();
    }
    expect(refusals).toBe(2);
    expect(token).not.toBeNull();
    expect(ownsAutoMigrationLock(vault, token!)).toBe(true);
    expect(lost).toHaveLength(1);
  });

  test("the state lives outside the vault, in the device-local folder of all stores", () => {
    for (const path of [
      autoMigrationLockPath(vault),
      autoMigrationStatePath(vault),
      autoMigrationNoticePath(vault),
    ]) {
      expect(path.startsWith(vault)).toBe(false);
      expect(path.startsWith(storesStateDir())).toBe(true);
    }
  });
});

describe("when no start identity can be read (macOS without ps, a failed PowerShell query)", () => {
  beforeEach(() => {
    identity.mockImplementation(() => null);
  });

  for (const judge of [EXACT, CHEAP]) {
    test(`a fresh claim of a live process is refused to a second claimer (${judge.judge})`, () => {
      const now = new Date();
      const token = claimAutoMigrationLock(vault, now, judge);
      expect(token).not.toBeNull();
      // The claim's file time is the instant of the claim.
      touchClaim(now);
      expect(claimAutoMigrationLock(vault, now, judge)).toBeNull();
      expect(readAutoMigrationRunning(vault, now, judge)?.pid).toBe(process.pid);
      expect(ownsAutoMigrationLock(vault, token!)).toBe(true);
    });
  }

  test("a claim older than the age rule is taken over by the exact judge only", () => {
    const now = new Date();
    expect(claimAutoMigrationLock(vault, now, EXACT)).not.toBeNull();
    touchClaim(new Date(now.getTime() - 2 * HOUR));
    // The start leaves a live pid's claim to a worker that judges exactly.
    expect(claimAutoMigrationLock(vault, now, CHEAP)).toBeNull();
    expect(autoMigrationClaimUndecided(vault, now)).toBe(true);
    expect(claimAutoMigrationLock(vault, now, EXACT)).not.toBeNull();
  });
});

describe("the start's judgement: no identity query", () => {
  test("a live holder with a recorded identity is held without querying it, even past an hour", () => {
    plantClaim({ pid: process.pid, started: "test:recorded" });
    const now = new Date();
    touchClaim(new Date(now.getTime() - 5 * HOUR));
    identity.mockClear();
    expect(readAutoMigrationRunning(vault, now, CHEAP)?.pid).toBe(process.pid);
    expect(claimAutoMigrationLock(vault, now, CHEAP)).toBeNull();
    expect(identity).not.toHaveBeenCalled();
  });

  test("past the ceiling, a live pid's claim is the worker's to judge: the start never takes it", () => {
    plantClaim({ pid: process.pid, started: "test:recorded" });
    const now = new Date();
    touchClaim(new Date(now.getTime() - AUTO_MIGRATION_LIVE_PID_CEILING_MS - HOUR));
    // The start cannot tell a hung holder from a reused pid without an
    // identity query: it leaves the claim as it is and says so, and the
    // worker it starts judges exactly.
    expect(claimAutoMigrationLock(vault, now, CHEAP)).toBeNull();
    expect(readFileSync(autoMigrationLockPath(vault), "utf8")).toContain('"planted"');
    expect(autoMigrationClaimUndecided(vault, now)).toBe(true);
    touchClaim(now);
    expect(autoMigrationClaimUndecided(vault, now)).toBe(false);
  });

  test("the start's claim records no identity and reads none, not even its own", () => {
    identity.mockClear();
    const now = new Date();
    expect(claimAutoMigrationLock(vault, now, CHEAP)).not.toBeNull();
    expect(identity).not.toHaveBeenCalled();
    const record = JSON.parse(readFileSync(autoMigrationLockPath(vault), "utf8")) as {
      started: unknown;
    };
    expect(record.started).toBeNull();
  });
});

describe("two claimers of a stale lock at once", () => {
  test("exactly one holds it", async () => {
    plantClaim({ pid: deadPid(), started: null });
    const barrier = join(root, "go");
    const done = join(root, "done");
    const answers = join(root, "answers");
    mkdirSync(answers);
    const claimers = Array.from({ length: 6 }, () =>
      Bun.spawn([process.execPath, "run", CLAIM_CHILD, vault, barrier, answers, done], {
        env: { ...process.env },
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        timeout: 30_000,
      }),
    );
    writeFileSync(barrier, "");
    // Every child answers while all of them are still alive.
    const deadline = Date.now() + 25_000;
    while (readdirSync(answers).length < claimers.length && Date.now() < deadline) {
      // eslint-disable-next-line no-await-in-loop
      await Bun.sleep(20);
    }
    writeFileSync(done, "");
    await Promise.all(claimers.map((p) => p.exited));
    const answered = readdirSync(answers).map((name) => readFileSync(join(answers, name), "utf8"));
    expect(answered.filter((a) => a === "claimed")).toHaveLength(1);
    expect(answered.filter((a) => a === "refused")).toHaveLength(5);
  });
});

describe("the failure state", () => {
  test("a recorded failure carries the reason, the command and the retry time", () => {
    recordAutoMigrationFailure(vault, "2 entr(ies) have no destination", {
      manualCommand: "o2b brain migrate-store --dry-run",
      now: T0,
    });
    const failure = readAutoMigrationFailure(vault);
    expect(failure?.state).toBe("failed");
    expect(failure?.error).toContain("no destination");
    expect(failure?.manualCommand).toBe("o2b brain migrate-store --dry-run");
    expect(failure?.consecutiveFailures).toBe(1);
    expect(failure?.retryAfter).toBe(new Date(T0.getTime() + HOUR).toISOString());
    expect(existsSync(autoMigrationStatePath(vault))).toBe(true);
  });

  test("a repeat failure doubles the cooldown", () => {
    recordAutoMigrationFailure(vault, "first", { manualCommand: "c", now: T0 });
    recordAutoMigrationFailure(vault, "second", {
      manualCommand: "c",
      now: new Date(T0.getTime() + HOUR + 1),
    });
    const failure = readAutoMigrationFailure(vault)!;
    expect(failure.consecutiveFailures).toBe(2);
    expect(failure.retryAfter).toBe(new Date(T0.getTime() + 3 * HOUR + 1).toISOString());
  });

  test("the description names the command the operator should run", () => {
    recordAutoMigrationFailure(vault, "disk full", {
      manualCommand: "o2b brain migrate-store",
      now: T0,
    });
    const line = describeAutoMigrationFailure(readAutoMigrationFailure(vault)!);
    expect(line).toContain("disk full");
    expect(line).toContain("o2b brain migrate-store");
    expect(line).toContain("next automatic attempt");
  });

  test("a success clears the failure", () => {
    recordAutoMigrationFailure(vault, "x", { manualCommand: "c", now: T0 });
    clearAutoMigrationFailure(vault);
    expect(readAutoMigrationFailure(vault)).toBeNull();
  });

  test("the cooldown never exceeds one day", () => {
    expect(selfHealMigrationCooldownMs(1)).toBe(HOUR);
    expect(selfHealMigrationCooldownMs(30)).toBe(24 * HOUR);
  });
});

describe("the waiting state", () => {
  test("a waiting machine records what it waits for, with no retry time", () => {
    const wait: { missing: string[]; firstMachines: string[] } = {
      missing: ["shared/events/dev-a/2026-11.jsonl"],
      firstMachines: ["dev-a"],
    };
    recordAutoMigrationWaiting(vault, wait, T0);
    const waiting = readAutoMigrationWaiting(vault);
    expect(waiting?.state).toBe("waiting");
    expect(waiting?.since).toBe(T0.toISOString());
    expect(waiting?.missing).toEqual(wait.missing);
    expect(waiting?.firstMachines).toEqual(["dev-a"]);
    expect((waiting as unknown as Record<string, unknown>)["retry_after"]).toBeUndefined();
  });

  test("the waiting state is no failure and is cleared when the cut arrives", () => {
    recordAutoMigrationWaiting(vault, { missing: ["s/x"], firstMachines: ["dev-a"] }, T0);
    expect(readAutoMigrationFailure(vault)).toBeNull();
    clearAutoMigrationWaiting(vault);
    expect(readAutoMigrationWaiting(vault)).toBeNull();
  });
});

describe("the one-time notice", () => {
  test("the notice carries the snapshot and the rollback command, and is cleared once taken", () => {
    recordAutoMigrationNotice(vault, { snapshot: "store-migration-20261117" }, T0);
    const notice = readAutoMigrationNotice(vault);
    expect(notice?.snapshot).toBe("store-migration-20261117");
    expect(notice?.at).toBe(T0.toISOString());
    expect(notice?.rollbackCommand).toBe("o2b brain migrate-store --rollback");
    clearAutoMigrationNotice(vault);
    expect(readAutoMigrationNotice(vault)).toBeNull();
  });

  test("once the attempt is released, its record cleared and the notice shown, no folder is left", () => {
    const now = new Date();
    const token = claimAutoMigrationLock(vault, now)!;
    recordAutoMigrationFailure(vault, "an earlier failure", { manualCommand: "c", now });
    recordAutoMigrationNotice(vault, { snapshot: "store-migration-20261117" }, now);
    clearAutoMigrationFailure(vault);
    releaseAutoMigrationLock(vault, token);
    expect(existsSync(autoMigrationStateDir(vault))).toBe(true);
    clearAutoMigrationNotice(vault);
    expect(existsSync(autoMigrationStateDir(vault))).toBe(false);
  });

  test("an unreadable notice is not shown and does not throw", () => {
    mkdirSync(dirname(autoMigrationNoticePath(vault)), { recursive: true });
    writeFileSync(autoMigrationNoticePath(vault), "{broken");
    expect(readAutoMigrationNotice(vault)).toBeNull();
  });
});
