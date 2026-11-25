/**
 * The machine settings of the dream agent (change `dream-launched-agent`,
 * design D1): flat keys of the machine config with environment twins,
 * never shared settings (a key outside the closed list of store keys
 * never syncs).
 *
 *  - `dream_agent_command`: a preset name, or a JSON array of strings, the
 *    program and its arguments (nothing is split or quoted);
 *  - `dream_agent_fallbacks`: a JSON array whose entries are preset names
 *    or such arrays, tried in order;
 *  - `dream_agent_budget_ms` (default 300 000): the agent's time in one
 *    pass, and `dream_agent_items` (default 100): the items one session may
 *    take (a session that meets it is followed by another while work and
 *    time last);
 *  - `dream_agent_batch` (default {@link DREAM_AGENT_BATCH}): how many
 *    items one take hands the session and one answer call may carry; `1`
 *    is the one-item protocol (one take, one answer per item);
 *  - `dream_agent_private` (default on): whether the session is shown
 *    items of the private partition.
 *
 * Resolution never throws: an invalid value is an error that names the
 * key, never the value.
 */

import { createHash } from "node:crypto";

import { dreamAgentPreset } from "./agent-presets.ts";

export const DREAM_AGENT_COMMAND_KEY = "dream_agent_command";
export const DREAM_AGENT_FALLBACKS_KEY = "dream_agent_fallbacks";
export const DREAM_AGENT_BUDGET_KEY = "dream_agent_budget_ms";
export const DREAM_AGENT_ITEMS_KEY = "dream_agent_items";
export const DREAM_AGENT_BATCH_KEY = "dream_agent_batch";
export const DREAM_AGENT_PRIVATE_SETTING = "dream_agent_private";

export const DREAM_AGENT_BUDGET_MS = 300_000;
/**
 * Items one session may take: a session that meets it is followed by
 * another while work and the time budget last, so it bounds one session's
 * context, not the pass.
 */
export const DREAM_AGENT_ITEMS = 100;
/**
 * Items per take and per answer call. A batch shows the session several
 * items in one tool result; `1` keeps the one-item protocol, whose
 * answers the quality benchmark measured.
 */
export const DREAM_AGENT_BATCH = 10;

/** The environment twin of a machine key (`dream_agent_command` -> `OPEN_SECOND_BRAIN_DREAM_AGENT_COMMAND`). */
export function dreamAgentEnvName(key: string): string {
  return `OPEN_SECOND_BRAIN_${key.toUpperCase()}`;
}

/** One command the worker may start. */
export interface DreamAgentCommand {
  /** The preset name, or `custom`: the agent name the run's answers carry. */
  readonly label: string;
  readonly preset: string | null;
  readonly program: string;
  readonly args: ReadonlyArray<string>;
}

export interface DreamAgentConfig {
  readonly command: DreamAgentCommand | null;
  readonly fallbacks: ReadonlyArray<DreamAgentCommand>;
  readonly budgetMs: number;
  readonly items: number;
  readonly batch: number;
  readonly privateAllowed: boolean;
  readonly errors: ReadonlyArray<string>;
}

type Source = Readonly<Record<string, string | undefined>>;

function setting(env: Source, config: Source, key: string): string | null {
  const fromEnv = env[dreamAgentEnvName(key)];
  if (fromEnv !== undefined && fromEnv.trim() !== "") return fromEnv.trim();
  const fromConfig = config[key];
  if (fromConfig !== undefined && fromConfig.trim() !== "") return fromConfig.trim();
  return null;
}

/** A command from one parsed entry (a preset name or an array), or `null` with an error. */
function commandOf(entry: unknown, key: string, errors: string[]): DreamAgentCommand | null {
  if (typeof entry === "string") {
    const preset = dreamAgentPreset(entry);
    if (preset === undefined) {
      errors.push(`${key}: not a known preset; give the program and its arguments as a JSON array`);
      return null;
    }
    return { label: entry, preset: entry, program: preset.program, args: [...preset.args] };
  }
  if (
    Array.isArray(entry) &&
    entry.length > 0 &&
    entry.every((v) => typeof v === "string") &&
    (entry[0] as string).trim() !== ""
  ) {
    const [program, ...args] = entry as string[];
    return { label: "custom", preset: null, program: program!, args };
  }
  errors.push(`${key} must be a preset name or a JSON array of strings (the program first)`);
  return null;
}

/** Parse one value of `dream_agent_command`. */
export function parseDreamAgentCommand(
  raw: string,
  key: string = DREAM_AGENT_COMMAND_KEY,
  errors: string[] = [],
): DreamAgentCommand | null {
  if (raw.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      errors.push(`${key} is not valid JSON`);
      return null;
    }
    return commandOf(parsed, key, errors);
  }
  return commandOf(raw, key, errors);
}

function positiveInt(raw: string | null, fallback: number, key: string, errors: string[]): number {
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    errors.push(`${key} must be a positive integer`);
    return fallback;
  }
  return n;
}

/** Resolve the dream agent's settings from the machine config and the environment. */
export function resolveDreamAgentConfig(input: {
  readonly config: Source;
  readonly env: Source;
}): DreamAgentConfig {
  const errors: string[] = [];
  const rawCommand = setting(input.env, input.config, DREAM_AGENT_COMMAND_KEY);
  const command =
    rawCommand === null
      ? null
      : parseDreamAgentCommand(rawCommand, DREAM_AGENT_COMMAND_KEY, errors);
  const fallbacks: DreamAgentCommand[] = [];
  const rawFallbacks = setting(input.env, input.config, DREAM_AGENT_FALLBACKS_KEY);
  if (rawFallbacks !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawFallbacks);
    } catch {
      parsed = undefined;
    }
    if (!Array.isArray(parsed)) {
      errors.push(`${DREAM_AGENT_FALLBACKS_KEY} must be a JSON array of preset names or arrays`);
    } else {
      for (const entry of parsed) {
        const fallback = commandOf(entry, DREAM_AGENT_FALLBACKS_KEY, errors);
        if (fallback !== null) fallbacks.push(fallback);
      }
    }
  }
  const rawPrivate = setting(input.env, input.config, DREAM_AGENT_PRIVATE_SETTING);
  let privateAllowed = true;
  if (rawPrivate !== null) {
    if (/^(true|on|yes|1)$/i.test(rawPrivate)) privateAllowed = true;
    else if (/^(false|off|no|0)$/i.test(rawPrivate)) privateAllowed = false;
    else errors.push(`${DREAM_AGENT_PRIVATE_SETTING} must be on or off`);
  }
  return {
    command,
    fallbacks,
    budgetMs: positiveInt(
      setting(input.env, input.config, DREAM_AGENT_BUDGET_KEY),
      DREAM_AGENT_BUDGET_MS,
      DREAM_AGENT_BUDGET_KEY,
      errors,
    ),
    items: positiveInt(
      setting(input.env, input.config, DREAM_AGENT_ITEMS_KEY),
      DREAM_AGENT_ITEMS,
      DREAM_AGENT_ITEMS_KEY,
      errors,
    ),
    batch: positiveInt(
      setting(input.env, input.config, DREAM_AGENT_BATCH_KEY),
      DREAM_AGENT_BATCH,
      DREAM_AGENT_BATCH_KEY,
      errors,
    ),
    privateAllowed,
    errors,
  };
}

/** The hash a verification is recorded under: the program and its arguments. */
export function dreamAgentCommandHash(command: DreamAgentCommand): string {
  return createHash("sha256")
    .update(JSON.stringify([command.program, ...command.args]))
    .digest("hex");
}
