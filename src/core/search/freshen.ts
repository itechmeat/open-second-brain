/**
 * Freshen on read (index-freshness design): a reader that finds the search
 * index older than `search_freshen_interval_s` answers from the index it has
 * and starts ONE detached, low-priority incremental index run, so the next
 * read sees the current vault. Nothing stays resident: the only triggers are
 * reads (`search()`) and session start (`ensureVaultCurrent`), both of which
 * only happen while an agent works.
 *
 * Everything here is per device and lives next to the index
 * (`<dirname(dbPath)>/`), never in `Brain/`: the claim that keeps concurrent
 * readers from starting a run each, and the state file the child writes its
 * outcome and backoff to.
 *
 * `maybeFreshenIndex` never throws and never waits for the run: a reader
 * of a fresh index pays nothing; a due one pays one state-file read, one
 * lock probe and one exclusive create.
 */
import { randomUUID } from "node:crypto";
import { linkSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { appendMetric } from "../brain/metrics.ts";
import { atomicWriteFileSync } from "../fs-atomic.ts";
import { o2bCommand } from "../maintenance/o2b-command.ts";
import { isWriterLockHeld } from "./store/writer-lock.ts";
import type { ResolvedSearchConfig } from "./types.ts";

/** The claim a reader takes before it starts a run; the child releases it. */
export const FRESHEN_CLAIM_FILE = "freshen.claim";

/** The child's outcome, failure streak and backoff. */
export const FRESHEN_STATE_FILE = "freshen-state.json";

/**
 * The pending-write marker a forced refresh claim leaves when a run is
 * already in flight (`freshen-pending.json`, beside the state file) -
 * the claim held, or the index writer lock probed held, which is the
 * same run mid-pass. The claim's exclusivity means exactly one run is in flight, and
 * that run may have scanned past the write before it landed - its stamp
 * cannot prove it saw the write, and until the next interval its
 * freshness suppresses freshen-on-read. The marker is the queue: the
 * child reads it before releasing the claim and runs one bounded extra
 * incremental pass when the marker is newer than its scan start. See
 * {@link settleFreshenPending}.
 */
export const FRESHEN_PENDING_FILE = "freshen-pending.json";

/** A write waiting for a pass that can provably cover it. */
export interface FreshenPending {
  /** Milliseconds since the epoch: when the pending write landed. */
  readonly since: number;
}

/**
 * Metrics surface for background runs. A row is written only when a run
 * changed the index or failed: an idle machine would otherwise append one
 * row a minute to a synced file for nothing.
 */
export const INDEX_FRESHEN_SURFACE = "index_freshen";

/** A claim older than this belongs to a run that died; it is taken over. */
export const FRESHEN_CLAIM_ABANDONED_MS = 10 * 60 * 1000;

const BACKOFF_BASE_MS = 60_000;
const BACKOFF_CAP_MS = 3_600_000;

/** Why a reader did not start a run. */
export const FRESHEN_SKIP = Object.freeze({
  off: "off",
  noIndex: "no_index",
  fresh: "fresh",
  backoff: "backoff",
  readOnly: "read_only",
  writerLock: "writer_lock",
  claimed: "claimed",
  /** The index directory refused the claim (read-only mount, no permission). */
  unwritable: "unwritable",
  spawnFailed: "spawn_failed",
} as const);

export type FreshenSkip = (typeof FRESHEN_SKIP)[keyof typeof FRESHEN_SKIP];

/** What a reader did: started a run, or the reason it did not. */
export type FreshenDecision = "spawned" | FreshenSkip;

export interface FreshenState {
  readonly failures: number;
  readonly backoffUntil: string | null;
  readonly lastOutcome: "completed" | "failed" | null;
  readonly lastRunAt: string | null;
  readonly lastDurationMs: number | null;
  readonly lastError: string | null;
  /** Documents the last completed run added, updated or deleted. */
  readonly lastChanged: number | null;
}

export const EMPTY_FRESHEN_STATE: FreshenState = Object.freeze({
  failures: 0,
  backoffUntil: null,
  lastOutcome: null,
  lastRunAt: null,
  lastDurationMs: null,
  lastError: null,
  lastChanged: null,
});

export interface DecideFreshenInput {
  readonly nowMs: number;
  readonly lastIndexedAt: string | null;
  readonly intervalSeconds: number;
  readonly backoffUntilMs: number | null;
}

/**
 * Whether a read should start a run. Pure. An index that was never
 * stamped belongs to self-heal (a missing or unbuilt index is rebuilt
 * there); an unparseable stamp is treated as due, since claiming it fresh
 * would leave the index stale forever. Freshness is decided before the
 * backoff, so a reader can skip the state file while the index is fresh.
 */
export function decideFreshen(
  input: DecideFreshenInput,
): { readonly action: "spawn" } | { readonly action: "skip"; readonly reason: FreshenSkip } {
  if (input.intervalSeconds <= 0) return { action: "skip", reason: FRESHEN_SKIP.off };
  if (input.lastIndexedAt === null) return { action: "skip", reason: FRESHEN_SKIP.noIndex };
  const indexedMs = Date.parse(input.lastIndexedAt);
  if (Number.isFinite(indexedMs) && input.nowMs - indexedMs < input.intervalSeconds * 1000) {
    return { action: "skip", reason: FRESHEN_SKIP.fresh };
  }
  if (input.backoffUntilMs !== null && input.backoffUntilMs > input.nowMs) {
    return { action: "skip", reason: FRESHEN_SKIP.backoff };
  }
  return { action: "spawn" };
}

/** Seconds since `lastIndexedAt`, or null when it is absent or unparseable. */
export function indexAgeSeconds(lastIndexedAt: string | null, nowMs: number): number | null {
  if (lastIndexedAt === null) return null;
  const ms = Date.parse(lastIndexedAt);
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.floor((nowMs - ms) / 1000));
}

