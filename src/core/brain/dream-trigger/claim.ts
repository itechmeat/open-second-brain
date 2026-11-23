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

/**
 * A claim as read: the record; one read whole that is not a claim (with
 * its file's age); one that is there and cannot be read now (permissions,
 * I/O), which says nothing about its holder; or none.
 */
export type ClaimSeen =
  | { readonly kind: "absent" }
  | { readonly kind: "claim"; readonly claim: DreamTriggerClaim }
  | { readonly kind: "unreadable"; readonly mtimeMs: number }
  | { readonly kind: "inconclusive" };

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
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    // A claim that is there and cannot be read now hides its worker's
    // pid: it is never aged out, only one read whole is.
    return { kind: "inconclusive" };
  }
  const claim = parseClaim(text);
  return claim === null ? { kind: "unreadable", mtimeMs } : { kind: "claim", claim };
}

/** When the claim seen was made, for its age. */
export function claimMadeAt(seen: Extract<ClaimSeen, { kind: "claim" | "unreadable" }>): number {
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
  retryFailedReleases(path);
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

/**
 * Claims this process failed to give back, by path. A claim a whole live
 * run holds carries this process's pid, so it would stand for as long as
 * the process lives: the next claim this process makes at the same path
 * gives it back first.
 */
const failedReleases = new Map<string, Set<string>>();

function retryFailedReleases(path: string): void {
  const tokens = failedReleases.get(path);
  if (tokens === undefined) return;
  for (const token of tokens) {
    try {
      releaseClaim(path, token);
    } catch {
      // still not given back: the next claim tries again
    }
  }
}

/**
 * Remove the claim at `path` when it still holds `token`. A failure is
 * thrown and remembered: the next claim this process makes at `path`
 * gives the claim back first. A claim that cannot be read stays
 * remembered too: the token is forgotten only once the claim is removed,
 * gone, or read whole holding another token.
 */
export function releaseClaim(path: string, token: string): boolean {
  let outcome: "removed" | "settled" | "unsure";
  try {
    // No claim, nothing to judge: the lock (and its folder) is not made.
    outcome = !existsSync(path)
      ? "settled"
      : withLocalLock(path, () => {
          const seen = readClaim(path);
          if (seen.kind === "claim" && seen.claim.token === token) {
            removeIfThere(path);
            return "removed";
          }
          return seen.kind === "absent" || seen.kind === "claim" ? "settled" : "unsure";
        });
  } catch (err) {
    remember(path, token);
    throw err;
  }
  if (outcome === "unsure") {
    remember(path, token);
    return false;
  }
  const tokens = failedReleases.get(path);
  if (tokens !== undefined) {
    tokens.delete(token);
    if (tokens.size === 0) failedReleases.delete(path);
  }
  return outcome === "removed";
}

function remember(path: string, token: string): void {
  const tokens = failedReleases.get(path) ?? new Set<string>();
  tokens.add(token);
  failedReleases.set(path, tokens);
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
