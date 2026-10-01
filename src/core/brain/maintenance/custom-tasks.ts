/**
 * Install-owned custom maintenance lane tasks.
 *
 * An install can put its own upkeep under the lane's window, busy,
 * pressure, lease and streak gates by declaring a shell command in the
 * MACHINE config file, as flat keys:
 *
 *   maintenance_custom_tasks: true                  # master switch, default off
 *   maintenance_custom_<name>: <command>
 *   maintenance_custom_<name>_cwd: /absolute/dir    # optional, default the home directory
 *   maintenance_custom_<name>_timeout_seconds: 300  # optional, default 120
 *
 * Never the vault: the vault syncs between devices and is writable through
 * the MCP write tools, so a command stored there would let a synced edit or
 * an agent plant code the lane then runs. No MCP parameter can add, edit or
 * read a command either; a caller can only name `custom:<name>` to retry.
 *
 * The identity is `custom:<name>` with `<name>` matching
 * {@link CUSTOM_TASK_NAME_PATTERN}. A colon never occurs in an `OPERATION`
 * value, so a custom identity cannot collide with a built-in task, and the
 * name bans underscores so the `_cwd` and `_timeout_seconds` suffixes are
 * unambiguous.
 *
 * Every bad declaration is an error string naming its key, never a silent
 * skip; the valid declarations still resolve. A custom task never calls a
 * model and records no spend receipt: the lane cannot police spend or side
 * effects inside an operator's own command, and it does not pretend to.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute } from "node:path";

import {
  discoverConfig,
  MAINTENANCE_CUSTOM_TASKS_CONFIG_KEY,
  MAINTENANCE_CUSTOM_TASKS_ENV,
  resolveMaintenanceCustomTasksSwitch,
  type MaintenanceSwitchSource,
} from "../../config.ts";
import { isSecretKeyName, redactRawOutput } from "../../redactor.ts";
import { shellArgv } from "../../reliability/command-bridge.ts";
import { SafeguardAbortError, SafeguardTimeoutError } from "../safeguard.ts";
import { LANE_ERROR_MAX_BYTES, MAINTENANCE_LEASE_TTL_MS, type MaintenanceTask } from "./lane.ts";
import {
  CUSTOM_TASK_NAME_PATTERN,
  CUSTOM_TASK_PREFIX,
  type CustomLaneTask,
} from "./custom-task-id.ts";

export {
  CUSTOM_TASK_NAME_PATTERN,
  CUSTOM_TASK_PREFIX,
  type CustomLaneTask,
  isCustomLaneTask,
} from "./custom-task-id.ts";

/** Each declared task adds a journal row per pass against the 500-row cap. */
export const CUSTOM_TASK_MAX = 8;

/**
 * Time the maintenance lease keeps for the four built-in tasks. The lease
 * is acquired once per pass and not renewed, so whatever the custom tasks
 * may spend comes out of the same 1800 s.
 */
export const BUILT_IN_TASKS_LEASE_MARGIN_SECONDS = 600;

/**
 * The most the declared custom timeouts may add up to: the lease length
 * minus {@link BUILT_IN_TASKS_LEASE_MARGIN_SECONDS}, 1200 s. A per-task
 * bound alone does not keep the lease: eight tasks just under it would
 * hold the lane for hours after the lease expired, and a second pass
 * would start beside the first.
 */
export const CUSTOM_TASK_TOTAL_TIMEOUT_BUDGET_SECONDS =
  MAINTENANCE_LEASE_TTL_MS / 1000 - BUILT_IN_TASKS_LEASE_MARGIN_SECONDS;

/** Sized so the full {@link CUSTOM_TASK_MAX} tasks fit the budget at their default. */
export const CUSTOM_TASK_TIMEOUT_DEFAULT_SECONDS = 120;

/** What `status` says when custom tasks are declared but the config switch is off. */
export const CUSTOM_TASKS_OFF_NOTICE = `custom tasks declared but ${MAINTENANCE_CUSTOM_TASKS_CONFIG_KEY} is off`;

/** What `status` says when the env override turned declared custom tasks off. */
export const CUSTOM_TASKS_ENV_OFF_NOTICE = `custom tasks declared but ${MAINTENANCE_CUSTOM_TASKS_ENV} turns them off`;

