/**
 * The legacy tree leaves the vault on its own (release 2.0.1): once every
 * device of the migration cohort has switched to the brain store or been
 * retired (by hand or by silence), the switched machine moves `Brain/` and
 * `.open-second-brain/` out of the vault exactly as
 * `o2b brain migrate-store --remove-legacy` does, with its archive and
 * every one of its refusals (`removal.ts`). Nothing here judges the cohort,
 * the shards or the tree: the removal does, and this module only decides
 * when to ask it and remembers its answer.
 *
 *  - **Who asks.** A session start or an MCP server start on a switched
 *    machine (`ensureVaultCurrent`) starts a detached worker
 *    (`o2b brain migrate-store --auto-remove-legacy`) when a legacy root is
 *    still in the vault and the last attempt is old enough; the automatic
 *    migration's own worker asks right after it switched the machine, so a
 *    machine that is the whole cohort loses the tree in the same update.
 *  - **The setting.** `auto_legacy_removal` in the machine config (default
 *    on, fail closed, `config.ts`), and off whenever
 *    `auto_store_migration` is off.
 *  - **The cadence.** A start asks at most once an hour while the cohort
 *    waits for a device, and once a day after a refusal; the worker lock
 *    keeps one removal at a time per vault.
 *  - **What the person sees.** At most one line a day at session start
 *    while the tree stays (which device to update, or why the removal
 *    refuses), and one line once after the tree left.
 *
 * The state is device-local, beside the automatic migration's
 * (`auto-state.ts`), never in the vault or the store. Every function here
 * fails open: a session start never fails because of it.
 */

import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { resolveAutoLegacyRemoval } from "../config.ts";
import {
  atomicCreateFileSyncExclusive,
  atomicWriteFileSync,
  FileAlreadyExistsError,
} from "../fs-atomic.ts";
import { o2bCommand, spawnSelfDetached } from "../maintenance/o2b-command.ts";
import { autoMigrationStateDir, printable, reportableText } from "./auto-state.ts";
import { processAlive } from "./holder-liveness.ts";
import { STORE_VAULT_DIR } from "../store/constants.ts";
import { cohortRecordsInFlight } from "./cohort-in-flight.ts";
import { openMigrationStore, recordOwnSwitchCut, safeAgent } from "./migrate.ts";
import { removeLegacy } from "./outcome.ts";
import {
  legacyRootPresent,
  readRemovalInProgress,
  removeEmptyLegacyRoots,
  type RemovalResult,
} from "./removal.ts";
import { sameVaultPath } from "./removal-marker.ts";

/** The worker's entry flag on `o2b brain migrate-store`. Not an operator flag. */
export const AUTO_LEGACY_REMOVAL_FLAG = "--auto-remove-legacy";

/** The command a person runs to remove the tree by hand. */
export const REMOVE_LEGACY_COMMAND = "o2b brain migrate-store --remove-legacy";

const STATE_FILE = "legacy-removal.json";
const LOCK_FILE = "legacy-removal.lock";
const LOG_FILE = "legacy-removal.log";
/** Whether this device's own migration cut was published, beside the removal state. */
const CUT_FILE = "own-switch-cut.json";

const HOUR_MS = 60 * 60 * 1000;

/** How long a start waits after an attempt before it asks again (the cohort may move any time). */
export const AUTO_REMOVAL_RETRY_MS = HOUR_MS;

/** How long a start waits after a refusal, which a person has to act on. */
export const AUTO_REMOVAL_REFUSED_RETRY_MS = 24 * HOUR_MS;

/** A worker lock older than this is taken over even when its pid runs (a reused pid). */
const LOCK_STALE_MS = 24 * HOUR_MS;

/** How the last automatic removal attempt ended. */
export type AutoRemovalOutcome =
  /** An attempt started and has not recorded its end (running, or killed). */
  | "attempt"
  /** The tree left the vault. */
  | "removed"
  /** Nothing of the legacy tree was left in the vault. */
  | "nothing"
  /** A cohort device is still on the legacy layout. */
  | "pending"
  /** The removal refused or failed; `reason` says why. */
  | "refused";

