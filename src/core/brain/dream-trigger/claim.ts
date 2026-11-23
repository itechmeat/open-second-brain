/**
 * The claim of the dream session trigger (change `dream-session-trigger`,
 * design D2 item 4, D3): a file beside the day record, created
 * exclusively before a worker is started, that holds a random token, when
 * it was made and the process that made it. The token goes to the worker
 * as `--claim <token>`; the worker proves it and writes its own pid into
 * the claim (the process that made the claim exits at once, and a lock
 * that follows its holder's life cannot be handed over), so a claim whose
 * worker lives is never judged lost; it removes the claim once it has
 * recorded the outcome.
 *
 * Creating is exclusive (two sessions at the same moment make one claim);
 * reading back, judging and removing a claim run under the claim's
 * device-local lock and reread it there, so a claim judged lost by one
 * check is not removed after another check, or its worker, replaced it.
 */

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";

import { atomicWriteFileSync } from "../../fs-atomic.ts";
import { tryCreateLockFile } from "../../fs-lock.ts";
import { withLocalLock } from "../../store/local-lock.ts";

export interface DreamTriggerClaim {
  readonly token: string;
  /** When the claim was made (ms since the epoch). */
  readonly at: number;
  /** The process that made the claim (a hook, an MCP server). */
  readonly pid: number;
  /** The worker that proved the token, once it has; `null` before. */
  readonly worker_pid: number | null;
}

/** A claim as read: the record, one that cannot be read (with its file's age), or none. */
export type ClaimSeen =
  | { readonly kind: "absent" }
  | { readonly kind: "claim"; readonly claim: DreamTriggerClaim }
  | { readonly kind: "unreadable"; readonly mtimeMs: number };

function parseClaim(text: string): DreamTriggerClaim | null {
  try {
    const v = JSON.parse(text) as Record<string, unknown>;
    const { token, at, pid } = v;
    const worker = v["worker_pid"] ?? null;
    if (typeof token !== "string" || token.length === 0) return null;
    if (typeof at !== "number" || !Number.isFinite(at)) return null;
    if (typeof pid !== "number" || !Number.isInteger(pid)) return null;
    if (worker !== null && (typeof worker !== "number" || !Number.isInteger(worker))) return null;
    return { token, at, pid, worker_pid: worker };
  } catch {
    return null;
  }
}

/** The claim at `path` as it is now. */
export function readClaim(path: string): ClaimSeen {
  let text: string;
  let mtimeMs: number | null = null;
  try {
    mtimeMs = statSync(path).mtimeMs;
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    // A claim that exists and cannot be read is judged by its file's age
    // (it ages like any claim); only one that cannot even be looked at is
    // judged as made now.
    return { kind: "unreadable", mtimeMs: mtimeMs ?? Date.now() };
  }
  const claim = parseClaim(text);
  return claim === null ? { kind: "unreadable", mtimeMs } : { kind: "claim", claim };
}

/** When the claim seen was made, for its age. */
export function claimMadeAt(seen: Exclude<ClaimSeen, { kind: "absent" }>): number {
  return seen.kind === "claim" ? seen.claim.at : seen.mtimeMs;
}

/**
 * Create the claim at `path` exclusively. Returns its token, or `null`
 * when a claim is already there. `workerPid` is set by a process that
 * runs the pass itself (a whole live entry point), so the claim stands
 * for as long as it lives.
 */
export function createClaim(
  path: string,
  now: number,
  workerPid: number | null = null,
): string | null {
  const claim: DreamTriggerClaim = {
    token: randomBytes(16).toString("hex"),
    at: now,
    pid: process.pid,
    worker_pid: workerPid,
  };
  const made = tryCreateLockFile(path, (fd) => {
    writeSync(fd, JSON.stringify(claim));
  });
  return "created" in made ? claim.token : null;
}

function removeIfThere(path: string): void {
  try {
    unlinkSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/**
 * Remove the claim at `path` when it is still the one `matches` accepts,
 * judged again under the claim's lock. Returns whether it was removed.
 */
export function removeClaimIf(path: string, matches: (seen: ClaimSeen) => boolean): boolean {
  // No claim, nothing to judge: the lock (and its folder) is not made.
  if (!existsSync(path)) return false;
  return withLocalLock(path, () => {
    const seen = readClaim(path);
    if (seen.kind === "absent" || !matches(seen)) return false;
    removeIfThere(path);
    return true;
  });
}

/** Remove the claim at `path` when it still holds `token`. */
export function releaseClaim(path: string, token: string): boolean {
  return removeClaimIf(path, (seen) => seen.kind === "claim" && seen.claim.token === token);
}

/**
 * Prove `token` and write the worker's pid into the claim at `path`,
 * under the claim's lock. Returns whether the claim held the token.
 */
export function adoptClaim(path: string, token: string, pid: number = process.pid): boolean {
  // No claim cannot come to hold this token: the lock (and its folder) is not made.
  if (!existsSync(path)) return false;
  return withLocalLock(path, () => {
    const seen = readClaim(path);
    if (seen.kind !== "claim" || seen.claim.token !== token) return false;
    atomicWriteFileSync(path, JSON.stringify({ ...seen.claim, worker_pid: pid }));
    return true;
  });
}
