/**
 * How far a rebuild of the search index has got, for the readers that
 * answer while it runs.
 *
 * A rebuild (`reindexVault`) builds a staging file beside the index and
 * swaps it in at the end. On a machine that has just moved its brain into
 * the brain store there is no index before that swap at all, and the
 * build of a large store takes minutes. The rebuild records its progress
 * in a small JSON file beside the index (`<index>.building.json`,
 * device-local like the index itself), so that:
 *
 *  - a search can answer from the staging file, saying how far it is
 *    (`pipeline/store-open.ts`), instead of failing with INDEX_MISSING;
 *  - the session notice and the error text say what is true: the index is
 *    being built, how far it got, and about when it ends.
 *
 * The file is information, never a lock: whether a build runs is what the
 * writer lock on the index path says (a SIGKILLed build leaves the file
 * behind with a stale lock, and reads as not building). Writes are best
 * effort and throttled; a reader that cannot parse the file sees no build.
 */

import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { atomicWriteFileSync, unlinkWithRetry } from "../fs-atomic.ts";
import { SearchError } from "./search-error.ts";
import { STORE_BUILD_PROGRESS_SUFFIX, STORE_BUILD_READER_PREFIX } from "./store-family.ts";
import { isWriterLockHeld } from "./store/writer-lock.ts";

/** Suffix of the staging file a rebuild builds before the swap. */
export const STAGING_INDEX_SUFFIX = ".new";

/** Least time between two writes of the progress file. */
const WRITE_INTERVAL_MS = 1000;

/** Least time into the brain store phase before an end time is estimated. */
const ESTIMATE_AFTER_MS = 5000;

/** The staging file of the index at `dbPath`. */
export function stagingIndexPath(dbPath: string): string {
  return dbPath + STAGING_INDEX_SUFFIX;
}

/** The progress file of the index at `dbPath`. */
export function buildProgressPath(dbPath: string): string {
  return dbPath + STORE_BUILD_PROGRESS_SUFFIX;
}

/** What a running rebuild last recorded. */
export interface IndexBuildProgress {
  /** The process that runs the rebuild. */
  readonly pid: number;
  /**
   * A random token of this rebuild: with `pid`, the owner of the record.
   * A rebuild that lost its writer lease to another one never overwrites
   * or removes the other's record (`IndexBuildRecorder`).
   */
  readonly token: string;
  /** ISO instant the rebuild took the writer lock. */
  readonly startedAt: string;
  /**
   * `preparing`: the rebuild has not yet accepted or recreated its
   * staging file (one an interrupted build left may be abandoned or hold
   * records forgotten since), so no reader may open it; `notes`:
   * indexing the vault's notes; `store`: ingesting the brain store;
   * `finishing`: the staging file is being swapped in, and no new reader
   * may open it.
   */
  readonly phase: BuildPhase;
  /** ISO instant the brain store phase began, or null before it. */
  readonly storeStartedAt: string | null;
  /** Bytes of brain store shards read so far, and in all. */
  readonly storeBytesDone: number;
  readonly storeBytesTotal: number;
  /** Brain store records indexed so far. */
  readonly storeRecords: number;
}

/** The phases of a rebuild ({@link IndexBuildProgress.phase}). */
export type BuildPhase = "preparing" | "notes" | "store" | "finishing";

const BUILD_PHASES: ReadonlySet<string> = new Set(["preparing", "notes", "store", "finishing"]);

/** Whether a search may open the staging file in `phase`. */
export function stagingReadable(phase: BuildPhase): boolean {
  return phase === "notes" || phase === "store";
}

function count(x: unknown): number {
  return typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : 0;
}

function parseProgress(raw: string): IndexBuildProgress | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v["startedAt"] !== "string" || !Number.isFinite(Date.parse(v["startedAt"])))
    return null;
  const pid = v["pid"];
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;
  const token = v["token"];
  if (typeof token !== "string" || token === "") return null;
  return {
    pid,
    token,
    startedAt: v["startedAt"],
    // A phase this build does not know is the safe one: no staging read.
    phase:
      typeof v["phase"] === "string" && BUILD_PHASES.has(v["phase"])
        ? (v["phase"] as BuildPhase)
        : "preparing",
    storeStartedAt: typeof v["storeStartedAt"] === "string" ? v["storeStartedAt"] : null,
    storeBytesDone: count(v["storeBytesDone"]),
    storeBytesTotal: count(v["storeBytesTotal"]),
    storeRecords: count(v["storeRecords"]),
  };
}

