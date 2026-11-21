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

import { VaultUnexaminableError } from "../vault-unexaminable.ts";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";

import { atomicWriteFileSync } from "../fs-atomic.ts";
import { assertNoMigrationInProgress } from "../migration-gate.ts";
import { DERIVED_STORE_DIR } from "../brain/path-constants.ts";
import type { CheckResult } from "../types.ts";
import { machineStatePath } from "../state/machine-state.ts";

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
  return machineStatePath(vault, DERIVED_STORE_DIR, SELF_HEAL_UPGRADE_MARKER_FILE);
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
  // A file in the per-vault state: a migration of the vault refuses it.
  assertNoMigrationInProgress(vault);
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
  let failure: ReturnType<typeof readSelfHealUpgradeFailure>;
  try {
    failure = readSelfHealUpgradeFailure(vault);
  } catch (err) {
    // A vault this process cannot examine: the check fails with the one
    // class's message, and the doctor's other checks still answer.
    if (!(err instanceof VaultUnexaminableError)) throw err;
    return { name: SELF_HEAL_UPGRADE_CHECK, ok: false, message: err.message };
  }
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
 * How long a claim made for a worker (`handed`) is held while the process
 * that made it is gone and the worker has not stamped it yet: the start
 * that claims exits right after the spawn, and the worker stamps its own
 * pid when it begins.
 */
export const SELF_HEAL_UPGRADE_HANDOVER_GRACE_MS = 60_000;

/**
 * Lock path for `vault`'s worker: beside the marker in the per-device
 * `.open-second-brain/`, where the search writer lock also lives. Derived
 * from the vault alone, never from the environment: the MCP server, a hook
 * and the worker each run with their own `TMPDIR`, and a lock whose path
 * depended on it would be a different lock in each of them.
 *
 * On a machine that has not switched to the brain store this folder is
 * inside the vault, and a file sync that does not ignore it carries the
 * lock to every other machine of the vault. So the claim names its
 * machine and process ({@link SelfHealUpgradeLockRecord}), and only a
 * live process of this machine holds it ({@link readSelfHealUpgradeLock}).
 */
export function selfHealUpgradeLockPath(vault: string): string {
  return machineStatePath(vault, DERIVED_STORE_DIR, SELF_HEAL_UPGRADE_LOCK_FILE);
}

/** What a claim records. Older releases wrote the bare token only. */
export interface SelfHealUpgradeLockRecord {
  readonly token: string;
  /** The process holding the claim: the claimer, or the worker once it stamped it. */
  readonly pid: number;
  /** The machine that claimed it (`os.hostname()`). */
  readonly host: string;
  /** ISO-8601 instant of the claim. */
  readonly since: string;
  /** True once `pid` is the process that does the work (an in-process claim, or a worker's stamp). */
  readonly worker: boolean;
}

/**
 * Who holds the lock, as one look at it found it:
 *
 *  - `none`: no lock file;
 *  - `here`: a live process of this machine (or a claim being handed to a
 *    worker, within {@link SELF_HEAL_UPGRADE_HANDOVER_GRACE_MS});
 *  - `other-device`: a claim another machine made, which only reached this
 *    one through the file sync of the vault;
 *  - `gone`: a claim of this machine whose process is gone;
 *  - `stale`: a live claim older than {@link SELF_HEAL_UPGRADE_LOCK_STALE_MS};
 *  - `unknown`: a bare token (an older release) or a file that does not
 *    read as a claim: its machine and process cannot be told.
 *
 * `held` is the one judgement: `here` always, `unknown` while younger
 * than the staleness ceiling (the rule older releases apply), nothing else.
 */
export interface SelfHealUpgradeLockHolder {
  readonly kind: "none" | "here" | "other-device" | "gone" | "stale" | "unknown";
  readonly held: boolean;
  readonly path: string;
  readonly pid: number | null;
  readonly host: string | null;
  readonly since: string | null;
  /** Milliseconds since the file's mtime; null without a file. */
  readonly ageMs: number | null;
}

function thisHost(): string {
  try {
    return hostname();
  } catch {
    return "";
  }
}

function lockRecordText(token: string, worker: boolean, now: Date): string {
  const record: SelfHealUpgradeLockRecord = {
    token,
    pid: process.pid,
    host: thisHost(),
    since: now.toISOString(),
    worker,
  };
  return `${JSON.stringify(record)}\n`;
}

