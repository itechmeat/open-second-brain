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
import { readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
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
}

export function freshenStatus(
  config: ResolvedSearchConfig,
  lastIndexedAt: string | null,
  nowMs: number = Date.now(),
): FreshenStatus {
  const state = readFreshenState(dirname(config.dbPath));
  const backoffMs = state.backoffUntil === null ? Number.NaN : Date.parse(state.backoffUntil);
  return Object.freeze({
    intervalSeconds: config.freshen?.intervalSeconds ?? 0,
    indexAgeSeconds: indexAgeSeconds(lastIndexedAt, nowMs),
    state,
    activeBackoffUntil: Number.isFinite(backoffMs) && backoffMs > nowMs ? state.backoffUntil : null,
  });
}

/** The status lines, aligned with the rest of `o2b search status`. */
export function renderFreshenStatus(s: FreshenStatus): string[] {
  const lines = [
    `freshen:             ${s.intervalSeconds > 0 ? `every ${s.intervalSeconds}s` : "off"}`,
    `index_age:           ${s.indexAgeSeconds === null ? "(unknown)" : `${s.indexAgeSeconds}s`}`,
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
    last_outcome: s.state.lastOutcome,
    last_run_at: s.state.lastRunAt,
    last_changed: s.state.lastChanged,
    last_error: s.state.lastError,
    failures: s.state.failures,
    backoff_until: s.activeBackoffUntil,
  };
}
