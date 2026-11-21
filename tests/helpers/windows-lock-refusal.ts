/**
 * Replays on any host how Windows answers a lock create while another
 * process releases the same name: the create is refused with EPERM or
 * EACCES instead of EEXIST. The lock code reads that answer the same way
 * on every platform, so no platform needs faking.
 */

import { spyOn } from "bun:test";
import type { MakeDirectoryOptions, PathLike } from "node:fs";
import { createRequire } from "node:module";

/**
 * The graceful-fs instance `proper-lockfile` creates its lock directories
 * through, resolved from that package so the spy lands on the same object.
 */
const gracefulFs = createRequire(require.resolve("proper-lockfile"))(
  "graceful-fs",
) as typeof import("node:fs");

/** The error Windows gives a create of `path` while the name is being deleted. */
export function windowsRefusal(
  path: string,
  code: "EPERM" | "EACCES" = "EPERM",
  syscall = "mkdir",
): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: operation not permitted, ${syscall} '${path}'`), {
    code,
    syscall,
    path,
  });
}

/**
 * Make the lock library's `mkdir`/`mkdirSync` of `lockPath` (it creates
 * through graceful-fs) run `onCall` for the first `times` calls; a returned
 * error is thrown (or passed to the callback) instead of creating the
 * directory, null lets the create through. Undo with `mock.restore()`.
 */
export function refuseLockMkdir(
  lockPath: string,
  times: number,
  onCall: (call: number) => NodeJS.ErrnoException | null,
): { calls: () => number } {
  let calls = 0;
  const refusal = (path: PathLike): NodeJS.ErrnoException | null => {
    if (String(path) !== lockPath || calls >= times) return null;
    calls += 1;
    return onCall(calls);
  };
  const realSync = gracefulFs.mkdirSync;
  spyOn(gracefulFs, "mkdirSync").mockImplementation(((
    path: PathLike,
    options?: MakeDirectoryOptions,
  ) => {
    const err = refusal(path);
    if (err !== null) throw err;
    return realSync(path, options);
  }) as typeof gracefulFs.mkdirSync);
  const realAsync = gracefulFs.mkdir;
  spyOn(gracefulFs, "mkdir").mockImplementation(((
    path: PathLike,
    ...rest: [unknown, ...unknown[]]
  ) => {
    const callback = rest[rest.length - 1] as (err: NodeJS.ErrnoException | null) => void;
    const err = refusal(path);
    if (err !== null) {
      queueMicrotask(() => callback(err));
      return;
    }
    (realAsync as (...args: unknown[]) => void)(path, ...rest);
  }) as typeof gracefulFs.mkdir);
  return { calls: () => calls };
}

/**
 * Make the lock library's REMOVAL of `lockPath` (it removes a stale lock
 * directory through graceful-fs) run `onCall` for the first `times` calls; a
 * returned error is thrown (or passed to the callback) instead of removing
 * the directory, null lets the removal through. Undo with `mock.restore()`.
 *
 * This is the POSIX refusal a sticky parent gives: the lock directory
 * belongs to another user, so `rmdir` of it answers `EPERM` although the
 * name is there and nobody holds it.
 */
export function refuseLockRmdir(
  lockPath: string,
  times: number,
  onCall: (call: number) => NodeJS.ErrnoException | null,
): { calls: () => number } {
  let calls = 0;
  const refusal = (path: PathLike): NodeJS.ErrnoException | null => {
    if (String(path) !== lockPath || calls >= times) return null;
    calls += 1;
    return onCall(calls);
  };
  const realSync = gracefulFs.rmdirSync;
  spyOn(gracefulFs, "rmdirSync").mockImplementation(((path: PathLike, ...rest: unknown[]) => {
    const err = refusal(path);
    if (err !== null) throw err;
    return (realSync as (...args: unknown[]) => unknown)(path, ...rest);
  }) as typeof gracefulFs.rmdirSync);
  const realAsync = gracefulFs.rmdir;
  spyOn(gracefulFs, "rmdir").mockImplementation(((
    path: PathLike,
    ...rest: [unknown, ...unknown[]]
  ) => {
    const callback = rest[rest.length - 1] as (err: NodeJS.ErrnoException | null) => void;
    const err = refusal(path);
    if (err !== null) {
      queueMicrotask(() => callback(err));
      return;
    }
    (realAsync as (...args: unknown[]) => void)(path, ...rest);
  }) as typeof gracefulFs.rmdir);
  return { calls: () => calls };
}