/** Backoff after the `failures`-th failure in a row: 1 min doubling to 1 h. */
export function nextBackoffMs(failures: number): number {
  const n = Math.max(1, failures);
  return Math.min(BACKOFF_BASE_MS * 2 ** (n - 1), BACKOFF_CAP_MS);
}

/**
 * A claim file that cannot be parsed is normally one being written: the
 * exclusive create and the write are two steps. Only past this grace is a
 * torn claim taken for a dead run's.
 */
const CLAIM_TORN_GRACE_MS = 10_000;

/** A takeover lock older than this belongs to a reader that died mid-takeover. */
const TAKEOVER_STALE_MS = 30_000;

/** A claim taken, or why it was not. */
export type FreshenClaim =
  | { readonly token: string }
  | { readonly skip: typeof FRESHEN_SKIP.claimed | typeof FRESHEN_SKIP.unwritable };

/**
 * Take the claim, or return null when a live run holds it or the index
 * directory refuses it. {@link tryClaimFreshen} tells the two apart.
 */
export function claimFreshen(dir: string, nowMs: number): string | null {
  const claim = tryClaimFreshen(dir, nowMs);
  return "token" in claim ? claim.token : null;
}

/**
 * Take the claim. The claim is an exclusive create, so of N readers racing
 * on a stale index exactly one wins; a create that fails for any reason
 * other than an existing claim (EROFS, EACCES) is reported as unwritable,
 * since no reader there can ever start a run. A claim older than
 * {@link FRESHEN_CLAIM_ABANDONED_MS} (or torn and older than
 * {@link CLAIM_TORN_GRACE_MS}) is a run that died (a reboot, an OOM kill)
 * and is taken over - but only by the reader holding the exclusive
 * takeover lock, which re-reads the claim under it and replaces it with an
 * atomic rename, so the slot is never empty and a fresh claim is never
 * touched.
 */
export function tryClaimFreshen(dir: string, nowMs: number): FreshenClaim {
  const path = join(dir, FRESHEN_CLAIM_FILE);
  const token = `fr-${randomUUID()}`;
  const body = JSON.stringify({ token, at: nowMs });
  const claimed = { skip: FRESHEN_SKIP.claimed } as const;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, body, { flag: "wx" });
      return { token };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") {
        return { skip: FRESHEN_SKIP.unwritable };
      }
    }
    const seen = readClaimBody(path);
    if (seen === null) continue; // released since: race the create again
    if (!claimAbandoned(path, seen, nowMs)) return claimed;
    const taken = takeOver(path, token, body, nowMs);
    return taken === null ? claimed : { token: taken };
  }
  return claimed;
}

