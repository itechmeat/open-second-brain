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
 * `maybeFreshenIndex` never throws and never waits for the run: a reader's
 * cost is one state-file read, one lock probe and one exclusive create.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
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
 * would leave the index stale forever.
 */
export function decideFreshen(
  input: DecideFreshenInput,
): { readonly action: "spawn" } | { readonly action: "skip"; readonly reason: FreshenSkip } {
  if (input.intervalSeconds <= 0) return { action: "skip", reason: FRESHEN_SKIP.off };
  if (input.lastIndexedAt === null) return { action: "skip", reason: FRESHEN_SKIP.noIndex };
  if (input.backoffUntilMs !== null && input.backoffUntilMs > input.nowMs) {
    return { action: "skip", reason: FRESHEN_SKIP.backoff };
  }
  const indexedMs = Date.parse(input.lastIndexedAt);
  if (Number.isFinite(indexedMs) && input.nowMs - indexedMs < input.intervalSeconds * 1000) {
    return { action: "skip", reason: FRESHEN_SKIP.fresh };
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
 * Take the claim, or return null when a live run holds it. The claim is an
 * exclusive create, so of N readers racing on a stale index exactly one
 * wins. A claim that is torn or older than {@link FRESHEN_CLAIM_ABANDONED_MS}
 * is a run that died (a reboot, an OOM kill) and is taken over.
 */
export function claimFreshen(dir: string, nowMs: number): string | null {
  const path = join(dir, FRESHEN_CLAIM_FILE);
  const token = `fr-${randomUUID()}`;
  const body = JSON.stringify({ token, at: nowMs });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, body, { flag: "wx" });
      return token;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") return null;
    }
    if (!claimAbandoned(path, nowMs)) return null;
    try {
      unlinkSync(path);
    } catch {
      // Another reader took it over first; the retry's exclusive create
      // decides between us.
    }
  }
  return null;
}

function claimAbandoned(path: string, nowMs: number): boolean {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { at?: unknown };
    return typeof parsed.at !== "number" || nowMs - parsed.at > FRESHEN_CLAIM_ABANDONED_MS;
  } catch {
    return true;
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

function spawnDetached(argv: string[]): void {
  const proc = Bun.spawn(argv, {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    windowsHide: true,
    // As for the self-heal reindex: a non-detached child dies with its
    // parent on Windows, and a hook process is short-lived.
    detached: process.platform === "win32",
    // Bun gives a child spawned without `env` the environment this process
    // STARTED with; a config chosen after start must reach the child.
    env: { ...process.env },
  });
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
    const backoffUntil = readFreshenState(dir).backoffUntil;
    const backoffMs = backoffUntil === null ? Number.NaN : Date.parse(backoffUntil);
    const decision = decideFreshen({
      nowMs,
      lastIndexedAt: opts.lastIndexedAt,
      intervalSeconds: freshen.intervalSeconds,
      backoffUntilMs: Number.isFinite(backoffMs) ? backoffMs : null,
    });
    if (decision.action === "skip") return decision.reason;
    if (isWriterLockHeld(config.dbPath)) return FRESHEN_SKIP.writerLock;
    const token = claimFreshen(dir, nowMs);
    if (token === null) return FRESHEN_SKIP.claimed;
    const argv = freshenCommand(
      [
        ...o2bCommand(),
        "search",
        "index",
        "--vault",
        config.vault,
        ...(freshen.configPath !== null ? ["--config", freshen.configPath] : []),
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
  vault: string,
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
  if (!failed && (result.changed ?? 0) === 0) return;
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
