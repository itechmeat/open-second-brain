/**
 * What the automatic Brain upgrade last failed with, and when it may try
 * again.
 *
 * `ensureVaultCurrent` hands a pending `_brain.yaml` / `_BRAIN.md` upgrade
 * to a detached worker (`self-heal-upgrade.ts`). A worker whose upgrade
 * failed used to leave no trace anywhere an operator looks: the error went
 * into a result nobody read, the next start ran the same failing upgrade
 * again (snapshot included), and `o2b doctor` reported everything OK. This
 * module is the record that closes that gap:
 *
 *   - a FAILURE MARKER, `<vault>/.open-second-brain/self-heal-upgrade.json`,
 *     holding the last error, when it happened, how many attempts in a row
 *     failed and when the next automatic attempt is due. `o2b doctor`,
 *     `o2b brain status` and `o2b brain upgrade --dry-run` read it.
 *   - a BACKOFF read off that marker: a failed upgrade is retried
 *     automatically only after a cooldown that doubles with each consecutive
 *     failure ({@link selfHealUpgradeCooldownMs}). An explicit
 *     `o2b brain upgrade --apply` ignores it and clears it on success.
 *   - the WORKER LOCK, `<vault>/.open-second-brain/self-heal-upgrade.lock`,
 *     one per vault per device, so N sessions starting at once start one
 *     worker, not N.
 *
 * ## Why the marker is per device
 *
 * It lives beside the search index under `.open-second-brain/`, the
 * per-device directory, not under `Brain/`, which syncs to peers. A failure
 * is often a property of the device (a missing tool, a full disk, a
 * read-only mount), and a synced marker would make a healthy peer back off
 * from an upgrade it could apply. It is also not a "done" stamp: it only
 * ever delays a retry, never skips a pending upgrade, so the state-driven
 * rule in `ensure-current.ts` still holds.
 *
 * Leaf module on purpose: the doctor and the operator snapshot read the
 * marker without pulling the upgrade and snapshot machinery in.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { atomicWriteFileSync } from "../fs-atomic.ts";
import { DERIVED_STORE_DIR } from "../brain/path-constants.ts";
import type { CheckResult } from "../types.ts";

/** Marker file name inside the per-device `.open-second-brain/` directory. */
export const SELF_HEAL_UPGRADE_MARKER_FILE = "self-heal-upgrade.json";

/** First cooldown after a failure. */
export const SELF_HEAL_UPGRADE_BASE_COOLDOWN_MS = 60 * 60_000;

/** Longest cooldown, however many attempts failed in a row. */
export const SELF_HEAL_UPGRADE_MAX_COOLDOWN_MS = 24 * 60 * 60_000;

/**
 * A worker lock older than this belongs to a worker that died (or hung in
 * a subprocess) and is taken over. It is the ceiling on how long one stuck
 * worker can keep every later start from trying.
 */
export const SELF_HEAL_UPGRADE_LOCK_STALE_MS = 60 * 60_000;

/** The command that shows the pending item and this record. */
export const SELF_HEAL_UPGRADE_NEXT_COMMAND = "o2b brain upgrade --dry-run";

/** One recorded failure of the automatic upgrade. */
export interface SelfHealUpgradeFailure {
  /** ISO-8601 instant of the last failed attempt. */
  readonly failedAt: string;
  /** The failure, as the upgrade reported it. */
  readonly error: string;
  /** Attempts in a row that failed, this one included. At least 1. */
  readonly consecutiveFailures: number;
  /** Vault-relative paths the failed attempt was going to rewrite. */
  readonly pending: ReadonlyArray<string>;
  /** ISO-8601 instant from which an automatic attempt is due again. */
  readonly retryAfter: string;
}

export function selfHealUpgradeMarkerPath(vault: string): string {
  return join(vault, DERIVED_STORE_DIR, SELF_HEAL_UPGRADE_MARKER_FILE);
}

/** Cooldown after `consecutiveFailures` failures in a row. */
export function selfHealUpgradeCooldownMs(consecutiveFailures: number): number {
  const exponent = Math.max(0, Math.min(consecutiveFailures - 1, 16));
  return Math.min(
    SELF_HEAL_UPGRADE_BASE_COOLDOWN_MS * 2 ** exponent,
    SELF_HEAL_UPGRADE_MAX_COOLDOWN_MS,
  );
}

