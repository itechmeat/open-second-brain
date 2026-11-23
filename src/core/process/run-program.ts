/**
 * Start a program, await it within a deadline, and end it (change
 * `dream-launched-agent`, design D4).
 *
 * The program is started by its path with an argument array and an
 * environment, never through a shell, so no argument is split or quoted
 * on any system. Standard input is closed; standard output and error go
 * to a file when one is named, and are dropped otherwise.
 *
 * At the deadline the program is ended with everything it started: on
 * POSIX it leads a process group of its own, which gets the termination
 * signal and, five seconds later, the kill signal; on Windows the process
 * tree is ended with `taskkill /T /F`.
 */

import { spawn as nodeSpawn, spawnSync as nodeSpawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

/** Wait between the termination signal and the kill signal. */
export const RUN_PROGRAM_KILL_GRACE_MS = 5_000;

export type RunProgramResult =
  | {
      readonly status: "exited";
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
    }
  | { readonly status: "timed-out" }
  | { readonly status: "not-started"; readonly error: string };

export interface RunProgramOptions {
  /** The program's absolute path. */
  readonly program: string;
  readonly args: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Wall-clock deadline (ms since the epoch). */
  readonly deadline: number;
  /** File the program's output and error output are appended to. */
  readonly logPath?: string;
  readonly cwd?: string;
  /** Wait between the termination and the kill signal (default {@link RUN_PROGRAM_KILL_GRACE_MS}). */
  readonly killGraceMs?: number;
  /** Platform used to construct the child command (defaults to the host). */
  readonly platform?: NodeJS.Platform;
}

/** Process functions injectable by tests; production uses Node's defaults. */
export interface RunProgramSeams {
  readonly spawn?: typeof nodeSpawn;
  readonly spawnSync?: typeof nodeSpawnSync;
}

export type ProgramInvocation =
  | {
      readonly command: string;
      readonly args: ReadonlyArray<string>;
      readonly windowsVerbatimArguments?: true;
    }
  | { readonly error: string };

const CMD_SAFE = /^[A-Za-z0-9_ .:\\/-]*$/;

/** Build the launch command without consulting the host platform. */
export function programInvocation(
  program: string,
  args: ReadonlyArray<string>,
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
): ProgramInvocation {
  if (platform !== "win32" || !/\.(?:bat|cmd)$/i.test(program)) {
    return { command: program, args };
  }
  if (!CMD_SAFE.test(program) || args.some((arg) => !CMD_SAFE.test(arg))) {
    return {
      error: "batch launcher path or argument contains characters cmd.exe cannot pass safely",
    };
  }
  const command = `"${program}"${args.map((arg) => ` "${arg}"`).join("")}`;
  return {
    command: env["COMSPEC"] ?? "cmd.exe",
    args: ["/d", "/s", "/c", `"${command}"`],
    windowsVerbatimArguments: true,
  };
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * The absolute path of `name` on `env`'s `PATH` (on Windows through
 * `PATHEXT`), or `name` itself when it is already absolute and exists;
 * `null` when it cannot be found.
 */
export function findProgram(
  name: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (name === "") return null;
  if (isAbsolute(name)) return isFile(name) ? name : null;
  if (name.includes("/") || (platform === "win32" && name.includes("\\"))) return null;
  const path = env["PATH"] ?? env["Path"] ?? "";
  const exts =
    platform === "win32"
      ? ["", ...(env["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD").split(";").filter((e) => e !== "")]
      : [""];
  for (const dir of path.split(platform === "win32" ? ";" : delimiter)) {
    if (dir === "") continue;
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

export function treeKillInvocation(
  pid: number,
  platform: NodeJS.Platform,
): { readonly command: string; readonly args: ReadonlyArray<string> } | null {
  if (platform === "win32") {
    return { command: "taskkill", args: ["/T", "/F", "/PID", String(pid)] };
  }
  return null;
}

function endTree(
  pid: number,
  signal: NodeJS.Signals,
  platform: NodeJS.Platform,
  spawnSync: typeof nodeSpawnSync,
): void {
  const invocation = treeKillInvocation(pid, platform);
  if (invocation !== null) {
    try {
      spawnSync(invocation.command, [...invocation.args], { stdio: "ignore" });
    } catch {
      // Best effort: the child may have left no tree to clean up.
    }
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    // The group is gone already.
  }
}

/** Run `options.program` until it exits or the deadline passes. */
export function runProgram(
  options: RunProgramOptions,
  seams: RunProgramSeams = {},
): Promise<RunProgramResult> {
  if (!isAbsolute(options.program) || !existsSync(options.program)) {
    return Promise.resolve({
      status: "not-started",
      error: `program not found: ${options.program}`,
    });
  }
  const platform = options.platform ?? process.platform;
  const invocation = programInvocation(options.program, options.args, options.env, platform);
  if ("error" in invocation) {
    return Promise.resolve({ status: "not-started", error: invocation.error });
  }
  let fd: number | null = null;
  if (options.logPath !== undefined) fd = openSync(options.logPath, "a", 0o600);
  const out = fd ?? "ignore";
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    const finish = (result: RunProgramResult): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      if (fd !== null) closeSync(fd);
      resolve(result);
    };
    let child: ReturnType<typeof nodeSpawn>;
    try {
      child = (seams.spawn ?? nodeSpawn)(invocation.command, [...invocation.args], {
        env: Object.fromEntries(
          Object.entries(options.env).filter((e): e is [string, string] => e[1] !== undefined),
        ),
        stdio: ["ignore", out, out],
        shell: false,
        windowsHide: true,
        detached: platform !== "win32",
        ...(invocation.windowsVerbatimArguments === true ? { windowsVerbatimArguments: true } : {}),
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      });
    } catch (err) {
      finish({ status: "not-started", error: err instanceof Error ? err.message : String(err) });
      return;
    }
    let timedOut = false;
    child.on("error", (err) => {
      if (child.pid !== undefined) {
        endTree(child.pid, "SIGTERM", platform, seams.spawnSync ?? nodeSpawnSync);
      }
      if (killTimer !== null) clearTimeout(killTimer);
      finish({ status: "not-started", error: err.message });
    });
    child.on("exit", (code, signal) => {
      // The group may hold children that outlive the leader (a server it started).
      if (child.pid !== undefined) {
        endTree(
          child.pid,
          timedOut ? "SIGKILL" : "SIGTERM",
          platform,
          seams.spawnSync ?? nodeSpawnSync,
        );
      }
      if (killTimer !== null) clearTimeout(killTimer);
      finish(timedOut ? { status: "timed-out" } : { status: "exited", code, signal });
    });
    const wait = Math.max(0, options.deadline - Date.now());
    timer = setTimeout(() => {
      timedOut = true;
      const pid = child.pid;
      if (pid === undefined) return;
      endTree(pid, "SIGTERM", platform, seams.spawnSync ?? nodeSpawnSync);
      killTimer = setTimeout(
        () => endTree(pid, "SIGKILL", platform, seams.spawnSync ?? nodeSpawnSync),
        options.killGraceMs ?? RUN_PROGRAM_KILL_GRACE_MS,
      );
    }, wait);
  });
}