export interface CustomTaskSpec {
  readonly name: string;
  readonly id: CustomLaneTask;
  readonly command: string;
  /** Absent = the running user's home directory. */
  readonly cwd?: string;
  readonly timeoutSeconds: number;
}

export interface CustomTaskResolution {
  /** The master switch, as resolved (env over config). */
  readonly enabled: boolean;
  /** Which source decided {@link enabled}: the env override, the config key, or neither. */
  readonly switchSource: MaintenanceSwitchSource;
  /** Valid declarations, sorted by name; empty while the switch is off. */
  readonly specs: ReadonlyArray<CustomTaskSpec>;
  /** One named reason per refused declaration; empty while the switch is off. */
  readonly errors: ReadonlyArray<string>;
  /** Distinct task names declared in the config, valid or not, switch on or off. */
  readonly declared: number;
}

const KEY_PREFIX = "maintenance_custom_";
const CWD_SUFFIX = "_cwd";
const TIMEOUT_SUFFIX = "_timeout_seconds";

interface Declaration {
  command?: string;
  cwd?: string;
  timeout?: string;
}

/**
 * The custom tasks the config at `configPath` declares, with every refused
 * declaration named. Reads the flat config through the shared loader, so an
 * unreadable config file raises its named `ConfigReadError` here rather
 * than resolving to "nothing declared".
 */
export function resolveCustomTasks(configPath?: string): CustomTaskResolution {
  const data = discoverConfig(configPath).data;
  const declarations = new Map<string, Declaration>();
  for (const [key, value] of Object.entries(data)) {
    if (!key.startsWith(KEY_PREFIX)) continue;
    // The master switch shares the prefix; it is not a task named "tasks".
    if (key === MAINTENANCE_CUSTOM_TASKS_CONFIG_KEY) continue;
    const rest = key.slice(KEY_PREFIX.length);
    let name = rest;
    let field: keyof Declaration = "command";
    if (rest.endsWith(TIMEOUT_SUFFIX)) {
      name = rest.slice(0, -TIMEOUT_SUFFIX.length);
      field = "timeout";
    } else if (rest.endsWith(CWD_SUFFIX)) {
      name = rest.slice(0, -CWD_SUFFIX.length);
      field = "cwd";
    }
    const entry = declarations.get(name) ?? {};
    entry[field] = value.trim();
    declarations.set(name, entry);
  }
  const declared = declarations.size;
  const { enabled, source: switchSource } = resolveMaintenanceCustomTasksSwitch(configPath, data);
  if (!enabled) return { enabled, switchSource, specs: [], errors: [], declared };

  const budget = CUSTOM_TASK_TOTAL_TIMEOUT_BUDGET_SECONDS;
  let committed = 0;
  const specs: CustomTaskSpec[] = [];
  const errors: string[] = [];
  for (const name of [...declarations.keys()].toSorted()) {
    const decl = declarations.get(name)!;
    const key = `${KEY_PREFIX}${name}`;
    if (decl.command === undefined) {
      // A `_cwd`/`_timeout_seconds` key whose command is missing: either a
      // typo in the command key or a leftover after removing it. Each
      // dangling key is named, not only the first.
      if (decl.cwd !== undefined)
        errors.push(`${key}${CWD_SUFFIX}: no ${key} command is declared for it`);
      if (decl.timeout !== undefined) {
        errors.push(`${key}${TIMEOUT_SUFFIX}: no ${key} command is declared for it`);
      }
      continue;
    }
    if (!CUSTOM_TASK_NAME_PATTERN.test(name)) {
      errors.push(
        `${key}: task name "${name}" does not match ${CUSTOM_TASK_NAME_PATTERN.source} ` +
          `(lowercase letters, digits and hyphens, starting with a letter, at most 32)`,
      );
      continue;
    }
    if (decl.command === "") {
      errors.push(`${key}: the command is empty`);
      continue;
    }
    let timeoutSeconds = CUSTOM_TASK_TIMEOUT_DEFAULT_SECONDS;
    if (decl.timeout !== undefined) {
      const parsed = /^\d+$/.test(decl.timeout) ? Number(decl.timeout) : Number.NaN;
      if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > budget) {
        errors.push(
          `${key}${TIMEOUT_SUFFIX}: "${decl.timeout}" is not a whole number of seconds ` +
            `from 1 to ${budget} (the custom timeouts together stay within ${budget} s ` +
            `of the ${MAINTENANCE_LEASE_TTL_MS / 1000} s maintenance lease)`,
        );
        continue;
      }
      timeoutSeconds = parsed;
    }
    if (decl.cwd !== undefined && (decl.cwd === "" || !isAbsolute(decl.cwd))) {
      errors.push(`${key}${CWD_SUFFIX}: "${decl.cwd}" is not an absolute path`);
      continue;
    }
    if (specs.length >= CUSTOM_TASK_MAX) {
      errors.push(
        `${key}: more than ${CUSTOM_TASK_MAX} custom tasks are declared; this one is not run`,
      );
      continue;
    }
    if (committed + timeoutSeconds > budget) {
      errors.push(
        `${key}: its ${timeoutSeconds} s timeout takes the custom timeouts to ` +
          `${committed + timeoutSeconds} s, over the ${budget} s budget of the ` +
          `${MAINTENANCE_LEASE_TTL_MS / 1000} s maintenance lease; this one is not run`,
      );
      continue;
    }
    committed += timeoutSeconds;
    specs.push({
      name,
      id: `${CUSTOM_TASK_PREFIX}${name}`,
      command: decl.command,
      ...(decl.cwd !== undefined ? { cwd: decl.cwd } : {}),
      timeoutSeconds,
    });
  }
  return { enabled, switchSource, specs, errors, declared };
}

