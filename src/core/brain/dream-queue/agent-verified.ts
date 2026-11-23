/**
 * What this machine knows about its dream agent commands (change
 * `dream-launched-agent`, design D5): the commands `o2b dream agent check`
 * verified, by hash, and the last run of the worker. Device-local, under
 * `<state root>/dream/`, never synced. A command whose hash is not
 * recorded as verified is not used for real work.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { processDirsEnv, stateRootDir } from "../../platform-dirs.ts";
import { dreamAgentCommandHash, type DreamAgentCommand } from "./agent-config.ts";

/** `<state root>/dream`: the machine's dream agent state. */
export function dreamAgentStateDir(): string {
  return join(stateRootDir(processDirsEnv()), "dream");
}

export interface DreamAgentVerification {
  readonly command_hash: string;
  readonly label: string;
  readonly agent: string;
  readonly model: string;
  readonly verified_at: string;
  readonly program_version: string | null;
}

export interface DreamAgentLastRun {
  readonly at: string;
  /** `ran`, or why no session started (`no-time`, `no-command`, `unverified`). */
  readonly status: string;
  readonly agent: string | null;
  readonly model: string | null;
  readonly answered: number;
  /** How the session ended (`exited 0`, `timed-out`, `not-started: ...`). */
  readonly ended: string | null;
  readonly failed: boolean;
}

function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
}

const VERIFIED = "agent-verified.json";
const LAST_RUN = "agent-last-run.json";

/** Every verification recorded on this machine, by command hash. */
export function readDreamAgentVerifications(
  dir: string = dreamAgentStateDir(),
): Record<string, DreamAgentVerification> {
  return readJson<Record<string, DreamAgentVerification>>(join(dir, VERIFIED), {});
}

/** The verification of `command`, or `null` when it was never verified (or changed since). */
export function dreamAgentVerification(
  command: DreamAgentCommand,
  dir: string = dreamAgentStateDir(),
): DreamAgentVerification | null {
  return readDreamAgentVerifications(dir)[dreamAgentCommandHash(command)] ?? null;
}

/** Record a passed check of `command`. */
export function recordDreamAgentVerification(
  command: DreamAgentCommand,
  input: { agent: string; model: string; programVersion: string | null; now?: number },
  dir: string = dreamAgentStateDir(),
): DreamAgentVerification {
  const all = readDreamAgentVerifications(dir);
  const entry: DreamAgentVerification = {
    command_hash: dreamAgentCommandHash(command),
    label: command.label,
    agent: input.agent,
    model: input.model,
    verified_at: new Date(input.now ?? Date.now()).toISOString(),
    program_version: input.programVersion,
  };
  all[entry.command_hash] = entry;
  writeJson(join(dir, VERIFIED), all);
  return entry;
}

/** The last run of the worker on this machine, or `null`. */
export function readDreamAgentLastRun(
  dir: string = dreamAgentStateDir(),
): DreamAgentLastRun | null {
  return readJson<DreamAgentLastRun | null>(join(dir, LAST_RUN), null);
}

export function recordDreamAgentLastRun(
  run: DreamAgentLastRun,
  dir: string = dreamAgentStateDir(),
): void {
  writeJson(join(dir, LAST_RUN), run);
}