/** A claim's text as a record, or null for a bare token or anything else. */
function parseLockRecord(text: string): SelfHealUpgradeLockRecord | null {
  try {
    const raw: unknown = JSON.parse(text);
    if (typeof raw !== "object" || raw === null) return null;
    const r = raw as Record<string, unknown>;
    if (typeof r["token"] !== "string" || typeof r["pid"] !== "number") return null;
    return {
      token: r["token"],
      pid: r["pid"],
      host: typeof r["host"] === "string" ? r["host"] : "",
      since: typeof r["since"] === "string" ? r["since"] : "",
      worker: r["worker"] === true,
    };
  } catch {
    return null;
  }
}

/** Whether process `pid` exists on this machine (a signal-0 probe; EPERM: it exists). */
function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Who holds `vault`'s lock at `now` ({@link SelfHealUpgradeLockHolder}).
 * Cheap: one stat, one small read and a signal probe, never a process
 * identity query, so a session start may ask it.
 */
export function readSelfHealUpgradeLock(vault: string, now: Date): SelfHealUpgradeLockHolder {
  const path = selfHealUpgradeLockPath(vault);
  const blank = { path, pid: null, host: null, since: null };
  let ageMs: number;
  let text: string;
  try {
    ageMs = now.getTime() - statSync(path).mtimeMs;
  } catch (err) {
    // Only a confirmed absence is no claim. A lock that cannot even be
    // stat'ed has no age to judge by and is held: the takeover would have
    // to unlink it through the same failing directory entry, so treating
    // it as free would only turn the refusal into a failed claim.
    if (isMissing(err)) return { kind: "none", held: false, ...blank, ageMs: null };
    return { kind: "unknown", held: true, ...blank, ageMs: null };
  }
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    // Released between the stat and the read: no claim. Any other read
    // failure (a permission, a directory in its place, an I/O error) is a
    // claim whose holder cannot be told, judged exactly as one that reads
    // but is no record (an older release's bare token, below): held while
    // younger than SELF_HEAL_UPGRADE_LOCK_STALE_MS, stale and replaced
    // after. The rule is deliberate in both branches: an hour-old claim
    // nobody can attribute must not block the upgrade forever, and a live
    // worker of this release is protected by its stamped process record,
    // which reads.
    if (isMissing(err)) return { kind: "none", held: false, ...blank, ageMs: null };
    return { kind: "unknown", held: ageMs <= SELF_HEAL_UPGRADE_LOCK_STALE_MS, ...blank, ageMs };
  }
  const record = parseLockRecord(text);
  if (record === null) {
    return { kind: "unknown", held: ageMs <= SELF_HEAL_UPGRADE_LOCK_STALE_MS, ...blank, ageMs };
  }
  const seen = { path, pid: record.pid, host: record.host, since: record.since, ageMs };
  if (record.host !== thisHost()) return { kind: "other-device", held: false, ...seen };
  if (!pidAlive(record.pid)) {
    // A claim made for a worker that has not stamped it yet: its claimer
    // exits right after the spawn, so a gone claimer is no gone holder yet.
    const handing = !record.worker && ageMs <= SELF_HEAL_UPGRADE_HANDOVER_GRACE_MS;
    return handing ? { kind: "here", held: true, ...seen } : { kind: "gone", held: false, ...seen };
  }
  if (ageMs > SELF_HEAL_UPGRADE_LOCK_STALE_MS) return { kind: "stale", held: false, ...seen };
  return { kind: "here", held: true, ...seen };
}

/** One sentence naming a lock's holder, for a log or a report. */
export function describeSelfHealUpgradeLock(holder: SelfHealUpgradeLockHolder): string {
  const since = holder.since !== null && holder.since !== "" ? `, since ${holder.since}` : "";
  switch (holder.kind) {
    case "none":
      return `no claim on ${holder.path}`;
    case "here":
      return `process ${holder.pid} of this machine holds ${holder.path}${since}`;
    case "other-device":
      return (
        `${holder.path} is a claim of another machine (${printable(holder.host ?? "")}, process ` +
        `${holder.pid}${since}) that the vault's file sync brought here; it does not hold this machine`
      );
    case "gone":
      return `${holder.path} names process ${holder.pid} of this machine, which is gone`;
    case "stale":
      return `${holder.path} is older than the staleness ceiling (process ${holder.pid}${since})`;
    case "unknown":
      return (
        `${holder.path} holds a claim whose machine and process cannot be told (an older ` +
        "release writes only a token)"
      );
  }
}

/**
 * What the doctor says about `vault`'s upgrade lock: who holds it
 * ({@link describeSelfHealUpgradeLock}, the text the migration's status
 * shows) and what that means, in place of the generic stale-lock line.
 */