/**
 * The recorded failure, or null when none is recorded.
 *
 * A marker that exists and cannot be read or parsed is reported as a
 * failure of its own rather than as "none": it was written because an
 * upgrade failed, and reading it back as healthy is the silence this
 * module exists to end. Its `retryAfter` is the epoch, so it never blocks
 * a retry either.
 */
export function readSelfHealUpgradeFailure(vault: string): SelfHealUpgradeFailure | null {
  const path = selfHealUpgradeMarkerPath(vault);
  if (!existsSync(path)) return null;
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof raw !== "object" || raw === null) throw new Error("not a JSON object");
    const r = raw as Record<string, unknown>;
    if (typeof r["failed_at"] !== "string" || typeof r["error"] !== "string") {
      throw new Error("missing failed_at or error");
    }
    const consecutive =
      typeof r["consecutive_failures"] === "number" && r["consecutive_failures"] >= 1
        ? Math.floor(r["consecutive_failures"])
        : 1;
    const pending = Array.isArray(r["pending"])
      ? r["pending"].filter((p): p is string => typeof p === "string")
      : [];
    const retryAfter =
      typeof r["retry_after"] === "string" ? r["retry_after"] : new Date(0).toISOString();
    return Object.freeze({
      failedAt: r["failed_at"],
      error: r["error"],
      consecutiveFailures: consecutive,
      pending: Object.freeze(pending),
      retryAfter,
    });
  } catch (err) {
    return Object.freeze({
      failedAt: new Date(0).toISOString(),
      error: `unreadable failure marker (${(err as Error).message ?? String(err)})`,
      consecutiveFailures: 1,
      pending: Object.freeze([]),
      retryAfter: new Date(0).toISOString(),
    });
  }
}

/**
 * Whether an automatic attempt must wait: a failure is recorded and its
 * cooldown has not run out at `now`.
 */
export function selfHealUpgradeBackoffActive(
  failure: SelfHealUpgradeFailure | null,
  now: Date,
): boolean {
  if (failure === null) return false;
  const until = Date.parse(failure.retryAfter);
  if (!Number.isFinite(until)) return false;
  // Never longer than the longest cooldown after the recorded failure, and
  // never from a failure dated in the future: a marker this build did not
  // write (another release, a hand edit, a copied vault) cannot hold the
  // automatic upgrade off indefinitely.
  const failedAt = Date.parse(failure.failedAt);
  if (!Number.isFinite(failedAt) || failedAt > now.getTime()) return false;
  const ceiling = failedAt + SELF_HEAL_UPGRADE_MAX_COOLDOWN_MS;
  return now.getTime() < Math.min(until, ceiling);
}

/** Record a failed attempt; returns what was written. */
export function recordSelfHealUpgradeFailure(
  vault: string,
  error: string,
  pending: ReadonlyArray<string>,
  now: Date,
): SelfHealUpgradeFailure {
  const previous = readSelfHealUpgradeFailure(vault);
  const consecutiveFailures = (previous?.consecutiveFailures ?? 0) + 1;
  const retryAfter = new Date(now.getTime() + selfHealUpgradeCooldownMs(consecutiveFailures));
  const record = {
    failed_at: now.toISOString(),
    error,
    consecutive_failures: consecutiveFailures,
    pending: [...pending],
    retry_after: retryAfter.toISOString(),
  };
  const path = selfHealUpgradeMarkerPath(vault);
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteFileSync(path, JSON.stringify(record, null, 2) + "\n");
  return Object.freeze({
    failedAt: record.failed_at,
    error,
    consecutiveFailures,
    pending: Object.freeze([...pending]),
    retryAfter: record.retry_after,
  });
}

/**
 * Drop the failure record once the upgrade it describes is no longer
 * pending (applied, or made moot). The marker is this tool's own state
 * file, never vault content.
 */
