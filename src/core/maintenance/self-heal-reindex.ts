/**
 * What became of the detached post-upgrade reindex.
 *
 * `ensureVaultCurrent(vault, { background: true })` runs at every full-scope
 * MCP server start and at every `SessionStart` / `PostCompact` hook. After a
 * schema bump, N concurrent agent sessions therefore each spawn a detached
 * `o2b search reindex` with `stdin/stdout/stderr: "ignore"`; one takes the
 * writer lock and the rest fast-fail on it. With no terminal attached and no
 * parent waiting - the child is `unref`ed precisely so it cannot hold a
 * session open - the losers' `INDEX_LOCKED` went nowhere any operator could
 * ever read.
 *
 * ## Why the metrics surface, and not the maintenance journal
 *
 * `src/core/brain/metrics.ts` already declares exactly this contract: one
 * append-only JSONL file per surface, records that are RUN-LEVEL - "one per
 * index run" in its own words - written as single O_APPEND lines so
 * concurrent writers interleave instead of racing a rewrite. A self-heal is
 * an index run, the herd is a set of concurrent writers, and no lock is
 * taken to record a row, so a hook process is never slowed or blocked by
 * one. The maintenance journal
 * (`src/core/brain/maintenance/journal.ts`) was the alternative and does not
 * fit: its rows carry a lease `holder` and a lane `task`, and its verdict
 * vocabulary is closed over the quiet-window lane's gates. Neither is a
 * thing this run has.
 *
 * ## Two rows, and what the pair means
 *
 * The parent records its SPAWN DECISION; the child records its own TERMINAL
 * OUTCOME, because nothing survives to await it. They pair on a RUN ID the
 * parent mints before the spawn and hands to the child on its command line
 * ({@link mintSelfHealRunId}, `o2b search reindex --self-heal <run-id>`).
 *
 * The pid was the obvious pairing key and is the wrong one. A pid is
 * machine-local, which this module forbids on a row two paragraphs down,
 * and it is not even unique on one host: pids are reused, so over the life
 * of a vault a peer's `{decision: spawned, pid: 4242}` and this device's
 * `{outcome: completed, pid: 4242}` pair up and report a vanished child as
 * a finished one. A run id identifies a RUN rather than a process, so it
 * collides with nothing and stays true wherever the row is read.
 *
 * ## What an unpaired spawn row proves, and what it does not
 *
 * A spawn row with no terminal row beside it means exactly one thing: no
 * terminal outcome was recorded for that run. Four states produce it, and
 * only the first is the one the pair was built to catch:
 *
 *   1. the child vanished - SIGKILL, OOM, a host that reaped the session's
 *      process group - which is the one failure no in-child recording can
 *      report about itself;
 *   2. the child is STILL RUNNING; a full reindex of a real vault takes
 *      minutes and looks identical to (1) for that whole window - the
 *      row's `runAt` is the only bound on how long it has been going;
 *   3. the child died before it could arm the recording - `parseFlags`
 *      refused its argv, or (only when no `--vault` reached it) its
 *      configuration would not resolve. Everything after that point is
 *      recorded: {@link recordSelfHealOutcome} is called on the config
 *      failure path too;
 *   4. the child ran and its own {@link append} failed - a read-only
 *      vault, a full disk. That is deliberate (observability never fails
 *      the pass it observes) and it is indistinguishable from (1) by
 *      construction.
 *
 * A child that never started is distinguishable and correctly so: `Bun.spawn`
 * throwing means no row of either kind is written and the caller's `errors`
 * carries the reason.
 *
 * The rows live under `Brain/`, which is synced across devices, while the
 * index they describe is per-device and rebuildable. So a row states that a
 * self-heal ran on SOME device, never that this device's index is stale;
 * the authority on that is the index's own `schema_version`. Nothing
 * machine-local is written into a row - no db path, no host, no pid -
 * because a synced vault carries it to peers where it is false.
 */

import { randomUUID } from "node:crypto";

import { appendMetric, listMetrics } from "../brain/metrics.ts";

/** Metrics surface these rows are appended to. */
export const SELF_HEAL_REINDEX_SURFACE = "self_heal_reindex";

/**
 * What the parent did about a reindex it found necessary.
 *
 * Separate from {@link SELF_HEAL_REINDEX_OUTCOME} because the two answer
 * different questions in different processes - whether a child was started,
 * and what a started child ended as - and a guard that accepted both would
 * let a refusal to start be read back as a run that finished.
 */
export const SELF_HEAL_SPAWN = Object.freeze({
  /** A detached child was started; its pid is on the row. */
  spawned: "spawned",
  /** Another writer already held the index lock, so nothing was started. */
  skippedWriterLock: "skipped_writer_lock",
} as const);

/** Closed union over {@link SELF_HEAL_SPAWN}. */
export type SelfHealSpawnDecision = (typeof SELF_HEAL_SPAWN)[keyof typeof SELF_HEAL_SPAWN];

/** Membership list, in declaration order. */
export const SELF_HEAL_SPAWN_DECISIONS: ReadonlyArray<SelfHealSpawnDecision> = Object.freeze(
  Object.values(SELF_HEAL_SPAWN),
);

/**
 * `unknown` rather than `string`: the value is read back off a JSONL file
 * that a peer device - or an older release - may have written.
 */