/** A cohort device the removal waits for, with its last evidence of life. */
export interface AutoRemovalPendingDevice {
  readonly device: string;
  readonly last_evidence: string | null;
}

/** The device-local record of the last automatic removal attempt of a vault. */
export interface AutoRemovalState {
  /** ISO instant the attempt started. */
  readonly at: string;
  readonly outcome: AutoRemovalOutcome;
  readonly pending?: ReadonlyArray<AutoRemovalPendingDevice>;
  /**
   * The wait is for records still on their way, not for a device on the
   * legacy layout (`cohort-in-flight.ts`): `pending` names the devices
   * whose records have not arrived, `reason` says why when none is named.
   */
  readonly in_flight?: boolean;
  readonly reason?: string;
  readonly archive?: string;
  /** Local day (YYYY-MM-DD) the waiting line was last shown at a session start. */
  readonly shown_day?: string;
  /** The line about a finished removal was shown. */
  readonly shown_removed?: boolean;
}

function statePath(vault: string): string {
  return join(autoMigrationStateDir(vault), STATE_FILE);
}

function lockPath(vault: string): string {
  return join(autoMigrationStateDir(vault), LOCK_FILE);
}

/** The worker's error output, beside its state. */
export function autoLegacyRemovalLogPath(vault: string): string {
  return join(autoMigrationStateDir(vault), LOG_FILE);
}

function cutPath(vault: string): string {
  return join(autoMigrationStateDir(vault), CUT_FILE);
}

/** The last check of this device's own migration cut: when, and whether it ended. */
interface OwnCutCheck {
  readonly at: string;
  readonly done: boolean;
}

function readOwnCutCheck(vault: string): OwnCutCheck | null {
  try {
    const parsed = JSON.parse(readFileSync(cutPath(vault), "utf8")) as Partial<OwnCutCheck>;
    if (typeof parsed.at !== "string" || typeof parsed.done !== "boolean") return null;
    return { at: parsed.at, done: parsed.done };
  } catch {
    return null;
  }
}

function writeOwnCutCheck(vault: string, check: OwnCutCheck): void {
  try {
    mkdirSync(autoMigrationStateDir(vault), { recursive: true });
    atomicWriteFileSync(cutPath(vault), `${JSON.stringify(check)}\n`);
  } catch {
    // asked again at a later start
  }
}

/**
 * Whether a start owes this device's own migration cut a worker though
 * the removal itself is off: the cut is what the other devices' removals
 * wait for (`recordOwnSwitchCut`), so turning the removal off here must
 * not hold theirs. Asked until one check ended, at most once an hour.
 */
function ownCutCheckOwed(vault: string, nowMs: number): boolean {
  const last = readOwnCutCheck(vault);
  if (last === null) return true;
  if (last.done) return false;
  const age = nowMs - Date.parse(last.at);
  return !(Number.isFinite(age) && age >= 0 && age < AUTO_REMOVAL_RETRY_MS);
}

/** The last attempt's record, or null when there is none or it cannot be read. */
export function readAutoRemovalState(vault: string): AutoRemovalState | null {
  try {
    const parsed = JSON.parse(readFileSync(statePath(vault), "utf8")) as Partial<AutoRemovalState>;
    if (typeof parsed.at !== "string" || typeof parsed.outcome !== "string") return null;
    return parsed as AutoRemovalState;
  } catch {
    return null;
  }
}

function writeState(vault: string, state: AutoRemovalState): void {
  mkdirSync(autoMigrationStateDir(vault), { recursive: true });
  atomicWriteFileSync(statePath(vault), `${JSON.stringify(state)}\n`);
}

interface LockBody {
  readonly pid: number;
  readonly at: number;
}

function readLock(vault: string): LockBody | null {
  try {
    const parsed = JSON.parse(readFileSync(lockPath(vault), "utf8")) as Partial<LockBody>;
    if (typeof parsed.pid === "number" && typeof parsed.at === "number") {
      return { pid: parsed.pid, at: parsed.at };
    }
  } catch {
    // none, or not a whole claim (never one being written: `takeLock`)
  }
  return null;
}