/** Whether process `pid` of this machine is alive (EPERM: alive, another user's). */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as { code?: unknown } | null)?.code === "EPERM";
  }
}

/**
 * The progress of the rebuild running on the index at `dbPath`, or null
 * when none runs or it recorded nothing readable. A rebuild runs while the
 * writer lock is live and the process that wrote the file is alive: a file
 * a killed rebuild left behind is no build, also while another writer
 * holds the lock. Never throws.
 */
export function readIndexBuild(dbPath: string): IndexBuildProgress | null {
  try {
    if (!isWriterLockHeld(dbPath)) return null;
    const progress = parseProgress(readFileSync(buildProgressPath(dbPath), "utf8"));
    return progress !== null && processAlive(progress.pid) ? progress : null;
  } catch {
    return null;
  }
}

/** Records a rebuild's progress; every method is best effort and never throws. */
export class IndexBuildRecorder {
  private readonly startedAt: string;
  private storeStartedAt: string | null = null;
  private bytesDone = 0;
  private bytesTotal = 0;
  private records = 0;
  private finishing = false;
  /** False until the rebuild accepted or recreated its staging file ({@link ready}). */
  private prepared = false;
  /** Whether a record of this recorder has reached the disk at least once. */
  private published = false;
  private lastWriteMs = Number.NEGATIVE_INFINITY;
  /** This rebuild's half of the record's owner identity (with the pid). */
  private readonly token = randomBytes(8).toString("hex");
  /** Another rebuild published its own record over this one's: this recorder writes and removes nothing more. */
  private displaced = false;

  /**
   * @param leaseHeld Whether this rebuild still holds the writer lease on
   *   the index, asked before every publish and removal: a rebuild whose
   *   lease another one took over publishes and removes nothing more,
   *   also when the file is absent (a successor that ended removed it).
   *   Absent, the progress file alone decides.
   */
  constructor(
    private readonly dbPath: string,
    private readonly now: () => number = Date.now,
    private readonly leaseHeld: () => boolean = () => true,
  ) {
    this.startedAt = new Date(this.now()).toISOString();
    // The first record (phase `preparing`) is this rebuild's to publish:
    // it holds the writer lease. It replaces a record a dead build left,
    // and a write that fails is retried by the next one (`stillOwns`).
    this.write(this.now());
  }

  /**
   * The staging file is this build's now (accepted for a resume, with what
   * the store forgot since taken out, or created afresh): searches may
   * read it from here on. Returns whether that was published.
   */
  ready(): boolean {
    this.prepared = true;
    return this.write(this.now());
  }

  /**
   * Who owns the record on disk: `own`, `other` (another rebuild's
   * pid and token, or one this process cannot read as a record), or
   * `none` when there is no file.
   */
  private owner(): "own" | "other" | "none" {
    let raw: string;
    try {
      raw = readFileSync(buildProgressPath(this.dbPath), "utf8");
    } catch (e) {
      return (e as { code?: unknown } | null)?.code === "ENOENT" ? "none" : "other";
    }
    const record = parseProgress(raw);
    return record !== null && record.pid === process.pid && record.token === this.token
      ? "own"
      : "other";
  }

  /** Whether the record on disk is still this recorder's to write or remove. */
  private stillOwns(): boolean {
    if (this.displaced) return false;
    // Displacement is for good: once the lease is gone or another record
    // was seen, an absent file is no longer this recorder's to fill.
    if (!this.leaseHeld()) {
      this.displaced = true;
      return false;
    }
    // Holding the lease and never published: a record on disk is a dead
    // build's (or none), and the first publication is still owed.
    if (!this.published) return true;
    if (this.owner() === "other") this.displaced = true;
    return !this.displaced;
  }

  /**
   * The brain store phase moved: `bytesDone` of `bytesTotal` read,
   * `records` indexed. Called once per record; it writes at most once a
   * second.
   */
  store(bytesDone: number, bytesTotal: number, records: number): void {
    this.bytesDone = bytesDone;
    this.bytesTotal = bytesTotal;
    this.records = records;
    const now = this.now();
    if (this.storeStartedAt === null) {
      this.storeStartedAt = new Date(now).toISOString();
      this.write(now);
    } else if (now - this.lastWriteMs >= WRITE_INTERVAL_MS) {
      this.write(now);
    }
  }

