/**
 * The day record of the dream session trigger (change
 * `dream-session-trigger`, design D1): one small device-local file per
 * configured store root, `<state root>/dream-trigger/<key>.json`, where
 * `<key>` is the first sixteen hex digits of the SHA-256 of the
 * configured store root. It says whether today's pass closed the day,
 * when the next attempt may start, and what this machine last learned
 * about the dream owner, so a session on a closed day reads the machine
 * config and this one file and returns.
 *
 * The record is keyed by the configured root, not by the store's
 * identity: the store's identity needs the store, and the closed-day path
 * opens nothing. It never syncs and holds no brain content: device names,
 * days, times, counts and the operation names of waiting work.
 *
 * A missing, unreadable or malformed record is unknown, never a closed
 * day: the due path decides. Every change is a read, a change and an
 * atomic write under the record's device-local lock
 * ({@link updateDreamTriggerRecord}), so a counter is always carried from
 * the record as it is under the lock.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { machineConfiguredVault, resolveVault } from "../../config.ts";
import { atomicWriteFileSync } from "../../fs-atomic.ts";
import { stateRootDir } from "../../platform-dirs.ts";
import { STORE_IDENTITY_FILE, STORE_PARTITIONS } from "../../store/constants.ts";
import { resolveStoreRoot, StoreRootInsideVaultError } from "../../store/store-paths.ts";
import type { ConfigDiscovery } from "../../types.ts";
import { isoDate } from "../time.ts";
import {
  DREAM_TRIGGER_CLAIM_SUFFIX,
  DREAM_TRIGGER_DIR,
  DREAM_TRIGGER_RECORD_VERSION,
  DREAM_TRIGGER_RETRY_CAP_MS,
  type DreamRunBy,
} from "./constants.ts";

/** How the last pass ended, as the record names it. */
export type DreamRunOutcome =
  /** Nothing behind, no gap, no answerable work left. */
  | "complete"
  /** Complete, with work waiting that nothing on this machine answers. */
  | "complete-unanswerable"
  /** The pass returned, and the day is not done. */
  | "incomplete"
  /** The pass threw (the deadline, an error). */
  | "failed"
  /** The worker ended without recording an outcome. */
  | "lost";

export interface DreamTriggerRun {
  readonly started_at: string | null;
  readonly ended_at: string | null;
  readonly outcome: DreamRunOutcome | null;
  readonly by: DreamRunBy | null;
}

export interface DreamTriggerOwner {
  readonly device: string | null;
  readonly agent: string | null;
  /** Revision (HLC) of the record the role was folded from; `null` with no owner. */
  readonly revision: string | null;
  readonly mine: boolean;
}

export interface DreamTriggerRecord {
  readonly version: number;
  readonly store_root: string;
  /** The shared setting `dream.auto` as last read; `null` before the first read. */
  readonly auto: boolean | null;
  readonly owner: DreamTriggerOwner | null;
  /** The UTC day the owner was last folded on. */
  readonly owner_checked_day: string | null;
  /** The UTC day the last pass started on. */
  readonly day: string | null;
  readonly closed: boolean;
  /** Why the day is open, or what keeps work waiting on a closed day. */
  readonly reason: string | null;
  /** On the owner's device: the work nothing here answers, and what would. */
  readonly note: string | null;
  readonly last_run: DreamTriggerRun | null;
  /** Failed or incomplete passes in a row. */
  readonly failures: number;
  /** No session starts a pass before this time. */
  readonly retry_at: string | null;
  /** When the day was first left open by this run of failures (cleared when a pass closes it). */
  readonly open_since: string | null;
  /** When the last lost worker was found. */
  readonly lost_worker_at: string | null;
  /** The one line a session shows, at most once a day. */
  readonly line: { readonly shown_day: string | null; readonly text: string | null };
}

/**
 * Whether the record keeps a check from starting a pass at `nowMs`: the
 * day is closed (a closed day ahead of the clock counts as closed, so a
 * clock set back does not start a pass at every session), or a retry
 * time is still to come (one further ahead than the longest retry delay
 * was written under a clock that was ahead, and is ignored).
 */
export function dreamDayRecordWaits(record: DreamTriggerRecord, nowMs: number): boolean {
  if (dreamDayClosed(record, isoDate(new Date(nowMs)))) return true;
  if (record.retry_at === null) return false;
  const at = Date.parse(record.retry_at);
  return at > nowMs && at - nowMs <= DREAM_TRIGGER_RETRY_CAP_MS;
}