function takeOver(path: string, token: string, body: string, nowMs: number): string | null {
  const lock = `${path}.takeover`;
  if (!createExclusive(lock)) {
    let age = 0;
    try {
      age = nowMs - statSync(lock).mtimeMs;
    } catch {
      return null;
    }
    if (age <= TAKEOVER_STALE_MS) return null;
    unlinkQuietly(lock);
    if (!createExclusive(lock)) return null;
  }
  try {
    const current = readClaimBody(path);
    if (current !== null && !claimAbandoned(path, current, nowMs)) return null;
    const tmp = `${path}.${token}.tmp`;
    writeFileSync(tmp, body);
    renameSync(tmp, path);
    return token;
  } catch {
    return null;
  } finally {
    unlinkQuietly(lock);
  }
}

function createExclusive(path: string): boolean {
  try {
    writeFileSync(path, String(process.pid), { flag: "wx" });
    return true;
  } catch {
    return false;
  }
}

function readClaimBody(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function claimAbandoned(path: string, body: string, nowMs: number): boolean {
  try {
    const parsed = JSON.parse(body) as { at?: unknown };
    if (typeof parsed.at === "number") return nowMs - parsed.at > FRESHEN_CLAIM_ABANDONED_MS;
  } catch {
    // Torn or empty: judged by age below.
  }
  try {
    return nowMs - statSync(path).mtimeMs > CLAIM_TORN_GRACE_MS;
  } catch {
    return false;
  }
}

function unlinkQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Already gone.
  }
}

/** Release the claim, but only while it is still ours. */
export function releaseFreshen(dir: string, token: string): void {
  const path = join(dir, FRESHEN_CLAIM_FILE);
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { token?: unknown };
    if (parsed.token === token) unlinkSync(path);
  } catch {
    // Absent or unreadable: nothing of ours to release.
  }
}

/**
 * Record that a write landed at `nowMs` and is waiting for a pass that
 * can provably cover it. Always overwrites with the newest instant: the
 * marker must never name an instant older than the youngest uncovered
 * write, or a pass would clear it while the newer write is still
 * missing. Best-effort, like every other piece of freshen bookkeeping -
 * a marker that cannot be written costs the write its second pass, not
 * the write itself.
 */
export function markFreshenPending(dir: string, nowMs: number): void {
  try {
    atomicWriteFileSync(
      join(dir, FRESHEN_PENDING_FILE),
      JSON.stringify({ since: nowMs } satisfies FreshenPending) + "\n",
    );
  } catch {
    // Best effort: the next forced claim re-marks.
  }
}

/** The pending marker at an arbitrary path, or `null` when torn or absent. */
function readPendingAt(path: string): FreshenPending | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      since?: unknown;
    };
    if (typeof parsed.since !== "number" || !Number.isFinite(parsed.since)) return null;
    return { since: parsed.since };
  } catch {
    return null;
  }
}

/** The pending marker, or `null` when there is none or it is torn. */
export function readFreshenPending(dir: string): FreshenPending | null {
  return readPendingAt(join(dir, FRESHEN_PENDING_FILE));
}

/** Drop the pending marker. An absent marker is nothing to fail a run over. */
export function clearFreshenPending(dir: string): void {
  try {
    unlinkSync(join(dir, FRESHEN_PENDING_FILE));
  } catch {
    // Already gone.
  }
}

/** A marker taken off its path by {@link takeFreshenPending}, held for the settle. */
export interface TakenFreshenPending {
  /** The marker as it stood on the path, or `null` when its file was torn. */
  readonly pending: FreshenPending | null;
  /**
   * Put the taken marker back. A writer that re-marked while the settle
   * held this take keeps the path: the link answers that atomically
   * (EEXIST means the path is occupied again), and the newer instant
   * supersedes the taken one, the marker naming the YOUNGEST uncovered
   * write.
   */
  restore(): void;
  /** Drop the taken marker: the pass that ran covered it. */
  drop(): void;
}