export function isSelfHealSpawnDecision(value: unknown): value is SelfHealSpawnDecision {
  return (
    typeof value === "string" &&
    (SELF_HEAL_SPAWN_DECISIONS as ReadonlyArray<string>).includes(value)
  );
}

/** How a spawned child ended. */
export const SELF_HEAL_REINDEX_OUTCOME = Object.freeze({
  /** The rebuild finished; the index is on the current schema. */
  completed: "completed",
  /** The rebuild threw. The row carries the failure by name. */
  failed: "failed",
} as const);

/** Closed union over {@link SELF_HEAL_REINDEX_OUTCOME}. */
export type SelfHealReindexOutcome =
  (typeof SELF_HEAL_REINDEX_OUTCOME)[keyof typeof SELF_HEAL_REINDEX_OUTCOME];

/** Membership list, in declaration order. */
export const SELF_HEAL_REINDEX_OUTCOMES: ReadonlyArray<SelfHealReindexOutcome> = Object.freeze(
  Object.values(SELF_HEAL_REINDEX_OUTCOME),
);

/** `unknown` for the same reason {@link isSelfHealSpawnDecision} takes it. */
export function isSelfHealReindexOutcome(value: unknown): value is SelfHealReindexOutcome {
  return (
    typeof value === "string" &&
    (SELF_HEAL_REINDEX_OUTCOMES as ReadonlyArray<string>).includes(value)
  );
}

/**
 * Mint the id the two rows of one self-heal pair carry.
 *
 * A UUID and not a timestamp-plus-counter: the two rows are written by two
 * processes on a vault that syncs to peers, so the only uniqueness that
 * holds is the kind that needs no coordination. The `sh-` prefix keeps the
 * value self-describing in a JSONL line an operator reads by eye.
 */
export function mintSelfHealRunId(): string {
  return `sh-${randomUUID()}`;
}

/** One row, narrowed. Exactly one of `decision` / `outcome` is non-null. */
export interface SelfHealReindexRow {
  /** ISO-8601 UTC instant the row describes. */
  readonly runAt: string;
  /** Set on the parent's spawn-decision rows. */
  readonly decision: SelfHealSpawnDecision | null;
  /** Set on the child's terminal rows. */
  readonly outcome: SelfHealReindexOutcome | null;
  /** What the two rows of one run pair on; `null` when no child was started. */
  readonly runId: string | null;
  /** How long the child ran; `null` on a parent row. */
  readonly durationMs: number | null;
  /** The failure, by name; `null` on every row that is not a failure. */
  readonly error: string | null;
}

/**
 * Record the parent's spawn decision. Fail-soft: a metrics-layer problem
 * must never take down a server start or a hook, which is the whole reason
 * this call sits on the startup path at all.
 */
export function recordSelfHealSpawn(
  vault: string,
  decision: SelfHealSpawnDecision,
  runId: string | null = null,
): void {
  append(vault, {
    decision,
    ...(runId === null ? {} : { run_id: runId }),
  });
}

/**
 * Record a child's terminal outcome. Called BY THE CHILD, in its own
 * process, because the parent `unref`ed it and is long gone; `runId` is the
 * one the parent minted and passed on the command line, which is what makes
 * this row the answer to that parent's spawn row.
 */
export function recordSelfHealOutcome(
  vault: string,
  outcome: SelfHealReindexOutcome,
  runId: string,
  durationMs: number,
  error?: string,
): void {
  append(vault, {
    outcome,
    run_id: runId,
    duration_ms: durationMs,
    ...(error === undefined ? {} : { error }),
  });
}

function append(vault: string, payload: Readonly<Record<string, unknown>>): void {
  try {
    appendMetric(vault, {
      surface: SELF_HEAL_REINDEX_SURFACE,
      runAt: new Date().toISOString(),
      payload,
    });
  } catch {
    // Fail-soft, as everywhere in the metrics layer: observability never
    // fails the pass it observes.
  }
}

/**
 * Rows for `vault`, newest first. A row this build cannot narrow - neither
 * a known decision nor a known outcome - is skipped rather than surfaced as
 * a null-null row that a reader would have to guess about.
 */
export function readSelfHealReindexRows(
  vault: string,
  limit?: number,
): ReadonlyArray<SelfHealReindexRow> {
  const cap = limit === undefined ? Number.POSITIVE_INFINITY : Math.max(0, limit);
  const rows: SelfHealReindexRow[] = [];
  for (const record of listMetrics(vault, { surface: SELF_HEAL_REINDEX_SURFACE })) {
    if (rows.length >= cap) break;
    const payload = record.payload;
    const rawDecision: unknown = payload["decision"];
    const rawOutcome: unknown = payload["outcome"];
    const rawRunId: unknown = payload["run_id"];
    const rawDuration: unknown = payload["duration_ms"];
    const rawError: unknown = payload["error"];
    const decision = isSelfHealSpawnDecision(rawDecision) ? rawDecision : null;
    const outcome = isSelfHealReindexOutcome(rawOutcome) ? rawOutcome : null;
    if (decision === null && outcome === null) continue;
    rows.push(
      Object.freeze({
        runAt: record.run_at,
        decision,
        outcome,
        runId: typeof rawRunId === "string" ? rawRunId : null,
        durationMs: typeof rawDuration === "number" ? rawDuration : null,
        error: typeof rawError === "string" ? rawError : null,
      }),
    );
  }
  return Object.freeze(rows);
}
