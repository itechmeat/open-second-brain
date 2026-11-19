/**
 * The liveness rule the migration gate and the automatic migration's
 * worker lock share, on top of a process's start identity
 * (`process-identity.ts`): a recorded holder (pid, start identity) runs
 * when its pid is alive and its start identity, when both sides can be
 * read, is the recorded one.
 *
 * Reading an identity can cost an external query (PowerShell on Windows,
 * `ps` on macOS and the BSDs). Paths that must stay cheap (a session
 * start, the runtime notices) judge a holder with {@link processAlive}
 * alone and leave the exact check to the worker and the manual verb.
 */

import { processStartIdentity } from "./process-identity.ts";

/**
 * Whether process `pid` exists. A signal-0 probe, which Node answers on
 * every platform (on Windows through `OpenProcess`): `EPERM` means the
 * process exists but belongs to someone else.
 */
export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** What a liveness check of a recorded holder found. */
export type HolderLiveness =
  /** The pid is gone, or now belongs to another process (its start identity differs). */
  | "dead"
  /** The pid is alive and its start identity is the recorded one. */
  | "alive"
  /** The pid is alive, but no identity was recorded or none can be read now. */
  | "unknown";

/**
 * The liveness rule the migration gate and the automatic migration's
 * worker lock share: a recorded holder (pid, start identity) runs when
 * its pid is alive and its start identity, when both sides can be read,
 * is the recorded one. The identity is read only for a live pid, so a
 * dead holder costs one signal probe.
 */
export function holderLiveness(pid: number, started: string | null | undefined): HolderLiveness {
  if (!processAlive(pid)) return "dead";
  if (started === undefined || started === null) return "unknown";
  const now = processStartIdentity(pid);
  if (now === null) return "unknown";
  return now === started ? "alive" : "dead";
}