export function selfHealUpgradeLockAdvice(holder: SelfHealUpgradeLockHolder): string {
  const who = describeSelfHealUpgradeLock(holder);
  switch (holder.kind) {
    case "here":
      return (
        `the automatic Brain upgrade's lock: ${who}. The upgrade is running; a store migration ` +
        "of this vault that is due waits for it to end. Nothing to do"
      );
    case "unknown":
      if (holder.ageMs === null) {
        // The stat itself failed: no age, so no expiry either, and the
        // claim stays held for as long as the error lasts.
        return (
          `the automatic Brain upgrade's lock: ${holder.path} is there but cannot be looked at, ` +
          "so its age, and when it would expire, cannot be told. While it cannot be read no " +
          "claim takes it over: check this user's access to the file and its folder " +
          "(permissions, a mount that answers with an error); a store migration does not wait for it"
        );
      }
      return (
        `the automatic Brain upgrade's lock: ${who}. It holds the upgrade off until an hour after ` +
        "it was written, then the next claim takes it over; a store migration does not wait for it"
      );
    case "none":
      return `the automatic Brain upgrade's lock: ${who}`;
    case "stale":
      // Its process still runs: never an invitation to remove a live lock.
      return (
        `the automatic Brain upgrade's lock: process ${holder.pid} of this machine still runs and ` +
        `holds ${holder.path}, but its claim is older than the one-hour ceiling, so the next start ` +
        "takes the lock over and runs the upgrade again. Check with your process list whether " +
        `process ${holder.pid} is an Open Second Brain upgrade that hangs; do not remove the file ` +
        "while it runs. A store migration does not wait for it"
      );
    default:
      return (
        `the automatic Brain upgrade's lock: ${who}. It holds nothing: the next claim takes it ` +
        "over, and a store migration does not wait for it"
      );
  }
}

/**
 * Claim `vault`'s worker lock without waiting: an exclusive create
 * (`O_EXCL`) of a file holding a fresh random token, this process and this
 * machine. Returns the token, or null when the lock is held
 * ({@link readSelfHealUpgradeLock}). A claim that does not hold (another
 * machine's, a gone process's, a stale one) is removed and the create
 * retried once.
 *
 * The claim is a FILE, not a held descriptor, so it can be handed on: the
 * process that starts a detached worker claims first (`handed`) and passes
 * the token on the worker's command line, and the worker stamps its own
 * pid ({@link stampSelfHealUpgradeLock}). That closes the window a
 * probe-then-spawn leaves open - N sessions starting at once make N
 * exclusive creates, one wins, and only the winner spawns - and the worker,
 * not its parent, releases it when it ends.
 */
export function claimSelfHealUpgradeLock(
  vault: string,
  now: Date,
  opts: { readonly handed?: boolean } = {},
): string | null {
  // The lock is a file in the per-vault state a migration of the vault is
  // moving: under its gate nothing is claimed (the refusal is thrown).
  assertNoMigrationInProgress(vault);
  const path = selfHealUpgradeLockPath(vault);
  mkdirSync(dirname(path), { recursive: true });
  const token = randomBytes(16).toString("hex");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, lockRecordText(token, opts.handed !== true, now), { flag: "wx" });
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

/** Whether `vault`'s lock is held at `now` ({@link readSelfHealUpgradeLock}). */
export function selfHealUpgradeLockHeld(vault: string, now: Date): boolean {
  return readSelfHealUpgradeLock(vault, now).held;
}

/** The token a claim's text carries: the record's, or an older release's bare token. */
function tokenOf(text: string): string {
  return parseLockRecord(text)?.token ?? text;
}

/** Whether `token` is the claim on `vault`'s lock right now. */
export function ownsSelfHealUpgradeLock(vault: string, token: string): boolean {
  try {
    return tokenOf(readFileSync(selfHealUpgradeLockPath(vault), "utf8")) === token;
  } catch {
    return false;
  }
}

/**
 * The worker a claim was handed to records itself as its holder: this
 * process, this machine. Returns whether it did: a stamp that cannot be
 * written leaves the claimer's record, held for the handover grace only,
 * so the caller must not do the claim's work (another claimant may take
 * the lock once the grace has run out).
 */
export function stampSelfHealUpgradeLock(vault: string, token: string, now: Date): boolean {
  if (!ownsSelfHealUpgradeLock(vault, token)) return false;
  try {
    // A write into the vault's state folder: refused, like the claim, while
    // a migration of the vault holds its gate.
    assertNoMigrationInProgress(vault);
    atomicWriteFileSync(selfHealUpgradeLockPath(vault), lockRecordText(token, true, now));
    return true;
  } catch {
    return false;
  }
}

function isMissing(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
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