export function clearSelfHealUpgradeFailure(vault: string): void {
  try {
    unlinkSync(selfHealUpgradeMarkerPath(vault));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/** One-line operator description of a recorded failure. */
export function describeSelfHealUpgradeFailure(failure: SelfHealUpgradeFailure): string {
  const pending =
    failure.pending.length > 0 ? ` (pending: ${printable(failure.pending.join(", "))})` : "";
  return (
    `the automatic Brain upgrade failed at ${printable(failure.failedAt)}${pending}: ` +
    `${printable(failure.error)}; ` +
    `${failure.consecutiveFailures} consecutive failure(s), next automatic attempt after ` +
    `${printable(failure.retryAfter)}`
  );
}

/**
 * The marker is read back off disk and printed to a terminal, so control
 * characters (an escape sequence included) are replaced before they reach it.
 */
function printable(text: string): string {
  // oxlint-disable-next-line no-control-regex -- matching control characters is the point
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
}

/** Name of the `o2b doctor` check that reports a recorded failure. */
export const SELF_HEAL_UPGRADE_CHECK = "self_heal_upgrade";

/**
 * The `o2b doctor` check: failed while a failure is recorded, with the
 * error, the time and the next automatic attempt in the message.
 */
export function checkSelfHealUpgrade(vault: string): CheckResult {
  const failure = readSelfHealUpgradeFailure(vault);
  if (failure === null) {
    return {
      name: SELF_HEAL_UPGRADE_CHECK,
      ok: true,
      message: "no failed automatic Brain upgrade is recorded",
    };
  }
  return {
    name: SELF_HEAL_UPGRADE_CHECK,
    ok: false,
    message: describeSelfHealUpgradeFailure(failure),
    fix: SELF_HEAL_UPGRADE_NEXT_COMMAND,
  };
}

// ----- Worker lock ---------------------------------------------------------

/** Lock file name inside the per-device `.open-second-brain/` directory. */
export const SELF_HEAL_UPGRADE_LOCK_FILE = "self-heal-upgrade.lock";

/**
 * Lock path for `vault`'s worker: beside the marker in the per-device
 * `.open-second-brain/`, where the search writer lock also lives. Derived
 * from the vault alone, never from the environment: the MCP server, a hook
 * and the worker each run with their own `TMPDIR`, and a lock whose path
 * depended on it would be a different lock in each of them.
 */
export function selfHealUpgradeLockPath(vault: string): string {
  return join(vault, DERIVED_STORE_DIR, SELF_HEAL_UPGRADE_LOCK_FILE);
}

/**
 * Claim `vault`'s worker lock without waiting: an exclusive create
 * (`O_EXCL`) of a file holding a fresh random token. Returns the token, or
 * null when a live (not stale) claim exists. A stale claim is removed and
 * the create retried once.
 *
 * The claim is a FILE, not a held descriptor, so it can be handed on: the
 * process that starts a detached worker claims first and passes the token
 * on the worker's command line. That closes the window a probe-then-spawn
 * leaves open - N sessions starting at once make N exclusive creates, one
 * wins, and only the winner spawns - and the worker, not its parent,
 * releases it when it ends.
 */
export function claimSelfHealUpgradeLock(vault: string, now: Date): string | null {
  const path = selfHealUpgradeLockPath(vault);
  mkdirSync(dirname(path), { recursive: true });
  const token = randomBytes(16).toString("hex");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, token, { flag: "wx" });
      return token;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (selfHealUpgradeLockHeld(vault, now)) return null;
      try {
        unlinkSync(path);
      } catch {
        // raced with the holder's release or another takeover; retry
      }
    }
  }
  return null;
}

/** Whether a live (not stale) claim on `vault`'s lock exists at `now`. */
export function selfHealUpgradeLockHeld(vault: string, now: Date): boolean {
  try {
    const age = now.getTime() - statSync(selfHealUpgradeLockPath(vault)).mtimeMs;
    return age <= SELF_HEAL_UPGRADE_LOCK_STALE_MS;
  } catch {
    return false;
  }
}

/** Whether `token` is the claim on `vault`'s lock right now. */
export function ownsSelfHealUpgradeLock(vault: string, token: string): boolean {
  try {
    return readFileSync(selfHealUpgradeLockPath(vault), "utf8") === token;
  } catch {
    return false;
  }
}

/**
 * Release the claim `token` made. A lock that is no longer ours (taken
 * over as stale by another process) is left alone.
 */
export function releaseSelfHealUpgradeLock(vault: string, token: string): void {
  if (!ownsSelfHealUpgradeLock(vault, token)) return;
  try {
    unlinkSync(selfHealUpgradeLockPath(vault));
  } catch {
    // already gone
  }
}
