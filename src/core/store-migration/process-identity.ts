/**
 * The start identity of a process: a string that names one process for its
 * whole life and changes when its pid is reused by another. The migration
 * gate records its holder's identity (`quiesce.ts`), so a gate left by a
 * crashed run whose pid now belongs to an unrelated process counts as
 * stale instead of blocking every gate-taking run until that process
 * exits.
 *
 *  - Linux: the boot id and the start time in clock ticks since boot from
 *    `/proc/<pid>/stat`, exact and independent of the wall clock.
 *  - Windows: the process creation time from PowerShell, as a file time.
 *  - Other systems (macOS, the BSDs): the start time `ps` prints, with a
 *    fixed locale and time zone so the text never varies.
 *
 * The identity is null when it cannot be read (the process is gone, the
 * tool is missing, access is denied); callers treat that as "cannot tell"
 * and never as proof either way. Only comparisons on one machine matter:
 * the gate file is device-local and never syncs.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** How long one external query (PowerShell, ps) may take. */
const QUERY_TIMEOUT_MS = 15_000;

/** Index of `starttime` (field 22) among the fields after the command name. */
const STAT_STARTTIME_INDEX = 19;

function linuxIdentity(pid: number): string | null {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  // The command name sits in parentheses and may hold spaces or ")".
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  const ticks = fields[STAT_STARTTIME_INDEX];
  if (ticks === undefined || !/^\d+$/.test(ticks)) return null;
  let boot = "";
  try {
    boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  } catch {
    // Some containers hide it; the ticks alone still tell processes apart.
  }
  return `linux:${boot}:${ticks}`;
}

function query(command: string, args: ReadonlyArray<string>, env?: NodeJS.ProcessEnv): string {
  const out = spawnSync(command, args, {
    encoding: "utf8",
    timeout: QUERY_TIMEOUT_MS,
    windowsHide: true,
    env: env ?? process.env,
  });
  return out.status === 0 && typeof out.stdout === "string" ? out.stdout.trim() : "";
}

function windowsIdentity(pid: number): string | null {
  const out = query("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToFileTimeUtc()`,
  ]);
  return /^\d+$/.test(out) ? `win32:${out}` : null;
}

function psIdentity(pid: number): string | null {
  const out = query("ps", ["-o", "lstart=", "-p", String(pid)], {
    ...process.env,
    LC_ALL: "C",
    TZ: "UTC",
  });
  return out === "" ? null : `ps:${out.replace(/\s+/g, " ")}`;
}

let own: string | null | undefined;

/** The start identity of process `pid`, or null when it cannot be read. */
export function processStartIdentity(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  // This process's identity never changes: read it once.
  if (pid === process.pid && own !== undefined) return own;
  let identity: string | null;
  try {
    if (process.platform === "linux") identity = linuxIdentity(pid);
    else if (process.platform === "win32") identity = windowsIdentity(pid);
    else identity = psIdentity(pid);
  } catch {
    identity = null;
  }
  if (pid === process.pid) own = identity;
  return identity;
}