/**
 * Whether the record closes `today` (a UTC day): the day it closed is
 * today, or ahead of the clock (a clock set back does not reopen it). The
 * one rule the check, the due path and the status share.
 */
export function dreamDayClosed(record: DreamTriggerRecord, today: string): boolean {
  return record.closed && record.day !== null && record.day >= today;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Whether `day` is a real UTC calendar day written `YYYY-MM-DD`. */
export function isUtcDay(day: string): boolean {
  if (!DAY_RE.test(day)) return false;
  const ms = Date.parse(`${day}T00:00:00.000Z`);
  return Number.isFinite(ms) && isoDate(new Date(ms)) === day;
}

/** A record with nothing learned yet, for `storeRoot`. */
export function emptyDreamTriggerRecord(storeRoot: string): DreamTriggerRecord {
  return {
    version: DREAM_TRIGGER_RECORD_VERSION,
    store_root: storeRoot,
    auto: null,
    owner: null,
    owner_checked_day: null,
    day: null,
    closed: false,
    reason: null,
    note: null,
    last_run: null,
    failures: 0,
    retry_at: null,
    open_since: null,
    lost_worker_at: null,
    line: { shown_day: null, text: null },
  };
}

/**
 * The store root `config` names, resolved as every store opener on this
 * machine resolves it (`resolveConfiguredStoreRoot`, `o2b store path`, the
 * hooks): the environment, then `store_root`, then the default, which
 * with a configured vault is the vault's reserved store folder (since
 * 2.0.1). From the loaded config: the file is not read again. A root the
 * store refuses because it sits inside the vault is kept as written, so
 * the due path opens it and names the refusal, as before.
 */
export function configuredTriggerStoreRoot(
  config: ConfigDiscovery,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  // Every call pays the vault lookup: a pointer walk up the working folder and a profiles read.
  return triggerStoreRoot(config, env, resolveVault(config.path, { discovery: config }));
}

/**
 * The root Open Second Brain 2.0.5 and earlier keyed the record by: the
 * configured root resolved as if no vault were configured. It differs
 * from {@link configuredTriggerStoreRoot} only on a machine with a vault
 * whose store sits at the default root, the vault's folder.
 */
function legacyTriggerStoreRoot(
  config: ConfigDiscovery,
  env: Readonly<Record<string, string | undefined>>,
): string {
  return triggerStoreRoot(config, env, null);
}

function triggerStoreRoot(
  config: ConfigDiscovery,
  env: Readonly<Record<string, string | undefined>>,
  vault: string | null,
): string {
  try {
    return resolveStoreRoot({
      platform: process.platform,
      home: homedir(),
      env,
      config: config.data,
      configPath: config.path,
      vault,
    }).root;
  } catch (err) {
    if (err instanceof StoreRootInsideVaultError) return err.root;
    throw err;
  }
}

/** Where this machine's trigger state lives: the configured store root and its record. */
export interface DreamTriggerLocation {
  readonly storeRoot: string;
  readonly recordPath: string;
}

/**
 * The trigger's store root and record for `config`, with the record a
 * 2.0.5 or earlier install left under the old key carried over first
 * ({@link adoptLegacyDreamTriggerRecord}). Costs one `stat` when the
 * record is there.
 */
export function dreamTriggerLocation(
  config: ConfigDiscovery,
  env: Readonly<Record<string, string | undefined>> = process.env,
): DreamTriggerLocation {
  const storeRoot = configuredTriggerStoreRoot(config, env);
  const recordPath = dreamTriggerRecordPath(storeRoot, env);
  if (!existsSync(recordPath)) adoptLegacyDreamTriggerRecord(config, env, storeRoot, recordPath);
  return { storeRoot, recordPath };
}

/**
 * Carry the record of the old key over to `recordPath`, once. Open Second
 * Brain 2.0.5 and earlier keyed the record by the root resolved with no
 * vault, so on a machine whose store is in the vault a pass run by hand
 * wrote its day, failures and retry time under the key of a root that
 * holds no store. With no record under the right key, that record is
 * written there (its `store_root` set to the right root, everything else
 * as it was: a day closed stays closed, `retry_at` and the failure count
 * hold) under the record's lock, and the old file is removed, so it is
 * carried at most once.
 *
 * Only into the root the machine configuration itself resolves (its
 * active profile or its `vault` key): the old record is the machine's,
 * and a session whose vault came from `VAULT_DIR` or a project pointer
 * would move it to that vault's key, leaving the configured vault with no
 * record and a second pass for a day already closed. Not while the old
 * key's claim file stands: a pass of the earlier version may still run
 * and write the old record when it ends, so both files are left, and the
 * next look after the claim is gone carries the record as that pass left
 * it. The read, the write and the removal hold the old path's lock, so of
 * two callers at once (two configured roots across a profile switch) one
 * carries the record and the other finds none.
 *
 * A record already under the right key wins: the old file is then never
 * read. An old file that is not a record of the old root is left alone
 * the same way. Never throws: with nothing carried over, the due path
 * decides.
 */
export function adoptLegacyDreamTriggerRecord(
  config: ConfigDiscovery,
  env: Readonly<Record<string, string | undefined>>,
  storeRoot: string,
  recordPath: string,
): void {
  try {
    const legacyRoot = legacyTriggerStoreRoot(config, env);
    if (legacyRoot === storeRoot) return;
    const legacyPath = dreamTriggerRecordPath(legacyRoot, env);
    // One `stat` on the common path: nothing under the old key.
    if (!existsSync(legacyPath)) return;
    if (triggerStoreRoot(config, env, machineConfiguredVault(config)) !== storeRoot) return;
    if (existsSync(dreamTriggerClaimPath(legacyPath))) return;
    const { withLocalLock } = require("../../store/local-lock.ts") as LocalLockModule;
    withLocalLock(legacyPath, () => {
      const legacy = readDreamTriggerRecord(legacyPath, legacyRoot);
      if (legacy === null) return;
      updateDreamTriggerRecord(recordPath, storeRoot, () =>
        existsSync(recordPath) ? null : { ...legacy, store_root: storeRoot },
      );
      rmSync(legacyPath, { force: true });
    });
  } catch {
    // Left for the next look; the due path decides meanwhile.
  }
}

/** The key of a configured store root. */
export function dreamTriggerKey(storeRoot: string): string {
  return createHash("sha256").update(storeRoot).digest("hex").slice(0, 16);
}

/**
 * Where the record of `storeRoot` lives on this machine: under the state
 * root the environment `env` names, the same environment the store root
 * was resolved from and the one the store's own device-local state
 * (`store-paths.ts` `storesStateDir`) is resolved from for that caller, so
 * a caller whose environment names another state root never reads or
 * writes this machine's default one.
 */
export function dreamTriggerRecordPath(
  storeRoot: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const root = stateRootDir({ platform: process.platform, home: homedir(), env });
  return join(root, DREAM_TRIGGER_DIR, `${dreamTriggerKey(storeRoot)}.json`);
}

/**
 * Whether a store exists at `storeRoot`: a partition holds its identity
 * file (at most one look per partition; nothing is read). The
 * trigger keeps no state for a store root that holds no store: there is
 * no pass to start or record, and its device-local state would land
 * beside a store that does not exist.
 */
export function dreamTriggerStoreExists(storeRoot: string): boolean {
  return STORE_PARTITIONS.some((p) => existsSync(join(storeRoot, p, STORE_IDENTITY_FILE)));
}

/** The claim file beside a record. */
export function dreamTriggerClaimPath(recordPath: string): string {
  return `${recordPath}${DREAM_TRIGGER_CLAIM_SUFFIX}`;
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function parseRun(v: unknown): DreamTriggerRun | null {
  if (v === null || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  return {
    started_at: str(r["started_at"]),
    ended_at: str(r["ended_at"]),
    outcome: str(r["outcome"]) as DreamRunOutcome | null,
    by: str(r["by"]) as DreamRunBy | null,
  };
}

function parseOwner(v: unknown): DreamTriggerOwner | null {
  if (v === null || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o["mine"] !== "boolean") return null;
  return {
    device: str(o["device"]),
    agent: str(o["agent"]),
    revision: str(o["revision"]),
    mine: o["mine"],
  };
}

/** A record from its text, or `null` when it is not one. */
export function parseDreamTriggerRecord(text: string): DreamTriggerRecord | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  if (r["version"] !== DREAM_TRIGGER_RECORD_VERSION) return null;
  if (typeof r["store_root"] !== "string" || typeof r["closed"] !== "boolean") return null;
  // A closed day is trusted against the clock: a day that is not a real
  // calendar day would close every day to come.
  if (r["day"] !== undefined && r["day"] !== null) {
    if (typeof r["day"] !== "string" || !isUtcDay(r["day"])) return null;
  }
  const failures = r["failures"];
  if (typeof failures !== "number" || !Number.isInteger(failures) || failures < 0) return null;
  const line = (r["line"] ?? {}) as Record<string, unknown>;
  return {
    version: DREAM_TRIGGER_RECORD_VERSION,
    store_root: r["store_root"],
    auto: typeof r["auto"] === "boolean" ? r["auto"] : null,
    owner: parseOwner(r["owner"]),
    owner_checked_day: str(r["owner_checked_day"]),
    day: str(r["day"]),
    closed: r["closed"],
    reason: str(r["reason"]),
    note: str(r["note"]),
    last_run: parseRun(r["last_run"]),
    failures,
    retry_at: str(r["retry_at"]),
    open_since: str(r["open_since"]),
    lost_worker_at: str(r["lost_worker_at"]),
    line: { shown_day: str(line["shown_day"]), text: str(line["text"]) },
  };
}

/**
 * The record at `path`: `null` when it is missing, unreadable or not a
 * record of `storeRoot` (unknown: the due path decides). One file read.
 */
export function readDreamTriggerRecord(path: string, storeRoot: string): DreamTriggerRecord | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const record = parseDreamTriggerRecord(text);
  return record !== null && record.store_root === storeRoot ? record : null;
}

/** Write `record` at `path` atomically (its folder is created). */
export function writeDreamTriggerRecord(path: string, record: DreamTriggerRecord): void {
  atomicWriteFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
}

type LocalLockModule = typeof import("../../store/local-lock.ts");

/**
 * Change the record of `storeRoot` at `path` under its device-local lock:
 * `change` gets the record as it is now (an empty one when unknown) and
 * returns the record to write, or `null` to write nothing. Returns what
 * was written, or `null`.
 */
export function updateDreamTriggerRecord(
  path: string,
  storeRoot: string,
  change: (current: DreamTriggerRecord) => DreamTriggerRecord | null,
): DreamTriggerRecord | null {
  // Loaded here: the closed-day path never writes and must not pay for
  // the lock modules.
  const { withLocalLock } = require("../../store/local-lock.ts") as LocalLockModule;
  return withLocalLock(path, () => {
    const current = readDreamTriggerRecord(path, storeRoot) ?? emptyDreamTriggerRecord(storeRoot);
    const next = change(current);
    if (next === null) return null;
    writeDreamTriggerRecord(path, next);
    return next;
  });
}

/**
 * The record's line, when it has not been shown today: marked shown under
 * the record lock, so two sessions of one day show it once.
 */
export function showLineOnce(
  recordPath: string,
  storeRoot: string,
  today: string,
): DreamDayLineShown | undefined {
  let shown: DreamDayLineShown | undefined;
  updateDreamTriggerRecord(recordPath, storeRoot, (r) => {
    if (r.line.text === null || r.line.shown_day === today) return null;
    shown = { text: r.line.text, unshow: unshowLine(recordPath, storeRoot, today, r.line) };
    return { ...r, line: { text: r.line.text, shown_day: today } };
  });
  return shown;
}

/** A line marked shown today, with the way to take that back. */
export interface DreamDayLineShown {
  readonly text: string;
  /**
   * Mark the line not shown again, for a caller that could not deliver it
   * (a session start whose room was too small): put back the day it was
   * last shown, unless the record changed since. Never throws.
   */
  readonly unshow: () => void;
}

/** The take-back of a line marked shown on `today`, from what it was before (`previous`). */
export function unshowLine(
  recordPath: string,
  storeRoot: string,
  today: string,
  previous: DreamTriggerRecord["line"],
): () => void {
  return () => {
    try {
      updateDreamTriggerRecord(recordPath, storeRoot, (r) =>
        r.line.shown_day === today && r.line.text === previous.text
          ? { ...r, line: { text: r.line.text, shown_day: previous.shown_day } }
          : null,
      );
    } catch {
      // The line waits for tomorrow's session, as before.
    }
  };
}
