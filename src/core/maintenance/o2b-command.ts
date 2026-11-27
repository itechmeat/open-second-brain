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

/** A background process {@link spawnSelfDetached} started. */
export interface SelfSpawned {
  /** The pid of the process running `argv` (not of a launcher between them). */
  readonly pid: number;
}

/**
 * The environment variable that carries the argv and the working folder
 * from {@link spawnSelfDetached} to its launcher ({@link REPARENT_LAUNCHER}).
 * The launcher takes it out before it starts the child.
 */
export const REPARENT_PAYLOAD_ENV = "O2B_REPARENT_PAYLOAD";

/**
 * The launcher between this process and a background child on POSIX, run
 * as `<runtime> -e <this>` (Bun or Node: only `node:child_process`): it
 * starts the child detached (a session of its own) with its own error
 * output, prints `pid:<n>` or `error:<message>`, and exits at once. Its
 * exit reparents the child to init (or the nearest subreaper), so the
 * child is no longer a descendant of this process.
 */
export const REPARENT_LAUNCHER = [
  `const { spawn } = require("node:child_process");`,
  `const env = { ...process.env };`,
  `const p = JSON.parse(env[${JSON.stringify(REPARENT_PAYLOAD_ENV)}] ?? "{}");`,
  `delete env[${JSON.stringify(REPARENT_PAYLOAD_ENV)}];`,
  // No process.exit: the launcher ends by itself once its answer is
  // written (a pipe write is not synchronous everywhere).
  `const done = (code, text) => { process.exitCode = code; process.stdout.write(text); };`,
  `const fail = (e) => done(1, "error:" + String((e && e.message) || e));`,
  `let child = null;`,
  `try {`,
  `  child = spawn(p.argv[0], p.argv.slice(1), { cwd: p.cwd, env, detached: true, stdio: ["ignore", "ignore", "inherit"], windowsHide: true });`,
  `} catch (e) { fail(e); }`,
  `if (child !== null && typeof child.pid === "number") { child.unref(); done(0, "pid:" + child.pid); }`,
  `else if (child !== null) child.on("error", fail);`,
].join("\n");

/** How long a start waits for its launcher to report the child: it exits within milliseconds. */
const REPARENT_LAUNCHER_TIMEOUT_MS = 5_000;

/** Open `opts.stderrLog` for the child (truncated first unless appending), or null. */
function openStderrLog(opts: SelfSpawnOptions): number | null {
  if (opts.stderrLog === undefined) return null;
  try {
    mkdirSync(dirname(opts.stderrLog), { recursive: true });
    // Truncated, then opened for appending: a child that keeps the log
    // to its tail (`worker-log.ts`) cuts it while it writes, and its
    // writes go on at the new end.
    if (opts.appendStderrLog !== true) writeFileSync(opts.stderrLog, "");
    return openSync(opts.stderrLog, "a");
  } catch {
    return null;
  }
}

function closeQuietly(fd: number | null): void {
  if (fd === null) return;
  try {
    closeSync(fd);
  } catch {
    // the child holds its own handle
  }
}

/**
 * Start a background child running `argv` (built from {@link o2bCommand}
 * or {@link selfCommand}) that is NOT a descendant of this process, and
 * return its pid. Throws when it cannot be started.
 *
 * A host that ends a hook past its time limit signals the hook's whole
 * process tree, found by parent pid: a session of its own (`setsid`) does
 * not hide a child from that walk. Claude Code does so to a SessionStart
 * hook that runs past its `timeout`, and a dream worker the hook started
 * died 10 s after its start, with its pass half done. So on POSIX the
 * child is started through a launcher that exits at once
 * ({@link REPARENT_LAUNCHER}): the child is reparented before this call
 * returns, and a later signal to this process's tree no longer reaches
 * it. On Windows the child is started directly, detached, as before.
 */
export function spawnSelfDetached(
  argv: ReadonlyArray<string>,
  opts: SelfSpawnOptions = {},
  platform: NodeJS.Platform = process.platform,
): SelfSpawned {
  if (platform === "win32") {
    const proc = spawnSelfDetachedChild(argv, opts);
    return { pid: proc.pid };
  }
  const env = selfSpawnEnv(opts.env ?? process.env);
  const fd = openStderrLog(opts);
  try {
    const result = Bun.spawnSync({
      cmd: [process.execPath, "-e", REPARENT_LAUNCHER],
      // The launcher runs in the root folder, where no project
      // configuration of the runtime is read; the child runs in this
      // process's folder, as a direct child would.
      cwd: "/",
      env: {
        ...env,
        [REPARENT_PAYLOAD_ENV]: JSON.stringify({ argv: [...argv], cwd: process.cwd() }),
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: fd ?? "ignore",
      timeout: REPARENT_LAUNCHER_TIMEOUT_MS,
    });
    const out = result.stdout.toString();
    const pid = /^pid:(\d+)$/.exec(out)?.[1];
    if (result.exitCode === 0 && pid !== undefined) return { pid: Number(pid) };
    const reason = out.startsWith("error:")
      ? out.slice("error:".length)
      : result.exitedDueToTimeout === true
        ? `the launcher did not answer within ${REPARENT_LAUNCHER_TIMEOUT_MS} ms`
        : `the launcher exited with ${result.signalCode ?? `code ${result.exitCode}`}`;
    throw new Error(`could not start ${argv[0] ?? "the child"}: ${reason}`);
  } finally {
    closeQuietly(fd);
  }
}

/**
 * Start a detached background child running `argv` as a direct child of
 * this process, `unref`ed so it never keeps this process alive, and
 * return it. For a start that watches the child's exit itself (the
 * automatic store migration worker); every other background child goes
 * through {@link spawnSelfDetached}, which this process's tree cannot
 * take down. Throws when it cannot be started.
 */
export function spawnSelfDetachedChild(
  argv: ReadonlyArray<string>,
  opts: SelfSpawnOptions = {},
): ReturnType<typeof Bun.spawn> {
  const env = selfSpawnEnv(opts.env ?? process.env);
  const fd = openStderrLog(opts);
  try {
    const proc = Bun.spawn([...argv], detachedSpawnOptions(env, fd ?? "ignore"));
    proc.unref();
    return proc;
  } finally {
    closeQuietly(fd);
  }
}
