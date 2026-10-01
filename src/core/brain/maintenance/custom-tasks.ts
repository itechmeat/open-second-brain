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

import { isAbsolute } from "node:path";

import { discoverConfig, resolveMaintenanceCustomTasks } from "../../config.ts";
import { MAINTENANCE_LEASE_TTL_MS } from "./lane.ts";

export const CUSTOM_TASK_PREFIX = "custom:";
export const CUSTOM_TASK_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
/** Each declared task adds a journal row per pass against the 500-row cap. */
export const CUSTOM_TASK_MAX = 8;
export const CUSTOM_TASK_TIMEOUT_DEFAULT_SECONDS = 600;

export type CustomLaneTask = `custom:${string}`;

/** Whether `value` is a well-formed custom identity (not whether it is declared). */
export function isCustomLaneTask(value: unknown): value is CustomLaneTask {
  return (
    typeof value === "string" &&
    value.startsWith(CUSTOM_TASK_PREFIX) &&
    CUSTOM_TASK_NAME_PATTERN.test(value.slice(CUSTOM_TASK_PREFIX.length))
  );
}

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
