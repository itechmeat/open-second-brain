/**
 * How Open Second Brain starts itself again: the one place that decides
 * the argv of every child that runs this checkout's own code (the
 * automatic store migration worker, the self-heal upgrade and reindex,
 * freshen on read, the deferred session capture), and the options a
 * background child of that kind is spawned with. The census
 * `tests/core/architecture/self-spawn-census.test.ts` holds every such
 * site to this module.
 *
 * The child runs under the runtime that runs this process, named by its
 * absolute path (`process.execPath`), with the entry script by its
 * absolute path: never a PATH lookup. A start launched from an ssh
 * session, or by an agent a macOS GUI started, often has no Bun on PATH
 * although it runs under Bun itself, and a child that looked Bun up there
 * died at once, without a word.
 *
 * The documented fallback, for a process that does not run under Bun (the
 * OpenClaw bundle runs under Node): the POSIX launcher `scripts/o2b` for
 * the CLI, which finds Bun on PATH or in `~/.bun/bin`, and `bun` on PATH
 * for any other entry script and on Windows.
 */
import { closeSync, mkdirSync, openSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, posix, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";

import { dependencyTreeMissing } from "./dependency-tree.ts";

// src/core/maintenance/o2b-command.ts -> repo root
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** The CLI entry point of this checkout. */
export const CLI_ENTRY = join(REPO_ROOT, "src", "cli", "main.ts");

/**
 * The CLI entry that installs a missing dependency tree first
 * (`src/cli/deps-bootstrap.ts`), for a checkout replaced since this
 * process started.
 */
export const CLI_BOOTSTRAP_ENTRY = join(REPO_ROOT, "src", "cli", "deps-bootstrap.ts");

/** The POSIX launcher of this checkout: the fallback for a process not under Bun. */
export const CLI_LAUNCHER = join(REPO_ROOT, "scripts", "o2b");

/** The runtime this process runs under, as {@link selfCommandFor} reads it. */
export interface SelfRuntime {
  /** Whether it is Bun (`process.versions.bun` is set). */
  readonly bun: boolean;
  /** Its executable (`process.execPath`). */
  readonly execPath: string;
}

/** The runtime of this process. */
export function currentRuntime(): SelfRuntime {
  return {
    bun: typeof process.versions["bun"] === "string",
    execPath: process.execPath,
  };
}

/**
 * The argv prefix that runs `entry` (an absolute path to a TypeScript
 * entry script of this checkout) as a child of this process. Pure.
 *
 *  - under Bun with an absolute executable: `[execPath, "run", entry]`, or
 *    `[execPath, "run", bootstrap]` when `bootstrap` is given: the
 *    checkout's dependency tree is missing (a marketplace replacement
 *    removed `node_modules` while this process ran), and the bootstrap
 *    entry installs it as the launcher would before it runs the CLI;
 *  - otherwise, for the CLI entry on POSIX: the launcher
 *    (`launcher`), which finds Bun on its own;
 *  - otherwise: `["bun", "run", entry]`, the PATH lookup as a last resort.
 */
export function selfCommandFor(
  entry: string,
  runtime: SelfRuntime,
  platform: NodeJS.Platform,
  launcher: string | null,
  bootstrap: string | null = null,
): string[] {
  const absolute = (platform === "win32" ? win32 : posix).isAbsolute(runtime.execPath);
  if (runtime.bun && absolute) return [runtime.execPath, "run", bootstrap ?? entry];
  if (launcher !== null && platform !== "win32") return [launcher];
  return ["bun", "run", entry];
}

/** The argv prefix that runs the entry script `entry` of this checkout ({@link selfCommandFor}). */
export function selfCommand(entry: string): string[] {
  return selfCommandFor(entry, currentRuntime(), process.platform, null);
}

/**
 * The argv prefix that runs this checkout's CLI (current plugin version),
 * through the bootstrap entry when the dependency tree is missing (the
 * launcher's rule, `dependency-tree.ts`).
 */
export function o2bCommand(): string[] {
  const bootstrap = dependencyTreeMissing(REPO_ROOT, process.env) ? CLI_BOOTSTRAP_ENTRY : null;
  return selfCommandFor(CLI_ENTRY, currentRuntime(), process.platform, CLI_LAUNCHER, bootstrap);
}

/**
 * The Homebrew SQLite library folders the launcher prefers on macOS
 * (`scripts/_macos-sqlite.sh`): Apple's own library cannot load
 * extensions, which semantic search needs.
 */
export const MACOS_SQLITE_PREFIXES = Object.freeze([
  "/opt/homebrew/opt/sqlite/lib",
  "/usr/local/opt/sqlite/lib",
]);

/**
 * The environment a child of this checkout gets: a copy of `env` (the
 * live one: Bun hands a child spawned without `env` the environment the
 * process STARTED with), with the macOS SQLite setup the launcher would
 * have made, since the child no longer runs through it: on macOS, when
 * `DYLD_LIBRARY_PATH` is not set at all, the first Homebrew SQLite folder
 * that exists. Pure apart from `isDir`.
 */
export function selfSpawnEnv(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  isDir: (path: string) => boolean = directoryExists,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...env };
  if (platform !== "darwin" || env["DYLD_LIBRARY_PATH"] !== undefined) return out;
  const prefix = MACOS_SQLITE_PREFIXES.find((p) => isDir(p));
  if (prefix !== undefined) out["DYLD_LIBRARY_PATH"] = prefix;
  return out;
}