  /**
   * The build is complete and the swap begins: from the moment this is
   * written no search opens the staging file (`enterStagingRead`). When
   * the phase cannot be written, the file is removed instead, which keeps
   * searches off the staging file just as well (no build is seen). Returns
   * false when neither could be done: the barrier does not hold, and the
   * caller must not swap.
   */
  finish(): boolean {
    this.finishing = true;
    if (this.write(this.now())) return true;
    // Another rebuild's record is not this one's barrier to take down.
    if (!this.stillOwns()) return false;
    try {
      unlinkSync(buildProgressPath(this.dbPath));
      return true;
    } catch (e) {
      return (e as { code?: unknown } | null)?.code === "ENOENT";
    }
  }

  /**
   * The rebuild ended, swapped in or not: its record goes, but only while
   * it is still its own. A rebuild that lost its lease to another one
   * leaves the other's record, so searches and notices keep seeing the
   * build that runs.
   */
  end(): void {
    if (!this.stillOwns()) return;
    try {
      unlinkSync(buildProgressPath(this.dbPath));
    } catch {
      // absent already, or held by a scanner on Windows: a stale file reads as no build
    }
  }

  /** A progress write: never over another rebuild's record. */
  private write(now: number): boolean {
    if (!this.stillOwns()) return false;
    const ok = this.publish(now);
    if (ok) this.published = true;
    return ok;
  }

  private publish(now: number): boolean {
    this.lastWriteMs = now;
    const state: IndexBuildProgress = {
      pid: process.pid,
      token: this.token,
      startedAt: this.startedAt,
      phase: this.finishing
        ? "finishing"
        : !this.prepared
          ? "preparing"
          : this.storeStartedAt === null
            ? "notes"
            : "store",
      storeStartedAt: this.storeStartedAt,
      storeBytesDone: this.bytesDone,
      storeBytesTotal: this.bytesTotal,
      storeRecords: this.records,
    };
    try {
      atomicWriteFileSync(buildProgressPath(this.dbPath), JSON.stringify(state));
      return true;
    } catch {
      // progress is information only, but for the barrier ({@link finish})
      return false;
    }
  }
}

/** A search's claim on the staging file, held while it reads it. */
export interface StagingReadTicket {
  /** The search closed the file: the claim goes. Idempotent; never throws. */
  release(): void;
}

function readerFilePrefix(dbPath: string): string {
  return basename(dbPath) + STORE_BUILD_READER_PREFIX;
}

/**
 * Announce a read of the staging file of the rebuild running on the index
 * at `dbPath`, or null when it may not be read: no build runs, or the
 * build is finishing. The claim is written BEFORE the build's state is
 * read again, and the build marks itself finishing BEFORE it looks for
 * claims (`waitForStagingReaders`), so either this read sees the
 * finishing build and stays away, or the build sees this claim and waits
 * for its release: no read holds the file while it is renamed.
 */
export function enterStagingRead(dbPath: string): StagingReadTicket | null {
  const path = join(
    dirname(dbPath),
    `${readerFilePrefix(dbPath)}${process.pid}-${randomBytes(4).toString("hex")}`,
  );
  try {
    writeFileSync(path, String(process.pid), { flag: "wx" });
  } catch {
    return null;
  }
  let released = false;
  const ticket: StagingReadTicket = {
    release: () => {
      if (released) return;
      try {
        // A sharing violation on Windows is ridden out (a bounded retry);
        // a claim already gone is released.
        unlinkWithRetry(path);
        released = true;
      } catch (e) {
        if ((e as { code?: unknown } | null)?.code === "ENOENT") released = true;
        // Otherwise the claim stays and stays retryable: the next release
        // call tries again, and a build waits on it only until its budget.
      }
    },
  };
  const build = readIndexBuild(dbPath);
  if (build === null || !stagingReadable(build.phase)) {
    ticket.release();
    return null;
  }
  return ticket;
}

/**
 * The claim files on the staging file of `dbPath`, each with the pid
 * that took it, or null when the directory could not be read: an unknown
 * list, never an empty one.
 */
function stagingClaims(
  dbPath: string,
): Array<{ readonly path: string; readonly pid: number }> | null {
  const prefix = readerFilePrefix(dbPath);
  let names: string[];
  try {
    names = readdirSync(dirname(dbPath));
  } catch {
    return null;
  }
  const claims: Array<{ readonly path: string; readonly pid: number }> = [];
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const pid = Number(name.slice(prefix.length).split("-")[0]);
    if (Number.isInteger(pid) && pid > 0) claims.push({ path: join(dirname(dbPath), name), pid });
  }
  return claims;
}