/**
 * The notice `status` gives when custom tasks are declared but not run,
 * naming the switch that turned them off; `null` when there is nothing to
 * say. One definition for the CLI verb and the MCP tool.
 */
export function customTasksOffNotice(resolution: CustomTaskResolution): string | null {
  if (resolution.enabled || resolution.declared === 0) return null;
  return resolution.switchSource === "env" ? CUSTOM_TASKS_ENV_OFF_NOTICE : CUSTOM_TASKS_OFF_NOTICE;
}

/** How much stderr is held in memory; only the tail is ever reported. */
const STDERR_HOLD_BYTES = 64 * 1024;
/**
 * How long the stderr pipe may stay open after the shell exited. A process
 * the command left in the background can hold the pipe for as long as it
 * lives; the task's outcome is the shell's exit status, so the runner
 * reads what arrived in this window and stops waiting.
 */
const STDERR_DRAIN_MS = 200;
/** Between SIGTERM and SIGKILL to a timed-out or aborted process group. */
const KILL_GRACE_MS = 1000;

/**
 * Variables the child always keeps, even if a secret-name check matched
 * them. Compared upper-cased, because Windows env names are
 * case-insensitive (`Path`).
 */
const CHILD_ENV_KEEP: ReadonlySet<string> = new Set([
  "PATH",
  "HOME",
  "LANG",
  "TZ",
  "TMPDIR",
  "O2B_VAULT",
]);
const CHILD_ENV_KEEP_PREFIX = "LC_";

/**
 * The child's environment: this process's variables minus every one whose
 * NAME declares a credential ({@link isSecretKeyName}: `*_API_KEY`,
 * `*_TOKEN`, `*_SECRET`, `*PASSWORD*`, ...), plus `O2B_VAULT`. The
 * provider keys the lane itself holds are not the operator command's to
 * read; a command that needs one reads it from its own configuration.
 */
export function customTaskEnv(
  vault: string,
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const upper = name.toUpperCase();
    const kept = CHILD_ENV_KEEP.has(upper) || upper.startsWith(CHILD_ENV_KEEP_PREFIX);
    if (!kept && isSecretKeyName(name)) continue;
    env[name] = value;
  }
  env["O2B_VAULT"] = vault;
  return env;
}

/**
 * POSIX process groups of custom children that may still have members.
 * The lane does not wait for what a command left in the background, but
 * it does not leave it behind either: every group still listed when this
 * process exits is killed then.
 */
const liveGroups = new Set<number>();
let exitHookInstalled = false;