/** Whether a live worker holds the removal lock of `vault` (judged by pid, as a start judges). */
function lockHeld(vault: string, nowMs: number): boolean {
  const lock = readLock(vault);
  return lock !== null && nowMs - lock.at < LOCK_STALE_MS && processAlive(lock.pid);
}

/** Whether an automatic removal worker of `vault` runs now (its lock judged by pid). */
export function autoLegacyRemovalRunning(vault: string, now: Date = new Date()): boolean {
  try {
    return lockHeld(vault, now.getTime());
  } catch {
    return false;
  }
}

/**
 * Take the removal lock: an exclusive create, over a holder that is gone.
 * False when held. The claim is published whole (a temp file linked into
 * place), so the lock is never seen without its body: one that cannot be
 * read is abandoned (a process that died before its claim was whole, an
 * older build's empty claim), never one a live worker is still writing,
 * and it is taken over as a dead holder's is.
 */
function takeLock(vault: string, nowMs: number): boolean {
  mkdirSync(autoMigrationStateDir(vault), { recursive: true });
  const path = lockPath(vault);
  for (let tries = 0; tries < 2; tries++) {
    try {
      atomicCreateFileSyncExclusive(path, JSON.stringify({ pid: process.pid, at: nowMs }), {
        mode: 0o600,
      });
      return true;
    } catch (err) {
      if (!(err instanceof FileAlreadyExistsError)) throw err;
      if (lockHeld(vault, nowMs)) return false;
      rmSync(path, { force: true });
    }
  }
  return false;
}

function releaseLock(vault: string): void {
  const lock = readLock(vault);
  if (lock !== null && lock.pid === process.pid) rmSync(lockPath(vault), { force: true });
}

/**
 * Whether a start should ask for the removal now: the setting is on, a
 * legacy root is in the vault, no worker runs and the last attempt is old
 * enough. Cheap: the config, two `stat`s and two small device-local files.
 * The caller has established that this machine switched.
 */
export function shouldStartAutoLegacyRemoval(
  vault: string,
  configPath: string | undefined,
  now: Date,
): boolean {
  if (!legacyRootPresent(vault)) return false;
  const nowMs = now.getTime();
  if (lockHeld(vault, nowMs)) return false;
  // Off: a worker only for this device's own cut, which the other
  // devices' removals need whatever this machine's setting says.
  if (!resolveAutoLegacyRemoval(configPath)) return ownCutCheckOwed(vault, nowMs);
  const last = readAutoRemovalState(vault);
  if (last !== null) {
    const age = nowMs - Date.parse(last.at);
    const wait = last.outcome === "refused" ? AUTO_REMOVAL_REFUSED_RETRY_MS : AUTO_REMOVAL_RETRY_MS;
    if (Number.isFinite(age) && age >= 0 && age < wait) return false;
  }
  return true;
}

/**
 * Start the detached removal worker when {@link shouldStartAutoLegacyRemoval}
 * says so. The attempt is recorded before the spawn, so starts that come
 * at the same moment start one worker, and a worker that dies is asked
 * again only after the retry interval. Returns whether a worker started.
 */
export function startAutoLegacyRemoval(
  vault: string,
  configPath: string | undefined,
  now: Date,
): boolean {
  if (!shouldStartAutoLegacyRemoval(vault, configPath, now)) return false;
  if (resolveAutoLegacyRemoval(configPath)) {
    const last = readAutoRemovalState(vault);
    writeState(vault, { ...carried(last), at: now.toISOString(), outcome: "attempt" });
  } else {
    // Held off for an hour, as an attempt is, while the worker runs.
    writeOwnCutCheck(vault, { at: now.toISOString(), done: false });
  }
  spawnSelfDetached(
    [...o2bCommand(), "brain", "migrate-store", "--vault", vault, AUTO_LEGACY_REMOVAL_FLAG],
    {
      env: {
        ...process.env,
        ...(configPath !== undefined ? { OPEN_SECOND_BRAIN_CONFIG: configPath } : {}),
      },
      stderrLog: autoLegacyRemovalLogPath(vault),
    },
  );
  return true;
}