function directoryExists(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The options a background child of this checkout is spawned with.
 * Detached on every platform: Bun on Windows ends a child that is not
 * detached together with its parent, and on POSIX a child that is not
 * detached stays in its parent's process group and session, so a
 * short-lived hook whose group is signalled, or a terminal that closes
 * (SIGHUP to its session), takes the run down with it. Detached, the
 * child leads a session of its own (`setsid`). Its streams are ignored
 * unless `stderr` names a file descriptor it writes its error output to.
 */
export function detachedSpawnOptions(
  env: Record<string, string | undefined>,
  stderr: number | "ignore" = "ignore",
): {
  readonly stdin: "ignore";
  readonly stdout: "ignore";
  readonly stderr: number | "ignore";
  readonly windowsHide: true;
  readonly detached: true;
  readonly env: Record<string, string | undefined>;
} {
  return {
    stdin: "ignore",
    stdout: "ignore",
    stderr,
    windowsHide: true,
    detached: true,
    env: { ...env },
  };
}

/** What {@link spawnSelfDetached} takes besides the argv. */
export interface SelfSpawnOptions {
  /** The child's environment before {@link selfSpawnEnv}; defaults to the live `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /**
   * A file the child's error output goes to, truncated first and opened
   * for appending: a small device-local log a failure can name. Its folder is created; when it
   * cannot be opened the output is dropped, as before.
   */
  readonly stderrLog?: string;
  /**
   * Append to `stderrLog` instead of truncating it: the caller opened the
   * attempt's part of the log itself (`beginWorkerLogAttempt`).
   */
  readonly appendStderrLog?: boolean;
}

/**
 * Start a detached background child running `argv` (built from
 * {@link o2bCommand} or {@link selfCommand}), `unref`ed so it never keeps
 * this process alive. Throws when it cannot be started.
 */
export function spawnSelfDetached(
  argv: ReadonlyArray<string>,
  opts: SelfSpawnOptions = {},
): ReturnType<typeof Bun.spawn> {
  const env = selfSpawnEnv(opts.env ?? process.env);
  let fd: number | null = null;
  if (opts.stderrLog !== undefined) {
    try {
      mkdirSync(dirname(opts.stderrLog), { recursive: true });
      // Truncated, then opened for appending: a child that keeps the log
      // to its tail (`worker-log.ts`) cuts it while it writes, and its
      // writes go on at the new end.
      if (opts.appendStderrLog !== true) writeFileSync(opts.stderrLog, "");
      fd = openSync(opts.stderrLog, "a");
    } catch {
      fd = null;
    }
  }
  try {
    const proc = Bun.spawn([...argv], detachedSpawnOptions(env, fd ?? "ignore"));
    proc.unref();
    return proc;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // the child holds its own handle
      }
    }
  }
}
