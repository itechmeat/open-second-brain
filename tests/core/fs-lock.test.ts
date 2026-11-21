/**
 * The shared answer to "is this failed lock create a held lock?"
 * (`fs-lock.ts`), and the `proper-lockfile` attempts built on it. Windows
 * refuses a create of a name its holder is releasing with EPERM or EACCES;
 * these tests replay that answer on any host, and use POSIX permission bits
 * for a directory that really refuses.
 */

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  rmdirSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import lockfile from "proper-lockfile";
import ts from "typescript";

import {
  isHeldLockCreateError,
  LOCK_PROBE_PREFIX,
  LockDirectoryRefusedError,
  lockDir,
  lockDirSync,
  LockProbeCleanupError,
  LockRemovalRefusedError,
  tryCreateLockFile,
} from "../../src/core/fs-lock.ts";
import { withFileLock } from "../../src/core/reliability/lock.ts";
import { CHMOD_CANNOT_DENY } from "../helpers/platform.ts";
import {
  refuseLockMkdir,
  refuseLockRmdir,
  windowsRefusal,
} from "../helpers/windows-lock-refusal.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "osb-fs-lock-"));
});
afterEach(() => {
  mock.restore();
  rmSync(root, { recursive: true, force: true });
});

describe("isHeldLockCreateError", () => {
  test("EEXIST is a held lock on every platform", () => {
    const eexist = Object.assign(new Error("EEXIST"), { code: "EEXIST" });
    expect(isHeldLockCreateError(eexist, join(root, "x.lock"), "directory")).toBe(true);
  });

  test("a Windows EPERM or EACCES on a name something holds is a held lock", () => {
    const lockPath = join(root, "held.lock");
    writeFileSync(lockPath, "");
    expect(isHeldLockCreateError(windowsRefusal(lockPath, "EPERM"), lockPath, "directory")).toBe(
      true,
    );
    expect(isHeldLockCreateError(windowsRefusal(lockPath, "EACCES"), lockPath, "directory")).toBe(
      true,
    );
  });

  test("a Windows EPERM after the name went away is a release that finished", () => {
    const lockPath = join(root, "released.lock");
    expect(isHeldLockCreateError(windowsRefusal(lockPath), lockPath, "directory")).toBe(true);
    // The probe that told it from a refusing directory leaves nothing behind.
    expect(readdirSync(root)).toEqual([]);
  });

  test.skipIf(process.platform !== "darwin" || process.getuid?.() === 0)(
    "uses the failed file-create primitive when an ACL denies files but allows directories",
    () => {
      const dir = join(root, "acl-file-deny");
      mkdirSync(dir);
      const acl = `user:${userInfo().username} deny add_file`;
      execFileSync("chmod", ["+a", acl, dir]);
      try {
        let fileError: unknown;
        try {
          const fd = openSync(join(dir, "probe"), "wx");
          closeSync(fd);
        } catch (err) {
          fileError = err;
        }
        const fileErrorCode = (fileError as NodeJS.ErrnoException | undefined)?.code;
        expect(["EACCES", "EPERM"].includes(fileErrorCode ?? "")).toBe(true);
        const sibling = join(dir, "directory-probe");
        mkdirSync(sibling);
        rmdirSync(sibling);

        const lockPath = join(dir, "file.lock");
        let caught: unknown;
        try {
          isHeldLockCreateError(fileError, lockPath, "file");
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(LockDirectoryRefusedError);
      } finally {
        execFileSync("chmod", ["-a", acl, dir]);
      }
    },
  );

  test.skipIf(process.platform !== "darwin" || process.getuid?.() === 0)(
    "surfaces a probe removal refusal with the probe path and cause",
    () => {
      const dir = join(root, "acl-delete-deny");
      mkdirSync(dir);
      const acl = `user:${userInfo().username} deny delete_child`;
      execFileSync("chmod", ["+a", acl, dir]);
      try {
        const lockPath = join(dir, "held.lock");
        let caught: unknown;
        try {
          isHeldLockCreateError(windowsRefusal(lockPath), lockPath, "file");
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(LockProbeCleanupError);
        expect((caught as Error).message).toContain("cannot remove lock probe");
        expect((caught as LockProbeCleanupError).path).toContain(LOCK_PROBE_PREFIX);
        expect((caught as Error).cause).toBeDefined();
      } finally {
        execFileSync("chmod", ["-a", acl, dir]);
      }
    },
  );

  test.skipIf(process.platform !== "darwin" || process.getuid?.() === 0)(
    "keeps a directory-create refusal immediate when ACL still allows files",
    async () => {
      const dir = join(root, "acl-directory-deny");
      mkdirSync(dir);
      const target = join(dir, "target");
      writeFileSync(target, "");
      const acl = `user:${userInfo().username} deny add_subdirectory`;
      execFileSync("chmod", ["+a", acl, dir]);
      try {
        const fd = openSync(join(dir, "file-probe"), "wx");
        closeSync(fd);
        rmSync(join(dir, "file-probe"));
        let directoryError: unknown;
        try {
          mkdirSync(join(dir, "directory-probe"));
        } catch (err) {
          directoryError = err;
        }
        expect(
          ["EACCES", "EPERM"].includes((directoryError as NodeJS.ErrnoException)?.code ?? ""),
        ).toBe(true);

        const lockSpy = spyOn(lockfile, "lock");
        await expect(
          lockDir(target, {
            stale: 10_000,
            retries: 2,
            minTimeoutMs: 1,
            maxTimeoutMs: 1,
            retryOnError: () => true,
          }),
        ).rejects.toBeInstanceOf(LockDirectoryRefusedError);
        expect(lockSpy).toHaveBeenCalledTimes(1);
      } finally {
        execFileSync("chmod", ["-a", acl, dir]);
      }
    },
  );

  test("a failed directory create uses a directory probe", () => {
    const dir = join(root, "directory-probe");
    mkdirSync(dir);
    const lockPath = join(dir, "held.lock");
    expect(isHeldLockCreateError(windowsRefusal(lockPath), lockPath, "directory")).toBe(true);
    expect(readdirSync(dir)).toEqual([]);
  });

  test.skipIf(CHMOD_CANNOT_DENY)(
    "a refusal from a directory that refuses new entries names that directory",
    () => {
      const dir = join(root, "locked-down");
      mkdirSync(dir);
      chmodSync(dir, 0o500);
      try {
        const lockPath = join(dir, "x.lock");
        let caught: unknown;
        try {
          isHeldLockCreateError(windowsRefusal(lockPath), lockPath, "directory");
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(LockDirectoryRefusedError);
        expect((caught as LockDirectoryRefusedError).code).toBe("EPERM");
        expect((caught as Error).message).toContain(`its directory ${dir} refuses new entries`);
      } finally {
        chmodSync(dir, 0o700);
      }
    },
  );

  test("a read-only mount is a named refusal at once, without a probe", () => {
    const lockPath = join(root, "store.lock");
    const erofs = Object.assign(new Error("EROFS: read-only file system"), { code: "EROFS" });
    let caught: unknown;
    try {
      isHeldLockCreateError(erofs, lockPath, "directory");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(LockDirectoryRefusedError);
    expect((caught as LockDirectoryRefusedError).code).toBe("EROFS");
    expect((caught as Error).message).toContain("read-only");
    expect((caught as Error).message).toContain("writable mount");
    expect(readdirSync(root)).toEqual([]);
  });

  test("a lock name at the longest component length still probes its directory", () => {
    // 250 characters and ".lock" make a 255-character name, the usual
    // component limit; a probe named after the lock would not fit.
    const lockPath = join(root, `${"a".repeat(250)}.lock`);
    expect(isHeldLockCreateError(windowsRefusal(lockPath), lockPath, "directory")).toBe(true);
    expect(isHeldLockCreateError(windowsRefusal(lockPath), lockPath, "file")).toBe(true);
    expect(readdirSync(root)).toEqual([]);
  });

  test("the refusal names the resolved lock path for a relative target", () => {
    const cause = windowsRefusal("pref.yaml.lock");
    const refused = new LockDirectoryRefusedError("pref.yaml.lock", cause);
    expect(refused.path).toBe(resolve("pref.yaml.lock"));
    expect(refused.message).toContain(resolve("pref.yaml.lock"));
  });

  test("any other failure is not a held lock", () => {
    const enospc = Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
    expect(isHeldLockCreateError(enospc, join(root, "x.lock"), "directory")).toBe(false);
  });

  test("an unexpected inspection error is surfaced with the path and its cause", () => {
    const lockPath = join(root, "lock.lock");
    const realLstat = fs.lstatSync;
    spyOn(fs, "lstatSync").mockImplementation(((path: fs.PathLike, ...rest: unknown[]) => {
      if (String(path) === lockPath) {
        throw Object.assign(new Error("simulated inspection I/O failure"), { code: "EIO" });
      }
      return (realLstat as (...args: unknown[]) => unknown)(path, ...rest);
    }) as typeof fs.lstatSync);
    let caught: unknown;
    try {
      isHeldLockCreateError(windowsRefusal(lockPath, "EPERM"), lockPath, "directory");
    } catch (err) {
      caught = err;
    }
    expect((caught as Error).message).toContain(lockPath);
    expect(((caught as Error).cause as NodeJS.ErrnoException).code).toBe("EIO");
    expect((caught as NodeJS.ErrnoException).path).toBe(lockPath);
  });
});

describe("lockDirSync", () => {
  test("a Windows refusal of the lock directory is reported as ELOCKED", () => {
    const target = join(root, "settings.yaml");
    mkdirSync(`${target}.lock`);
    refuseLockMkdir(`${target}.lock`, 1, () => windowsRefusal(`${target}.lock`));
    let caught: unknown;
    try {
      lockDirSync(target, { stale: 10_000 });
    } catch (err) {
      caught = err;
    }
    expect((caught as NodeJS.ErrnoException).code).toBe("ELOCKED");
    expect(((caught as Error).cause as NodeJS.ErrnoException).code).toBe("EPERM");
  });

  test("a refused name that is already free is taken at once, not reported held", () => {
    const target = join(root, "settings.yaml");
    // The holder's release went through between the refusal and the look.
    const refusals = refuseLockMkdir(`${target}.lock`, 1, () => windowsRefusal(`${target}.lock`));
    const release = lockDirSync(target, { stale: 10_000 });
    release();
    expect(refusals.calls()).toBe(1);
  });

  test("a name that stays delete-pending is a held lock after a short, bounded settle", () => {
    const target = join(root, "settings.yaml");
    const refusals = refuseLockMkdir(`${target}.lock`, Number.MAX_SAFE_INTEGER, () =>
      windowsRefusal(`${target}.lock`),
    );
    const started = Date.now();
    let caught: unknown;
    try {
      lockDirSync(target, { stale: 10_000 });
    } catch (err) {
      caught = err;
    }
    expect((caught as NodeJS.ErrnoException).code).toBe("ELOCKED");
    expect(refusals.calls()).toBeGreaterThan(1);
    expect(refusals.calls()).toBeLessThanOrEqual(5);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test.skipIf(process.platform !== "darwin" || process.getuid?.() === 0)(
    "classifies a relative target using proper-lockfile's resolved lock path",
    () => {
      const fixture = join(root, "relative-lock");
      const cwd = join(fixture, "cwd");
      mkdirSync(cwd, { recursive: true });
      const acl = `user:${userInfo().username} deny add_subdirectory`;
      execFileSync("chmod", ["+a", acl, fixture]);
      const originalCwd = process.cwd();
      try {
        process.chdir(cwd);
        let caught: unknown;
        try {
          lockDirSync(".", { stale: 10_000 });
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(LockDirectoryRefusedError);
        expect((caught as LockDirectoryRefusedError).path).toBe(`${resolve(".")}.lock`);
      } finally {
        process.chdir(originalCwd);
        execFileSync("chmod", ["-a", acl, fixture]);
      }
    },
  );
});

describe("a stale lock name this process may not remove", () => {
  /**
   * A lock directory older than the window the lock library judges by is
   * removed by the library itself. POSIX can refuse that removal: the
   * directory belongs to another user in a sticky parent, so `rmdir` answers
   * `EPERM` although the name is there and nobody holds it. The refusal is
   * not contention, and waiting cannot clear it, so it is surfaced at once
   * with its path and cause instead of being waited out and reported as a
   * lock that is busy.
   */
  function plantStaleLock(target: string): string {
    const lockPath = `${target}.lock`;
    mkdirSync(lockPath);
    const old = new Date(Date.now() - 5_000);
    utimesSync(lockPath, old, old);
    return lockPath;
  }

  test("the removal refusal is surfaced at once, not waited out as a held lock", () => {
    const target = join(root, "settings.yaml");
    const lockPath = plantStaleLock(target);
    const removals = refuseLockRmdir(lockPath, Number.MAX_SAFE_INTEGER, () =>
      windowsRefusal(lockPath, "EPERM", "rmdir"),
    );
    const started = Date.now();
    let caught: unknown;
    try {
      lockDirSync(target, { stale: 2_000 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(LockRemovalRefusedError);
    expect((caught as LockRemovalRefusedError).path).toBe(resolve(lockPath));
    expect((caught as LockRemovalRefusedError).code).toBe("EPERM");
    expect(((caught as Error).cause as NodeJS.ErrnoException).code).toBe("EPERM");
    // Not contention: no "busy" answer, and no wait for one.
    expect((caught as NodeJS.ErrnoException).code).not.toBe("ELOCKED");
    expect(Date.now() - started).toBeLessThan(1_000);
    // The settle window is the test for whether the removal clears, so the
    // removal is tried more than once before it is called permanent.
    expect(removals.calls()).toBeGreaterThan(1);
  });

  test("the waiting lock surfaces the removal refusal too, and never retries it", async () => {
    const target = join(root, "schema.yaml");
    const lockPath = plantStaleLock(target);
    const removals = refuseLockRmdir(lockPath, Number.MAX_SAFE_INTEGER, () =>
      windowsRefusal(lockPath, "EPERM", "rmdir"),
    );
    await expect(
      lockDir(target, {
        stale: 2_000,
        retries: 3,
        minTimeoutMs: 1,
        maxTimeoutMs: 1,
        retryOnError: () => true,
      }),
    ).rejects.toBeInstanceOf(LockRemovalRefusedError);
    expect(removals.calls()).toBeGreaterThan(1);
  });

  test("a removal refused while the name is delete pending is waited out, not refused", () => {
    // The Windows sequence: another contender took the stale name over, so
    // the name is delete pending - it refuses any look at it and the
    // removal of it - and both clear when the last handle to it closes. A
    // refusal that says a release is going through is not a removal that
    // cannot be done: while it lasts past the settle window the name reads
    // as held (a lock changing hands), never as LockRemovalRefusedError,
    // and the lock is taken once the release has finished.
    const target = join(root, "settings.yaml");
    const lockPath = plantStaleLock(target);
    let releasing = true;
    let refusedLooks = 0;
    const realLstat = fs.lstatSync;
    const looks = spyOn(fs, "lstatSync").mockImplementation(((
      path: fs.PathLike,
      ...rest: unknown[]
    ) => {
      if (releasing && String(path) === lockPath) {
        refusedLooks += 1;
        throw Object.assign(new Error(`EPERM: operation not permitted, lstat '${lockPath}'`), {
          code: "EPERM",
          syscall: "lstat",
          path: lockPath,
        });
      }
      return (realLstat as (...args: unknown[]) => unknown)(path, ...rest);
    }) as typeof fs.lstatSync);
    try {
      const removals = refuseLockRmdir(lockPath, Number.MAX_SAFE_INTEGER, () => {
        if (releasing) return windowsRefusal(lockPath, "EPERM", "rmdir");
        // The release finished: the name is free again.
        rmSync(lockPath, { recursive: true, force: true });
        return null;
      });
      // The release outlasts the whole settle window: a held lock.
      let caught: unknown;
      try {
        lockDirSync(target, { stale: 2_000 });
      } catch (err) {
        caught = err;
      }
      // Non-vacuous: every answer came through the refused look.
      expect(refusedLooks).toBeGreaterThan(1);
      expect(removals.calls()).toBe(refusedLooks);
      expect(caught).not.toBeInstanceOf(LockRemovalRefusedError);
      expect((caught as NodeJS.ErrnoException).code).toBe("ELOCKED");
      // The release finishes: the next attempt takes the lock.
      releasing = false;
      const release = lockDirSync(target, { stale: 2_000 });
      release();
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      looks.mockRestore();
      mock.restore();
    }
  });
});

describe("a record that cannot be written into a lock name", () => {
  test("the write's error is the answer, and the file the create made is gone", () => {
    const lockPath = join(root, "upgrade.lock");
    let caught: unknown;
    try {
      tryCreateLockFile(lockPath, () => {
        throw Object.assign(new Error("EPERM: write denied"), { code: "EPERM" });
      });
    } catch (err) {
      caught = err;
    }
    expect((caught as NodeJS.ErrnoException).code).toBe("EPERM");
    // The empty file would read as a claim of unknown identity and hold the
    // name for the stale window; it is removed with the failed write.
    expect(existsSync(lockPath)).toBe(false);
  });

  test("a record that was written stays in the name it was written to", () => {
    const lockPath = join(root, "upgrade.lock");
    const outcome = tryCreateLockFile(lockPath, (fd) => {
      writeFileSync(fd, "record");
    });
    expect(outcome).toEqual({ created: undefined });
    expect(readFileSync(lockPath, "utf8")).toBe("record");
  });

  test("a name another holder has is not written into", () => {
    const lockPath = join(root, "upgrade.lock");
    writeFileSync(lockPath, "theirs");
    const outcome = tryCreateLockFile(lockPath, (fd) => {
      writeFileSync(fd, "mine");
    });
    expect("held" in outcome).toBe(true);
    expect(readFileSync(lockPath, "utf8")).toBe("theirs");
  });
});

describe("lockDir", () => {
  test("retries opted-in transient acquisition failures but preserves the last error", async () => {
    const target = join(root, "transient.yaml");
    const original = lockfile.lock;
    let calls = 0;
    spyOn(lockfile, "lock").mockImplementation(async (...args) => {
      calls++;
      if (calls === 1) throw Object.assign(new Error("temporary I/O failure"), { code: "EIO" });
      return original(...args);
    });
    const release = await lockDir(target, {
      stale: 10_000,
      retries: 1,
      minTimeoutMs: 1,
      maxTimeoutMs: 1,
      retryOnError: () => true,
    });
    await release();
    expect(calls).toBe(2);
  });

  test("retries a transient inspection failure of the refused name for opted-in callers", async () => {
    const target = join(root, "inline.md");
    const lockPath = `${resolve(target)}.lock`;
    const original = lockfile.lock;
    let lockCalls = 0;
    spyOn(lockfile, "lock").mockImplementation(async (...args) => {
      lockCalls++;
      if (lockCalls === 1) throw windowsRefusal(lockPath);
      return original(...args);
    });
    const realLstat = fs.lstatSync;
    let injectedFaults = 0;
    spyOn(fs, "lstatSync").mockImplementation(((path: fs.PathLike, ...rest: unknown[]) => {
      if (String(path) === lockPath && injectedFaults === 0) {
        injectedFaults += 1;
        throw Object.assign(new Error("simulated inspection I/O failure"), { code: "EIO" });
      }
      return (realLstat as (...args: unknown[]) => unknown)(path, ...rest);
    }) as typeof fs.lstatSync);
    const release = await lockDir(target, {
      stale: 10_000,
      retries: 2,
      minTimeoutMs: 1,
      maxTimeoutMs: 1,
      retryOnError: () => true,
    });
    await release();
    expect(lockCalls).toBe(2);
    // The inspection fault was really injected: without it there would be
    // nothing to retry, and the second library call would be the ordinary
    // handoff recovery instead of the recovery from the inspection error.
    expect(injectedFaults).toBe(1);
  });

  test("a read-only mount and a probe that cannot be removed are never retried", async () => {
    const target = join(root, "inline.md");
    const lockPath = `${resolve(target)}.lock`;
    let lockCalls = 0;
    spyOn(lockfile, "lock").mockImplementation(async () => {
      lockCalls++;
      throw Object.assign(new Error("EROFS: read-only file system"), { code: "EROFS" });
    });
    const options = {
      stale: 10_000,
      retries: 5,
      minTimeoutMs: 1,
      maxTimeoutMs: 1,
      retryOnError: () => true,
    };
    await expect(lockDir(target, options)).rejects.toBeInstanceOf(LockDirectoryRefusedError);
    expect(lockCalls).toBe(1);

    mock.restore();
    lockCalls = 0;
    spyOn(lockfile, "lock").mockImplementation(async () => {
      lockCalls++;
      throw windowsRefusal(lockPath);
    });
    const realRmdir = fs.rmdirSync;
    spyOn(fs, "rmdirSync").mockImplementation(((path: fs.PathLike, ...rest: unknown[]) => {
      if (String(path).includes(LOCK_PROBE_PREFIX)) {
        throw Object.assign(new Error("EPERM: delete denied"), { code: "EPERM" });
      }
      return (realRmdir as (...args: unknown[]) => unknown)(path, ...rest);
    }) as typeof fs.rmdirSync);
    let caught: unknown;
    try {
      await lockDir(target, options);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(LockProbeCleanupError);
    expect(lockCalls).toBe(1);
    // The test's own probe is left by the denied removal; clear it.
    for (const name of readdirSync(root)) rmSync(join(root, name), { recursive: true });
  });

  test("waits out Windows refusals while the holder releases, within its retries", async () => {
    const target = join(root, "schema.yaml");
    mkdirSync(`${target}.lock`);
    const refusals = refuseLockMkdir(`${target}.lock`, 3, (call) => {
      if (call === 2) rmSync(`${target}.lock`, { recursive: true, force: true });
      return windowsRefusal(`${target}.lock`);
    });
    const release = await lockDir(target, {
      stale: 10_000,
      retries: 5,
      minTimeoutMs: 5,
      maxTimeoutMs: 5,
    });
    await release();
    expect(refusals.calls()).toBe(3);
  });

  test("a refusal past the retries is ELOCKED, not the raw EPERM", async () => {
    const target = join(root, "schema.yaml");
    mkdirSync(`${target}.lock`);
    refuseLockMkdir(`${target}.lock`, Number.MAX_SAFE_INTEGER, () =>
      windowsRefusal(`${target}.lock`),
    );
    let caught: unknown;
    try {
      await lockDir(target, { stale: 10_000, retries: 2, minTimeoutMs: 1, maxTimeoutMs: 1 });
    } catch (err) {
      caught = err;
    }
    expect((caught as NodeJS.ErrnoException).code).toBe("ELOCKED");
  });

  test("withFileLock runs its callback once the releasing holder is gone", async () => {
    const target = join(root, "health-baseline.json");
    mkdirSync(`${target}.lock`);
    refuseLockMkdir(`${target}.lock`, 2, (call) => {
      if (call === 2) rmSync(`${target}.lock`, { recursive: true, force: true });
      return windowsRefusal(`${target}.lock`, "EACCES");
    });
    const ran = await withFileLock(target, { retries: 3, retryDelayMs: 5 }, () => "ran");
    expect(ran).toBe("ran");
  });
});

/**
 * The names a binding pattern binds.
 */
function boundNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((element) =>
    ts.isOmittedExpression(element) ? [] : boundNames(element.name),
  );
}

/**
 * Whether `node` declares `name` in its own scope: a parameter, a binding,
 * a function or class of that name, a catch parameter.
 */
function declaresName(node: ts.Node, name: string): boolean {
  if (ts.isFunctionLike(node)) {
    for (const parameter of node.parameters) {
      if (boundNames(parameter.name).includes(name)) return true;
    }
  }
  if (ts.isVariableDeclaration(node) && boundNames(node.name).includes(name)) return true;
  if (
    (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isEnumDeclaration(node)) &&
    node.name?.text === name
  ) {
    return true;
  }
  if (
    ts.isCatchClause(node) &&
    node.variableDeclaration &&
    boundNames(node.variableDeclaration.name).includes(name)
  ) {
    return true;
  }
  return false;
}

/**
 * Whether the identifier `id` names the import at its place in the tree, or
 * something that shadows it there: a parameter, a local, a function of the
 * same name. The binding is what a call reaches, not its spelling.
 */
function resolvesToImport(
  id: ts.Identifier,
  bindingDeclarations: ReadonlyMap<string, ts.Node>,
): boolean {
  for (let node: ts.Node | undefined = id.parent; node; node = node.parent) {
    if (declaresName(node, id.text)) return false;
    if (ts.isBlock(node) || ts.isSourceFile(node) || ts.isModuleBlock(node)) {
      for (const statement of node.statements) {
        if (ts.isVariableStatement(statement)) {
          for (const declaration of statement.declarationList.declarations) {
            // The declaration that binds the import is the binding itself,
            // not a shadow of it.
            if (bindingDeclarations.get(id.text) === declaration) continue;
            if (boundNames(declaration.name).includes(id.text)) return false;
          }
        }
        if (
          (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
          statement.name?.text === id.text
        ) {
          return false;
        }
      }
    }
    if (ts.isForStatement(node) || ts.isForOfStatement(node) || ts.isForInStatement(node)) {
      const initializer = node.initializer;
      if (initializer && ts.isVariableDeclarationList(initializer)) {
        for (const declaration of initializer.declarations) {
          if (boundNames(declaration.name).includes(id.text)) return false;
        }
      }
    }
  }
  return true;
}

/** A call that could be a lock: the binding it names and how it is called. */
interface LockCallCandidate {
  /** The identifier the call reaches. */
  readonly id: ts.Identifier;
  /** Whether the call is a member of that binding (`pl.lock(...)`). */
  readonly member: boolean;
}

/** Every call in the tree that could reach a lock. */
function lockCallCandidates(source: ts.SourceFile): LockCallCandidate[] {
  const out: LockCallCandidate[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee)) out.push({ id: callee, member: false });
      else if (
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        (callee.name.text === "lock" || callee.name.text === "lockSync")
      ) {
        out.push({ id: callee.expression, member: true });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

/**
 * Whether `text` takes a lock through a binding it imports from
 * `proper-lockfile`: the default export (itself the async lock), a named
 * `lock`/`lockSync` under any alias, or a member `lock`/`lockSync` of the
 * default or namespace binding.
 *
 * The call is matched to the BINDING, not to its spelling: a module that
 * imports `pl` and also has a function whose parameter is called `pl` calls
 * its own parameter there, not the lock. Unrelated functions named `lock`
 * do not count either.
 */
function takesProperLockfileLock(text: string): boolean {
  const source = ts.createSourceFile(
    "census.ts",
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  /** Local names bound to the lock function itself. */
  const callable = new Set<string>();
  /** Local names bound to the module object (its `lock`/`lockSync` members). */
  const holders = new Set<string>();
  /** Whether the module imports from `proper-lockfile` at all. */
  let imports = false;
  /** The declaration that binds each imported name: it is the binding, not a shadow. */
  const bindingDeclarations = new Map<string, ts.Node>();
  const addDefault = (local: string): void => {
    // The default export is the async lock, and it carries `lockSync` and
    // `check` as members of its own.
    callable.add(local);
    holders.add(local);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const specifier = node.moduleSpecifier;
      if (!ts.isStringLiteral(specifier) || specifier.text !== "proper-lockfile") {
        ts.forEachChild(node, visit);
        return;
      }
      imports = true;
      const clause = node.importClause;
      if (clause?.name) addDefault(clause.name.text);
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) {
        holders.add(bindings.name.text);
      } else if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          const imported = element.propertyName?.text ?? element.name.text;
          if (imported === "lock" || imported === "lockSync") callable.add(element.name.text);
          else if (imported === "default") addDefault(element.name.text);
        }
      }
      return;
    }
    // `const pl = require("proper-lockfile")`
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const initializer = node.initializer;
      const argument = ts.isCallExpression(initializer) ? initializer.arguments[0] : undefined;
      if (
        ts.isCallExpression(initializer) &&
        ts.isIdentifier(initializer.expression) &&
        initializer.expression.text === "require" &&
        initializer.arguments.length === 1 &&
        argument !== undefined &&
        ts.isStringLiteral(argument) &&
        argument.text === "proper-lockfile"
      ) {
        imports = true;
        for (const name of boundNames(node.name)) {
          addDefault(name);
          bindingDeclarations.set(name, node);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  // A module that names `proper-lockfile` but whose import the parse did
  // not find is a module this census cannot read. It counts as taking a
  // lock, so a parser that stops understanding the sources fails the
  // census loudly instead of hiding a lock caller.
  if (!imports) return text.includes("proper-lockfile");
  for (const candidate of lockCallCandidates(source)) {
    const name = candidate.id.text;
    if (candidate.member ? !holders.has(name) : !callable.has(name)) continue;
    if (!resolvesToImport(candidate.id, bindingDeclarations)) continue;
    return true;
  }
  return false;
}

describe("census", () => {
  test("the census sees a lock taken through any proper-lockfile binding", () => {
    const takes = [
      'import lockfile from "proper-lockfile";\nawait lockfile(target);',
      'import lockfile from "proper-lockfile";\nlockfile.lockSync(target);',
      'import { lock as acquire } from "proper-lockfile";\nawait acquire(target);',
      'import { lockSync } from "proper-lockfile";\nlockSync(target);',
      'import * as pl from "proper-lockfile";\nawait pl.lock(target);',
      'import { default as pl } from "proper-lockfile";\npl(target);',
      'const pl = require("proper-lockfile");\npl.lockSync(target);',
      'import pl from "proper-lockfile";\nfunction run(pl: () => void) { pl(); }\npl(target);',
    ];
    for (const text of takes)
      expect({ text, takes: takesProperLockfileLock(text) }).toEqual({ text, takes: true });
    const checks = [
      'import lockfile from "proper-lockfile";\nlockfile.checkSync(target);',
      'import { check } from "proper-lockfile";\nfunction lock() {}\nlock();\nmutex.lock();\ncheck(target);',
      // The imported binding is shadowed where it is called: the call
      // reaches the parameter, not the lock.
      'import pl from "proper-lockfile";\nfunction run(pl: () => void) { pl(); }',
      'import * as pl from "proper-lockfile";\nfunction run(pl: () => void) { pl(); }',
      'import { lock as pl } from "proper-lockfile";\nfunction run(pl: () => void) { pl(); }',
      'import pl from "proper-lockfile";\nfunction run() { const pl = () => {}; pl(); }',
    ];
    for (const text of checks)
      expect({ text, takes: takesProperLockfileLock(text) }).toEqual({ text, takes: false });
  });

  test("a shadowed name is not the imported binding, in a fixture file too", () => {
    const fixture = readFileSync(
      join(import.meta.dir, "../fixtures/proper-lockfile-shadow.ts"),
      "utf8",
    );
    expect(takesProperLockfileLock(fixture)).toBe(false);
    // The same module with a call outside the shadowing scope takes the lock.
    const taking = `${fixture}\nexport function take(target: string) { pl(target); }\n`;
    expect(takesProperLockfileLock(taking)).toBe(true);
  });

  // Every lock goes through `fs-lock.ts`, so Windows' answer for a lock
  // changing hands is read in one place. A new `proper-lockfile` caller
  // that takes a lock on its own would bring the lost write back.
  test("only fs-lock.ts takes a proper-lockfile lock; others may only check one", () => {
    const repoRoot = join(import.meta.dir, "../..");
    // The glob answers with the platform's separator; on Windows that is a
    // backslash, so the paths are compared in one form.
    const importers = Array.from(new Bun.Glob("**/*.ts").scanSync({ cwd: repoRoot }))
      .map((rel) => rel.replaceAll("\\", "/"))
      .filter((rel) => !rel.startsWith("tests/") && !rel.startsWith("node_modules/"))
      .filter((rel) => /["']proper-lockfile["']/.test(readFileSync(join(repoRoot, rel), "utf8")));
    expect(importers).toContain("src/core/fs-lock.ts");
    expect(
      takesProperLockfileLock(readFileSync(join(repoRoot, "src/core/fs-lock.ts"), "utf8")),
    ).toBe(true);
    for (const rel of importers) {
      if (rel === "src/core/fs-lock.ts") continue;
      const text = readFileSync(join(repoRoot, rel), "utf8");
      expect({ rel, takesLock: takesProperLockfileLock(text) }).toEqual({ rel, takesLock: false });
    }
  });
});