/** The pids of the live readers holding a claim on the staging file of `dbPath`; null when unknown. */
function liveStagingReaders(dbPath: string): number[] | null {
  const claims = stagingClaims(dbPath);
  if (claims === null) return null;
  return claims.map((c) => c.pid).filter((pid) => processAlive(pid));
}

/**
 * Remove the claims a search that died while reading left behind: called
 * when a build starts, so a claim of a dead process never outlives the
 * next build. Best effort.
 */
export function sweepStagingClaims(dbPath: string): void {
  for (const claim of stagingClaims(dbPath) ?? []) {
    if (processAlive(claim.pid)) continue;
    try {
      unlinkSync(claim.path);
    } catch {
      // gone already, or held: the next build tries again
    }
  }
}

/**
 * How a wait for the staging file's readers ended: `drained` (no live
 * claim), `readers` (live claims outstayed the budget), or `unknown`
 * (the claims could not be listed until the budget ran out: not drained).
 */
export type StagingDrain = "drained" | "readers" | "unknown";

/**
 * Wait, at most `budgetMs`, until no live search holds a claim on the
 * staging file of `dbPath`. Called after {@link IndexBuildRecorder.finish},
 * so no new claim can be taken while it waits; a search holds its claim
 * for one query. A claim list that cannot be read is retried within the
 * budget and never taken for an empty one.
 */
export async function waitForStagingReaders(
  dbPath: string,
  budgetMs: number,
  now: () => number = Date.now,
): Promise<StagingDrain> {
  const deadline = now() + budgetMs;
  for (;;) {
    const live = liveStagingReaders(dbPath);
    if (live !== null && live.length === 0) return "drained";
    if (now() >= deadline) return live === null ? "unknown" : "readers";
    // eslint-disable-next-line no-await-in-loop
    await Bun.sleep(25);
  }
}

function minutes(ms: number): string {
  const m = Math.round(ms / 60_000);
  return m < 1 ? "less than a minute" : m === 1 ? "about 1 minute" : `about ${m} minutes`;
}

/**
 * How far the build is, as the inside of a parenthesis: "started about 2
 * minutes ago; 40% of the brain store read, 151,000 records indexed;
 * about 3 minutes to go".
 */
export function indexBuildDetails(p: IndexBuildProgress, nowMs: number = Date.now()): string {
  const started = `started ${minutes(Math.max(0, nowMs - Date.parse(p.startedAt)))} ago`;
  if (p.phase === "finishing") return `${started}; built, being swapped in`;
  if (p.phase === "preparing") return `${started}; preparing its staging index`;
  if (p.phase !== "store" || p.storeBytesTotal <= 0) {
    return `${started}; indexing the vault's notes, the brain store comes next`;
  }
  const fraction = Math.min(1, p.storeBytesDone / p.storeBytesTotal);
  const percent = Math.floor(fraction * 100);
  const records = p.storeRecords.toLocaleString("en-US");
  const parts = [started, `${percent}% of the brain store read, ${records} records indexed`];
  const storeMs = p.storeStartedAt === null ? 0 : nowMs - Date.parse(p.storeStartedAt);
  if (fraction > 0 && fraction < 1 && storeMs >= ESTIMATE_AFTER_MS) {
    parts.push(`${minutes((storeMs * (1 - fraction)) / fraction)} to go`);
  }
  return parts.join("; ");
}

/** One clause naming the build and how far it is, in lower case. */
export function describeIndexBuild(p: IndexBuildProgress, nowMs: number = Date.now()): string {
  return `the search index is being built (${indexBuildDetails(p, nowMs)})`;
}

/**
 * The refusal a read gets while the index is being built and nothing can
 * answer yet (the staging file is not readable for the first moments of a
 * build). INDEX_MISSING by code, so every caller that handles a missing
 * index still does; the message says what is true instead of naming a
 * command that would only queue behind the running build.
 */
export class IndexBuildingError extends SearchError {
  constructor(dbPath: string, progress: IndexBuildProgress) {
    super(
      "INDEX_MISSING",
      `${describeIndexBuild(progress)} at ${dbPath}; it answers as soon as the build has indexed its first files: try again in a moment`,
    );
    this.name = "IndexBuildingError";
  }
}