function trackGroup(pgid: number): void {
  liveGroups.add(pgid);
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", () => {
    for (const group of liveGroups) signalGroup(group, "SIGKILL");
    liveGroups.clear();
  });
}

/** Signal a whole POSIX process group. ESRCH (the group is gone) is not an error. */
function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch {
    // ESRCH: no member of the group is left.
  }
}

/** Whether any member of a POSIX process group is still running. */
function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * The lane task that runs one declared command.
 *
 * The command runs through the shared platform shell form
 * ({@link shellArgv}) with stdin closed, stdout discarded (the lane's own
 * stdout may be the JSON a caller parses), the environment of
 * {@link customTaskEnv}, and the running user's home directory as the
 * working directory unless the declaration names one. Never the vault by
 * default: it syncs and is writable through the MCP write tools, and a
 * shell resolves a bare command name in the working directory first on
 * Windows. Exit 0 resolves with no receipt: a custom task never calls a
 * model on the lane's behalf and has no spend to account for. A non-zero
 * exit throws `exit <N>: <stderr tail>`, the tail redacted BEFORE it is
 * capped so a secret cannot straddle the cut, at most
 * {@link LANE_ERROR_MAX_BYTES} in all.
 *
 * The outcome is the shell's exit status: the task does not wait for
 * processes the command left in the background. Those still belong to the
 * task. On POSIX the command runs in its own process group, and that group
 * is killed when the task's timeout elapses or when this process exits,
 * whichever comes first, also after the shell itself has exited.
 *
 * The timeout is enforced here, not by the `OPERATION`-keyed safeguard (a
 * custom identity is not an operation): past `timeoutSeconds` the process
 * group gets SIGTERM, then SIGKILL after a short grace (`taskkill /T /F`
 * on Windows), and the task throws {@link SafeguardTimeoutError}, so the
 * journal row carries `timed_out: true` exactly as a built-in's does -
 * and, for a custom identity, that row counts toward the failure streak.
 * An aborted `signal` kills the group the same way and throws
 * {@link SafeguardAbortError}.
 */
export function createCustomLaneTask(
  spec: CustomTaskSpec,
  ctx: { readonly vault: string; readonly signal?: AbortSignal },
): MaintenanceTask {
  return {
    name: spec.id,
    run: () => runCustomCommand(spec, ctx),
  };
}

/** The directory a task runs in: its declared `_cwd`, else the running user's home. */
function customTaskCwd(spec: CustomTaskSpec): string {
  if (spec.cwd !== undefined) return spec.cwd;
  const home = homedir();
  if (home === "") {
    throw new Error(
      `custom task ${spec.name}: the home directory, its default working directory, ` +
        `cannot be resolved; set ${KEY_PREFIX}${spec.name}${CWD_SUFFIX}`,
    );
  }
  return home;
}