/**
 * Take the pending marker off its path atomically, so the settle can
 * judge and clear it without racing the writers that mark between the
 * settle's read and its unlink - the one window a plain
 * read-then-clear leaves open, and exactly the lost write the marker
 * exists to prevent. The rename moves whatever stands at the path NOW
 * (a later writer's marker can only land after it), and `restore` puts
 * the take back unless a newer marker claimed the path in between.
 * `null` when there was no marker to take.
 */
export function takeFreshenPending(dir: string): TakenFreshenPending | null {
  const path = join(dir, FRESHEN_PENDING_FILE);
  const held = `${path}.${randomUUID()}.settle`;
  try {
    renameSync(path, held);
  } catch {
    return null; // No marker (or the directory refused): nothing queued.
  }
  const pending = readPendingAt(held);
  return {
    pending,
    restore: () => {
      try {
        linkSync(held, path);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") {
          // A filesystem without hard links (EPERM, ENOTSUP, EXDEV on
          // network and exFAT mounts): the exclusive put-back is
          // unavailable there, so the take goes back by plain rename -
          // the small window where a writer's newer marker could be
          // replaced is the price of not destroying the marker outright.
          try {
            renameSync(held, path);
            return;
          } catch {
            // rename(2) replaces an occupied destination on every
            // platform this runs on, so reaching here is a genuine I/O
            // failure, not an occupied path: the take cannot be put
            // back and is dropped below - the same best-effort loss a
            // marker that cannot be written already names.
          }
        }
      }
      unlinkQuietly(held);
    },
    drop: () => {
      unlinkQuietly(held);
    },
  };
}

/**
 * The freshen child's settle, run before it releases the claim.
 *
 * A forced write that arrived while THIS run held the claim left a
 * marker naming the instant its write landed. The run's own pass covers
 * everything up to its scan start, so:
 *
 *   - a marker at or before the scan start is covered - clear it;
 *   - a newer marker is not: run ONE more incremental pass - the bound
 *     is one extra pass, never a loop - and take the marker only once
 *     the pass has finished, clearing it when it still names an instant
 *     the extra pass's own scan start covers. A still-newer marker (a
 *     write landing during the extra pass) survives for the next run,
 *     which covers and clears it the same way;
 *   - a caller that cannot run a pass (a config that never resolved)
 *     leaves the marker exactly as it stands.
 *
 * The marker is READ before any pass runs and TAKEN only after - never
 * the other way round. A take that outran its pass handed a killed or
 * thrown-away child a marker stranded in the take's hold file, where
 * nothing reads it again: the write stood unqueued and unmarked. With
 * the pass running against a marker that never left its path, a child
 * that dies mid-pass leaves the queue exactly as it found it, and the
 * take's hold window shrinks to the judge-and-clear after the pass -
 * where {@link takeFreshenPending}'s restore still answers a writer
 * that re-marked with newer work, superseding the take rather than
 * being unlinked by this settle. A pass that throws covered nothing and
 * the marker was never taken, so it stands for the next run.
 *
 * Returns whether the extra pass ran. Throws only what `runPass`
 * throws, and the caller decides how a failed extra pass is reported.
 */