/** What a new record keeps of the last one: when the waiting line was shown. */
function carried(last: AutoRemovalState | null): Pick<AutoRemovalState, "shown_day"> {
  return last?.shown_day !== undefined ? { shown_day: last.shown_day } : {};
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The record of one removal answer. */
function stateOf(result: RemovalResult, at: string): AutoRemovalState {
  if (result.removed) return { at, outcome: "removed", archive: result.archive };
  switch (result.reason) {
    case "no-legacy-tree":
      return { at, outcome: "nothing" };
    case "cohort-pending":
      return {
        at,
        outcome: "pending",
        pending: result.pending_evidence.map((d) => ({
          device: d.device,
          last_evidence: d.last_evidence,
        })),
      };
    case "not-switched":
      return {
        at,
        outcome: "refused",
        reason: "this machine is not on the brain store layout",
      };
    case "held-back":
      return {
        at,
        outcome: "refused",
        reason:
          `${result.held_back} legacy item(s) belong to the ${result.missing.join(", ")} ` +
          "partition of the brain store, which this machine does not hold",
      };
  }
}

/**
 * The waiting record while another device's records are in flight
 * (`cohortRecordsInFlight`), or null when nothing holds the removal off.
 * A store that cannot be opened is left to the removal, which says why.
 */
function recordsInFlight(
  vault: string,
  configPath: string | undefined,
): Omit<AutoRemovalState, "at"> | null {
  let store;
  try {
    store = openMigrationStore(vault, configPath);
  } catch {
    return null;
  }
  const found = cohortRecordsInFlight(vault, store, store.device);
  if (found.reasons.length === 0) return null;
  return {
    outcome: "pending",
    in_flight: true,
    pending: found.devices.map((device) => ({ device, last_evidence: null })),
    reason: found.reasons.join("; "),
  };
}

/**
 * A device that switched on a release that recorded no cut records one now
 * (`recordOwnSwitchCut`), so the other machines' removals can tell when the
 * records its migration wrote have arrived. Best effort: a store that
 * cannot be opened or written is left to the removal, which says why. The
 * check ends only on a store that holds `shared`, where the switch records
 * and the cut live: without it nothing could be read or written, and the
 * check stays open for the hourly retry until the partition arrives.
 */
function publishOwnSwitchCut(vault: string, options: RunAutoLegacyRemovalOptions, now: Date): void {
  try {
    const store = openMigrationStore(vault, options.configPath);
    if (!store.partitions.has("shared")) {
      writeOwnCutCheck(vault, { at: now.toISOString(), done: false });
      options.progress?.(
        "could not record this device's migration cut: this machine does not hold the shared " +
          "partition of the brain store yet",
      );
      return;
    }
    if (recordOwnSwitchCut(store, safeAgent(options.configPath))) {
      options.progress?.("recorded which records this device's migration wrote");
    }
    writeOwnCutCheck(vault, { at: now.toISOString(), done: true });
  } catch (err) {
    writeOwnCutCheck(vault, { at: now.toISOString(), done: false });
    options.progress?.(`could not record this device's migration cut: ${messageOf(err)}`);
  }
}

export interface RunAutoLegacyRemovalOptions {
  readonly configPath?: string;
  readonly now?: Date;
  /** One-line progress for the worker log. */
  readonly progress?: (line: string) => void;
}

/**
 * Whether a removal this machine began is unfinished: its journal names an
 * archive that still holds what it moved out of the vault. The removal is
 * then resumed, even though the vault holds no legacy root any more: the
 * final import and the completion steps are what is left of it.
 */
function unfinishedRemoval(vault: string, configPath?: string): boolean {
  try {
    const store = openMigrationStore(vault, configPath);
    const resumed = readRemovalInProgress(store);
    return resumed !== null && sameVaultPath(resumed.vault, vault);
  } catch {
    return false;
  }
}

/**
 * One automatic removal attempt in this process: under the removal lock,
 * through the same removal as `--remove-legacy` (never `--force`). This
 * device's own migration cut is published first, whatever the setting
 * says: the other devices' removals wait for it. Returns the recorded
 * state, or null when the setting is off or another worker holds the
 * lock. Never throws.
 */
export function runAutoLegacyRemoval(
  vault: string,
  options: RunAutoLegacyRemovalOptions = {},
): AutoRemovalState | null {
  const now = options.now ?? new Date();
  let enabled: boolean;
  try {
    enabled = resolveAutoLegacyRemoval(options.configPath);
    if (!takeLock(vault, now.getTime())) {
      options.progress?.("another automatic removal of the legacy tree runs; nothing to do");
      return null;
    }
  } catch (err) {
    options.progress?.(`the automatic removal could not take its lock: ${messageOf(err)}`);
    return null;
  }
  try {
    publishOwnSwitchCut(vault, options, now);
    if (!enabled) return null;
    const last = readAutoRemovalState(vault);
    const at = now.toISOString();
    writeState(vault, { ...carried(last), at, outcome: "attempt" });
    options.progress?.("removing the legacy tree from the vault, if every device has switched");
    let state: AutoRemovalState;
    // A legacy root that holds no file is what sync left when another
    // machine's removal took the files: it holds nothing to wait for or
    // archive, whatever the cohort says, and sync would carry it on.
    const emptied = removeEmptyLegacyRoots(vault);
    if (emptied.length > 0) {
      options.progress?.(`removed the empty legacy folder(s) ${emptied.join(", ")}`);
    }
    try {
      // Records another device wrote to the store that have not arrived
      // here: the tree is the only place both machines' records still
      // meet, so the removal waits, as for a device still on the legacy
      // layout (asked again at the hourly retry, never forced).
      const left = !legacyRootPresent(vault);
      const held = left ? null : recordsInFlight(vault, options.configPath);
      if (left && !unfinishedRemoval(vault, options.configPath)) {
        state = { at, outcome: "nothing" };
      } else if (held !== null) {
        state = { at, ...held };
        options.progress?.(
          `the legacy tree waits for records still in flight: ${held.reason ?? ""}`,
        );
      } else {
        const result = removeLegacy(vault, {
          ...(options.configPath !== undefined ? { configPath: options.configPath } : {}),
          now,
        });
        state = stateOf(result, at);
      }
    } catch (err) {
      state = { at, outcome: "refused", reason: messageOf(err) };
    }
    // The waiting line keeps its day; a new removal is announced anew.
    const recorded: AutoRemovalState =
      state.outcome === "removed" ? state : { ...carried(last), ...state };
    writeState(vault, recorded);
    options.progress?.(`the automatic removal of the legacy tree: ${recorded.outcome}`);
    return recorded;
  } catch (err) {
    options.progress?.(`the automatic removal failed: ${messageOf(err)}`);
    return null;
  } finally {
    try {
      releaseLock(vault);
    } catch {
      // a lock left behind is taken over once its process is gone
    }
  }
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** The local calendar day of `now`, `YYYY-MM-DD`. */
function localDay(now: Date): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function describeDevice(d: AutoRemovalPendingDevice): string {
  const seen = d.last_evidence === null ? "" : ` (last seen ${d.last_evidence.slice(0, 10)})`;
  return `${printable(d.device)}${seen}`;
}

/**
 * What a finished removal did, as a clause that follows "moved": the
 * session line says it alone, or after the migration's own news.
 */
export function removedClause(state: AutoRemovalState): string {
  return (
    "the legacy Brain/ tree out of the vault, since every device that wrote it has switched " +
    `or is retired (its archive is ${printable(reportableText(state.archive ?? ""))})`
  );
}

/** One session-start line about the legacy tree, and whether it was a waiting line. */
export interface AutoRemovalNotice {
  readonly code: "legacy_tree_removed" | "legacy_tree_waiting" | "legacy_tree_refused";
  readonly severity: "info" | "warning";
  readonly message: string;
  /** For a finished removal, {@link removedClause}; empty otherwise. */
  readonly clause: string;
}

/** The line for `state`, or null when there is nothing to say today. Pure. */
export function autoRemovalNoticeFor(
  state: AutoRemovalState,
  now: Date,
  treePresent: boolean,
): AutoRemovalNotice | null {
  if (state.outcome === "removed") {
    if (state.shown_removed === true) return null;
    return {
      code: "legacy_tree_removed",
      severity: "info",
      message: `Open Second Brain moved ${removedClause(state)}.`,
      clause: removedClause(state),
    };
  }
  if (!treePresent || state.shown_day === localDay(now)) return null;
  if (state.outcome === "pending" && state.in_flight === true) {
    const pending = state.pending ?? [];
    const one = pending.length === 1;
    const whose =
      pending.length === 0
        ? "every other machine's records have arrived on this machine"
        : `the records of ${one ? "device" : "devices"} ${pending.map(describeDevice).join(", ")} ` +
          "have arrived on this machine";
    // What holds it, bounded: a device that must update or move its store,
    // or a log that cannot be read, which more sync time never settles.
    const reason = reportableText(state.reason ?? "");
    const why =
      reason === ""
        ? ""
        : ` What holds it: ${reason.length <= 400 ? reason : `${reason.slice(0, 397)}...`}.`;
    return {
      code: "legacy_tree_waiting",
      severity: "info",
      message:
        `The legacy Brain/ tree stays in the vault until ${whose}. They travel with the ` +
        `vault's sync, in the hidden ${STORE_VAULT_DIR}/ folder; the tree leaves by itself ` +
        `once they are here.${why}`,
      clause: "",
    };
  }
  if (state.outcome === "pending" && (state.pending?.length ?? 0) > 0) {
    const pending = state.pending ?? [];
    const one = pending.length === 1;
    const devices = pending.map(describeDevice).join(", ");
    return {
      code: "legacy_tree_waiting",
      severity: "info",
      message:
        `The legacy Brain/ tree stays in the vault until ${one ? "device" : "devices"} ` +
        `${devices} ${one ? "runs" : "run"} Open Second Brain 2.0 or later: update ` +
        `${one ? "that machine" : "each of those machines"} and the tree leaves by itself (or, ` +
        "for a machine that is gone for good, run o2b store device retire <device>).",
      clause: "",
    };
  }
  if (state.outcome === "refused") {
    const reason = reportableText(state.reason ?? "");
    const clipped = reason.length <= 200 ? reason : `${reason.slice(0, 197)}...`;
    return {
      code: "legacy_tree_refused",
      severity: "warning",
      message:
        `The legacy Brain/ tree stays in the vault: ${clipped}. After that is fixed it leaves ` +
        `by itself, or run ${REMOVE_LEGACY_COMMAND}.`,
      clause: "",
    };
  }
  return null;
}

/** A session-start line and what showing it records. */
export interface PendingAutoRemovalNotice {
  readonly line: AutoRemovalNotice;
  /** Record the line as shown (today, or once for a finished removal). */
  readonly commit: () => void;
}

/**
 * The session-start line about the legacy tree, without recording it as
 * shown: the caller shows at most one line of the update a day and
 * commits only the line it shows. Null when there is nothing to say, the
 * setting is off, or anything fails.
 */
export function peekAutoRemovalNotice(
  vault: string,
  configPath: string | undefined,
  now: Date = new Date(),
): PendingAutoRemovalNotice | null {
  try {
    if (!resolveAutoLegacyRemoval(configPath)) return null;
    const state = readAutoRemovalState(vault);
    if (state === null) return null;
    const line = autoRemovalNoticeFor(state, now, legacyRootPresent(vault));
    if (line === null) return null;
    const commit = (): void => {
      try {
        writeState(
          vault,
          line.code === "legacy_tree_removed"
            ? { ...state, shown_removed: true }
            : { ...state, shown_day: localDay(now) },
        );
      } catch {
        // shown again next time rather than never
      }
    };
    return { line, commit };
  } catch {
    return null;
  }
}

/**
 * The session-start line about the legacy tree, at most one a day while it
 * stays and one after it left; reading it marks it shown. Null when there
 * is nothing to say, the setting is off, or anything fails.
 */
export function takeAutoRemovalNotice(
  vault: string,
  configPath: string | undefined,
  now: Date = new Date(),
): AutoRemovalNotice | null {
  const pending = peekAutoRemovalNotice(vault, configPath, now);
  if (pending === null) return null;
  pending.commit();
  return pending.line;
}

/** Forget the automatic removal's record of `vault` (tests and a manual removal). */
export function clearAutoRemovalState(vault: string): void {
  rmSync(statePath(vault), { force: true });
}