function runCustomCommand(
  spec: CustomTaskSpec,
  ctx: { readonly vault: string; readonly signal?: AbortSignal },
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (ctx.signal?.aborted === true) {
      reject(new SafeguardAbortError(spec.id));
      return;
    }
    let cwd: string;
    try {
      cwd = customTaskCwd(spec);
    } catch (err) {
      reject(err as Error);
      return;
    }
    // Named before the spawn: a missing directory otherwise surfaces as
    // `ENOENT ... posix_spawn 'sh'`, which names the shell, not the path.
    const stat = statSync(cwd, { throwIfNoEntry: false });
    if (stat === undefined || !stat.isDirectory()) {
      reject(
        new Error(
          `custom task ${spec.name}: cwd ${stat === undefined ? "does not exist" : "is not a directory"}: ${cwd}`,
        ),
      );
      return;
    }
    const [shell, argv] = shellArgv(spec.command);
    const posix = process.platform !== "win32";
    let child: ChildProcess;
    try {
      child = spawn(shell, argv, {
        cwd,
        env: customTaskEnv(ctx.vault),
        stdio: ["ignore", "ignore", "pipe"],
        windowsVerbatimArguments: !posix,
        // Its own process group on POSIX, so a kill reaches whatever the
        // shell started, not only the shell.
        detached: posix,
        windowsHide: true,
      });
    } catch (err) {
      reject(new Error(`${spec.id}: could not start: ${(err as Error).message ?? String(err)}`));
      return;
    }
    const pgid = posix ? child.pid : undefined;
    if (pgid !== undefined) trackGroup(pgid);

    let stderr = Buffer.alloc(0);
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = Buffer.concat([stderr, chunk]);
      if (stderr.length > STDERR_HOLD_BYTES) stderr = stderr.subarray(-STDERR_HOLD_BYTES);
    });

    let settled = false;
    let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    const timeoutMs = spec.timeoutSeconds * 1000;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(drainTimer);
      ctx.signal?.removeEventListener("abort", onAbort);
      // A background holder of the pipe must not keep this process alive.
      child.stderr?.destroy();
      if (pgid !== undefined && groupAlive(pgid)) {
        // The deadline outlives the outcome while the group still has
        // members: it then only kills what the command left behind.
        deadline.unref();
      } else {
        clearTimeout(deadline);
        if (pgid !== undefined) liveGroups.delete(pgid);
      }
      if (error === undefined) resolve();
      else reject(error);
    };
    const killGroup = (): void => {
      if (pgid === undefined) {
        killWindowsTree(child);
        return;
      }
      signalGroup(pgid, "SIGTERM");
      const hard = setTimeout(() => {
        signalGroup(pgid, "SIGKILL");
        liveGroups.delete(pgid);
      }, KILL_GRACE_MS);
      hard.unref();
    };
    const deadline = setTimeout(() => {
      killGroup();
      // The shell already exited and only the stderr drain is pending: its
      // status is the outcome, and the deadline only kills the leftovers.
      if (exit !== undefined) {
        settleExit();
        return;
      }
      finish(new SafeguardTimeoutError(spec.id, timeoutMs));
    }, timeoutMs);
    const onAbort = (): void => {
      clearTimeout(deadline);
      killGroup();
      finish(new SafeguardAbortError(spec.id));
    };
    ctx.signal?.addEventListener("abort", onAbort, { once: true });

    const settleExit = (): void => {
      if (exit === undefined) return;
      if (exit.code === 0) {
        finish();
        return;
      }
      const head =
        exit.code !== null
          ? `exit ${exit.code}`
          : `killed by ${exit.signal ?? "an unknown signal"}`;
      finish(new Error(failureMessage(head, stderr.toString("utf8"))));
    };
    child.on("error", (err) => {
      killGroup();
      finish(new Error(`${spec.id}: could not run: ${err.message}`));
    });
    child.on("exit", (code, signal) => {
      exit = { code, signal };
      drainTimer = setTimeout(settleExit, STDERR_DRAIN_MS);
    });
    child.on("close", (code, signal) => {
      exit ??= { code, signal };
      settleExit();
    });
  });
}

/** `<head>: <redacted stderr tail>`, at most {@link LANE_ERROR_MAX_BYTES}. */
function failureMessage(head: string, stderr: string): string {
  const redacted = redactRawOutput(stderr, {
    redactTokens: true,
    redactUrlCredentials: true,
  }).trim();
  if (redacted === "") return `${head}: (no stderr)`;
  const prefix = `${head}: `;
  const budget = LANE_ERROR_MAX_BYTES - Buffer.byteLength(prefix, "utf8");
  if (Buffer.byteLength(redacted, "utf8") <= budget) return `${prefix}${redacted}`;
  const marker = "[stderr truncated, tail follows]\n";
  return `${prefix}${marker}${utf8Tail(redacted, budget - Buffer.byteLength(marker, "utf8"))}`;
}

/** The last `maxBytes` of `text`, cut on a character boundary. */
function utf8Tail(text: string, maxBytes: number): string {
  const chars = [...text];
  let bytes = 0;
  let start = chars.length;
  while (start > 0) {
    const size = Buffer.byteLength(chars[start - 1]!, "utf8");
    if (bytes + size > maxBytes) break;
    bytes += size;
    start -= 1;
  }
  return chars.slice(start).join("");
}

/**
 * Windows: kill the shell and the tree it started. `taskkill /T` walks the
 * tree from a live parent, so once the shell has exited there is no tree
 * left to walk. Never throws.
 */
function killWindowsTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  try {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }
}