export async function settleFreshenPending(
  dir: string,
  scanStartedAtMs: number,
  runPass: (() => Promise<void>) | null,
): Promise<boolean> {
  // Read without taking: the marker stays on its own path through every
  // fallible step below, so a child that dies at any of them leaves the
  // queue standing for the next run.
  const pending = readFreshenPending(dir);
  if (pending === null) return false;
  if (pending.since <= scanStartedAtMs) {
    // This run's scan began after the pending write: the pass that just
    // finished covered it. The take judges what stands NOW, so a writer
    // that re-marked between the read and this take keeps its newer
    // marker - only a still-covered marker is dropped.
    const covered = takeFreshenPending(dir);
    if (covered !== null) {
      if (covered.pending !== null && covered.pending.since <= scanStartedAtMs) {
        covered.drop();
      } else {
        covered.restore();
      }
    }
    return false;
  }
  if (runPass === null) {
    // No pass to run: the marker stands untouched for the next run.
    return false;
  }
  const secondStart = Date.now();
  // A pass that throws propagates with the marker still on its path -
  // it covered nothing, and that standing marker is the truthful queue.
  await runPass();
  const taken = takeFreshenPending(dir);
  if (taken === null) return true;
  if (taken.pending !== null && taken.pending.since <= secondStart) {
    // The extra pass started after the marker's instant, so it covered
    // the pending write - and the marker goes with it. A marker that
    // outlived its own coverage would push every later run into an
    // extra pass forever.
    taken.drop();
  } else {
    // The write landed after the extra pass's scan start: this run
    // cannot prove it saw the write, so the marker survives for the
    // next run - superseded, not merged, if a writer re-marked during
    // the pass.
    taken.restore();
  }
  return true;
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** The state file, or the empty state when it is absent or torn. */
export function readFreshenState(dir: string): FreshenState {
  try {
    const raw = JSON.parse(readFileSync(join(dir, FRESHEN_STATE_FILE), "utf8")) as Record<
      string,
      unknown
    >;
    const outcome = raw["lastOutcome"];
    return Object.freeze({
      failures: num(raw["failures"]) ?? 0,
      backoffUntil: str(raw["backoffUntil"]),
      lastOutcome: outcome === "completed" || outcome === "failed" ? outcome : null,
      lastRunAt: str(raw["lastRunAt"]),
      lastDurationMs: num(raw["lastDurationMs"]),
      lastError: str(raw["lastError"]),
      lastChanged: num(raw["lastChanged"]),
    });
  } catch {
    return EMPTY_FRESHEN_STATE;
  }
}

/** Write the state file atomically. */
export function writeFreshenState(dir: string, state: FreshenState): void {
  atomicWriteFileSync(join(dir, FRESHEN_STATE_FILE), JSON.stringify(state, null, 2) + "\n");
}

/**
 * Prefix the child's argv so it runs at idle I/O priority where the
 * platform has a tool for it; the child lowers its own CPU priority.
 */
export function freshenCommand(
  base: ReadonlyArray<string>,
  has: (tool: string) => boolean,
  platform: NodeJS.Platform,
): string[] {
  if (platform === "linux" && has("ionice")) return ["ionice", "-c3", ...base];
  if (platform === "darwin" && has("taskpolicy")) return ["taskpolicy", "-b", ...base];
  return [...base];
}

/**
 * The options the freshen child is spawned with. Detached on every
 * platform: a non-detached child dies with its parent on Windows, and on
 * POSIX it stays in the reader's process group, so a short-lived hook
 * whose group is signalled on exit would take the run down with it.
 */
export function freshenSpawnOptions(env: NodeJS.ProcessEnv): {
  readonly stdin: "ignore";
  readonly stdout: "ignore";
  readonly stderr: "ignore";
  readonly windowsHide: true;
  readonly detached: true;
  readonly env: Record<string, string | undefined>;
} {
  return {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    windowsHide: true,
    detached: true,
    // Bun gives a child spawned without `env` the environment this process
    // STARTED with; a config chosen after start must reach the child.
    env: { ...env },
  };
}

function spawnDetached(argv: string[]): void {
  const proc = Bun.spawn(argv, freshenSpawnOptions(process.env));
  proc.unref();
}

export interface MaybeFreshenOptions {
  readonly lastIndexedAt: string | null;
  /** A read-only open (cross-vault, recall sources): never write there. */
  readonly readOnly?: boolean;
  /**
   * Skip the freshness gate and spawn whenever the remaining guards
   * allow. This is the post-write shape: the caller just changed the
   * vault, so the stamp is due by definition and comparing it against
   * the interval would answer the wrong question. Config off still
   * means off (`intervalSeconds <= 0` refuses whatever the flag says),
   * an index that was never stamped stays self-heal's, and the claim
   * exclusivity, the failure backoff and the writer-lock probe all
   * stand exactly as on the interval path.
   */
  readonly force?: boolean;
  readonly nowMs?: number;
  /** Test seam: replaces the detached spawn. */
  readonly spawn?: (argv: string[]) => void;
}

/**
 * Start a background incremental index run when the index is stale.
 * Never throws; returns what it did.
 */
export function maybeFreshenIndex(
  config: ResolvedSearchConfig,
  opts: MaybeFreshenOptions,
): FreshenDecision {
  try {
    const freshen = config.freshen;
    if (freshen === undefined || freshen.intervalSeconds <= 0) return FRESHEN_SKIP.off;
    if (opts.readOnly === true) return FRESHEN_SKIP.readOnly;
    const nowMs = opts.nowMs ?? Date.now();
    const dir = dirname(config.dbPath);
    const input = {
      nowMs,
      lastIndexedAt: opts.lastIndexedAt,
      intervalSeconds: freshen.intervalSeconds,
    };
    if (opts.force === true) {
      // The freshness comparison is the one gate force exists to skip;
      // everything else decides for the same reasons as on the interval
      // path. The stamp check doubles as the self-heal boundary: an
      // index that was never stamped is rebuilt there, not here.
      if (opts.lastIndexedAt === null) return FRESHEN_SKIP.noIndex;
      // No freshness floor on the stamp: the stamp marks when a run
      // FINISHED, and a run that finished after the write began may well
      // have scanned before the write landed - its stamp cannot prove it
      // saw the write. A forced run that skipped on such a stamp would
      // leave the write unindexed until the next interval or the next
      // write, silently. The collapse the floor promised is the claim
      // machinery's: a run already in flight holds the claim, so a write
      // landing during it starts nothing. Back-to-back applied writes
      // spawn one run each, capped by that exclusivity and the failure
      // backoff - the price of every run provably covering its write.
      const backoffUntil = readFreshenState(dir).backoffUntil;
      const backoffMs = backoffUntil === null ? Number.NaN : Date.parse(backoffUntil);
      if (Number.isFinite(backoffMs) && backoffMs > nowMs) return FRESHEN_SKIP.backoff;
    } else {
      // Every search lands here: decide on the index stamp alone first and
      // read the state file for the backoff only once the index is due.
      const due = decideFreshen({ ...input, backoffUntilMs: null });
      if (due.action === "skip") return due.reason;
      const backoffUntil = readFreshenState(dir).backoffUntil;
      const backoffMs = backoffUntil === null ? Number.NaN : Date.parse(backoffUntil);
      const decision = decideFreshen({
        ...input,
        backoffUntilMs: Number.isFinite(backoffMs) ? backoffMs : null,
      });
      if (decision.action === "skip") return decision.reason;
    }
    if (isWriterLockHeld(config.dbPath)) return FRESHEN_SKIP.writerLock;
    const claim = tryClaimFreshen(dir, nowMs);
    if (!("token" in claim)) return claim.skip;
    const token = claim.token;
    const argv = freshenCommand(
      [
        ...o2bCommand(),
        "search",
        "index",
        "--vault",
        config.vault,
        ...(freshen.configPath !== null ? ["--config", freshen.configPath] : []),
        // Where the claim and the state live, so a child that fails before
        // it can resolve its config can still record it and release.
        "--freshen-state",
        dir,
        "--freshen",
        token,
      ],
      (tool) => Bun.which(tool) !== null,
      process.platform,
    );
    try {
      (opts.spawn ?? spawnDetached)(argv);
    } catch {
      releaseFreshen(dir, token);
      return FRESHEN_SKIP.spawnFailed;
    }
    return "spawned";
  } catch {
    // A reader must never fail because freshening could not decide.
    return FRESHEN_SKIP.spawnFailed;
  }
}

export interface FreshenOutcome {
  readonly outcome: "completed" | "failed";
  readonly durationMs: number;
  /** Documents added, updated or deleted (completed runs). */
  readonly changed?: number;
  readonly error?: string;
}

/**
 * What the background child records when it ends: the state file (outcome,
 * streak, backoff) and, when it changed something or failed, one metric
 * row. Never throws: a run must not fail because its bookkeeping did.
 */
export function recordFreshenOutcome(
  vault: string | null,
  dir: string,
  result: FreshenOutcome,
  nowMs: number = Date.now(),
): void {
  const previous = readFreshenState(dir);
  const failed = result.outcome === "failed";
  const failures = failed ? previous.failures + 1 : 0;
  const runAt = new Date(nowMs).toISOString();
  try {
    writeFreshenState(dir, {
      failures,
      backoffUntil: failed ? new Date(nowMs + nextBackoffMs(failures)).toISOString() : null,
      lastOutcome: result.outcome,
      lastRunAt: runAt,
      lastDurationMs: result.durationMs,
      lastError: failed ? (result.error ?? "failed") : null,
      lastChanged: failed ? null : (result.changed ?? 0),
    });
  } catch {
    // Best effort, like the self-heal outcome rows.
  }
  if (vault === null || (!failed && (result.changed ?? 0) === 0)) return;
  try {
    appendMetric(vault, {
      surface: INDEX_FRESHEN_SURFACE,
      runAt,
      payload: {
        outcome: result.outcome,
        duration_ms: result.durationMs,
        ...(failed ? { error: result.error ?? "failed", failures } : {}),
        ...(!failed ? { changed: result.changed ?? 0 } : {}),
      },
    });
  } catch {
    // Same: metrics are diagnostics, never a reason to fail.
  }
}

/** What `o2b search status` and the doctor show about freshen on read. */
export interface FreshenStatus {
  /** 0 when freshening is off. */
  readonly intervalSeconds: number;
  readonly indexAgeSeconds: number | null;
  readonly state: FreshenState;
  /** The backoff end, only while it is still in the future. */
  readonly activeBackoffUntil: string | null;
  /**
   * The live measured index-behind total (t_e4438152): documents the
   * next incremental run would add, update or delete, measured NOW.
   * Passed in by the caller that chose to pay the walk - this stays a
   * pure state-file reader, so the doctor's freshen check (which reads
   * the state file on its own) picks up no walk cost. Null means not
   * measured - a failed measurement is not a measurement, never zero.
   */
  readonly indexBehind: number | null;
}

export function freshenStatus(
  config: ResolvedSearchConfig,
  lastIndexedAt: string | null,
  nowMs: number = Date.now(),
  indexBehind: number | null = null,
): FreshenStatus {
  const state = readFreshenState(dirname(config.dbPath));
  const backoffMs = state.backoffUntil === null ? Number.NaN : Date.parse(state.backoffUntil);
  return Object.freeze({
    intervalSeconds: config.freshen?.intervalSeconds ?? 0,
    indexAgeSeconds: indexAgeSeconds(lastIndexedAt, nowMs),
    state,
    activeBackoffUntil: Number.isFinite(backoffMs) && backoffMs > nowMs ? state.backoffUntil : null,
    indexBehind,
  });
}

/** The status lines, aligned with the rest of `o2b search status`. */
export function renderFreshenStatus(s: FreshenStatus): string[] {
  const lines = [
    `freshen:             ${s.intervalSeconds > 0 ? `every ${s.intervalSeconds}s` : "off"}`,
    `index_age:           ${s.indexAgeSeconds === null ? "(unknown)" : `${s.indexAgeSeconds}s`}`,
    // The label stays within the 19 columns every status label fits in.
    `index_behind:        ${
      s.indexBehind === null
        ? "(not measured)"
        : `${s.indexBehind} doc${s.indexBehind === 1 ? "" : "s"}`
    }`,
  ];
  const st = s.state;
  if (st.lastOutcome === "completed") {
    lines.push(`last_freshen:        completed ${st.lastRunAt} (${st.lastChanged ?? 0} changed)`);
  } else if (st.lastOutcome === "failed") {
    lines.push(
      `last_freshen:        failed ${st.lastRunAt} (${st.failures} in a row): ${st.lastError}`,
    );
  } else {
    lines.push("last_freshen:        (none)");
  }
  // The label stays within the 19 columns every status label fits in.
  if (s.activeBackoffUntil !== null) {
    lines.push(`freshen_backoff:     until ${s.activeBackoffUntil}`);
  }
  return lines;
}

/** The `freshen` object of `o2b search status --json`. */
export function serializeFreshenStatus(s: FreshenStatus): Record<string, unknown> {
  return {
    interval_s: s.intervalSeconds,
    index_age_s: s.indexAgeSeconds,
    index_behind: s.indexBehind,
    last_outcome: s.state.lastOutcome,
    last_run_at: s.state.lastRunAt,
    last_changed: s.state.lastChanged,
    last_error: s.state.lastError,
    failures: s.state.failures,
    backoff_until: s.activeBackoffUntil,
  };
}
