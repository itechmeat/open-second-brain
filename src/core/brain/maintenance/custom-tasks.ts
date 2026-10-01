/**
 * Install-owned custom maintenance lane tasks.
 *
 * An install can put its own upkeep under the lane's window, busy,
 * pressure, lease and streak gates by declaring a shell command in the
 * MACHINE config file, as flat keys:
 *
 *   maintenance_custom_tasks: true                  # master switch, default off
 *   maintenance_custom_<name>: <command>
 *   maintenance_custom_<name>_cwd: /absolute/dir    # optional, default the vault
 *   maintenance_custom_<name>_timeout_seconds: 120  # optional, default 600
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
import { isAbsolute } from "node:path";

import { discoverConfig, resolveMaintenanceCustomTasks } from "../../config.ts";
import { redactRawOutput } from "../../redactor.ts";
import { shellArgv } from "../../reliability/command-bridge.ts";
import { SafeguardAbortError, SafeguardTimeoutError } from "../safeguard.ts";
import { MAINTENANCE_LEASE_TTL_MS, type MaintenanceTask } from "./lane.ts";
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
export const CUSTOM_TASK_TIMEOUT_DEFAULT_SECONDS = 600;

export interface CustomTaskSpec {
  readonly name: string;
  readonly id: CustomLaneTask;
  readonly command: string;
  /** Absent = the vault. */
  readonly cwd?: string;
  readonly timeoutSeconds: number;
}

export interface CustomTaskResolution {
  /** The master switch, as resolved (env over config). */
  readonly enabled: boolean;
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
    if (key === "maintenance_custom_tasks") continue;
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
  const enabled = resolveMaintenanceCustomTasks(configPath);
  if (!enabled) return { enabled, specs: [], errors: [], declared };

  const timeoutCap = MAINTENANCE_LEASE_TTL_MS / 1000;
  const specs: CustomTaskSpec[] = [];
  const errors: string[] = [];
  for (const name of [...declarations.keys()].toSorted()) {
    const decl = declarations.get(name)!;
    const key = `${KEY_PREFIX}${name}`;
    if (decl.command === undefined) {
      // A `_cwd`/`_timeout_seconds` key whose command is missing: either a
      // typo in the command key or a leftover after removing it.
      const dangling = decl.cwd !== undefined ? `${key}${CWD_SUFFIX}` : `${key}${TIMEOUT_SUFFIX}`;
      errors.push(`${dangling}: no ${key} command is declared for it`);
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
      if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed >= timeoutCap) {
        errors.push(
          `${key}${TIMEOUT_SUFFIX}: "${decl.timeout}" is not a whole number of seconds ` +
            `from 1 to ${timeoutCap - 1} (it must stay below the ${timeoutCap} s maintenance lease)`,
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
    specs.push({
      name,
      id: `${CUSTOM_TASK_PREFIX}${name}`,
      command: decl.command,
      ...(decl.cwd !== undefined ? { cwd: decl.cwd } : {}),
      timeoutSeconds,
    });
  }
  return { enabled, specs, errors, declared };
}

/** Cap of the persisted failure message, matching the lane's own error cap. */
const CUSTOM_TASK_ERROR_MAX_BYTES = 4096;
/** How much stderr is held in memory; only the tail is ever reported. */
const STDERR_HOLD_BYTES = 64 * 1024;

/**
 * The lane task that runs one declared command.
 *
 * The command runs through the shared platform shell form
 * ({@link shellArgv}) with stdin closed, stdout discarded (the lane's own
 * stdout may be the JSON a caller parses), `O2B_VAULT` set, and the vault
 * as the working directory unless the declaration names one. Exit 0
 * resolves with no receipt: a custom task never calls a model on the
 * lane's behalf and has no spend to account for. A non-zero exit throws
 * `exit <N>: <stderr tail>`, the tail redacted BEFORE it is capped so a
 * secret cannot straddle the cut, at most 4096 bytes in all.
 *
 * The timeout is enforced here, not by the `OPERATION`-keyed safeguard (a
 * custom identity is not an operation): past `timeoutSeconds` the child's
 * process tree is killed and the task throws {@link SafeguardTimeoutError},
 * so the journal row carries `timed_out: true` exactly as a built-in's does
 * - and, for a custom identity, that row counts toward the failure streak.
 * An aborted `signal` kills the tree the same way and throws
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

function runCustomCommand(
  spec: CustomTaskSpec,
  ctx: { readonly vault: string; readonly signal?: AbortSignal },
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (ctx.signal?.aborted === true) {
      reject(new SafeguardAbortError(spec.id));
      return;
    }
    const [shell, argv] = shellArgv(spec.command);
    let child: ChildProcess;
    try {
      child = spawn(shell, argv, {
        cwd: spec.cwd ?? ctx.vault,
        env: { ...process.env, O2B_VAULT: ctx.vault },
        stdio: ["ignore", "ignore", "pipe"],
        windowsVerbatimArguments: process.platform === "win32",
        // Its own process group on POSIX, so a kill reaches whatever the
        // shell started, not only the shell.
        detached: process.platform !== "win32",
        windowsHide: true,
      });
    } catch (err) {
      reject(new Error(`${spec.id}: could not start: ${(err as Error).message ?? String(err)}`));
      return;
    }

    let stderr = Buffer.alloc(0);
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = Buffer.concat([stderr, chunk]);
      if (stderr.length > STDERR_HOLD_BYTES) stderr = stderr.subarray(-STDERR_HOLD_BYTES);
    });

    let settled = false;
    const timeoutMs = spec.timeoutSeconds * 1000;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ctx.signal?.removeEventListener("abort", onAbort);
      if (error === undefined) resolve();
      else reject(error);
    };
    const timer = setTimeout(() => {
      killTree(child);
      finish(new SafeguardTimeoutError(spec.id, timeoutMs));
    }, timeoutMs);
    const onAbort = (): void => {
      killTree(child);
      finish(new SafeguardAbortError(spec.id));
    };
    ctx.signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (err) => {
      killTree(child);
      finish(new Error(`${spec.id}: could not run: ${err.message}`));
    });
    child.on("close", (code, signal) => {
      if (code === 0) {
        finish();
        return;
      }
      const head = code !== null ? `exit ${code}` : `killed by ${signal ?? "an unknown signal"}`;
      finish(new Error(failureMessage(head, stderr.toString("utf8"))));
    });
  });
}

/** `<head>: <redacted stderr tail>`, at most {@link CUSTOM_TASK_ERROR_MAX_BYTES}. */
function failureMessage(head: string, stderr: string): string {
  const redacted = redactRawOutput(stderr, {
    redactTokens: true,
    redactUrlCredentials: true,
  }).trim();
  if (redacted === "") return `${head}: (no stderr)`;
  const prefix = `${head}: `;
  const budget = CUSTOM_TASK_ERROR_MAX_BYTES - Buffer.byteLength(prefix, "utf8");
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

/** Kill the child and everything it started. Never throws. */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
    } else {
      process.kill(-child.pid, "SIGKILL");
    }
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }
}
