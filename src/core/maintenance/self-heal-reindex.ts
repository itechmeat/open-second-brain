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
 * OUTCOME, because nothing survives to await it. They pair on the child's
 * pid: the parent knows it at spawn, the child knows it as `process.pid`.
 * A spawn row with no terminal row beside it is therefore a child that
 * vanished - SIGKILL, OOM, a host that reaped the session's process group -
 * which is the one failure no in-child recording can report about itself.
 *
 * The rows live under `Brain/`, which is synced across devices, while the
 * index they describe is per-device and rebuildable. So a row states that a
 * self-heal ran on SOME device, never that this device's index is stale;
 * the authority on that is the index's own `schema_version`. Nothing
 * machine-local is written into a row - no db path, no host - because a
 * synced vault carries it to peers where it is false.
 */

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

/** One row, narrowed. Exactly one of `decision` / `outcome` is non-null. */
export interface SelfHealReindexRow {
  /** ISO-8601 UTC instant the row describes. */
  readonly runAt: string;
  /** Set on the parent's spawn-decision rows. */
  readonly decision: SelfHealSpawnDecision | null;
  /** Set on the child's terminal rows. */
  readonly outcome: SelfHealReindexOutcome | null;
  /** The child's pid; `null` when no child was started. */
  readonly pid: number | null;
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
  pid: number | null = null,
): void {
  append(vault, {
    decision,
    ...(pid === null ? {} : { pid }),
  });
}

/**
 * Record a child's terminal outcome. Called BY THE CHILD, in its own
 * process, because the parent `unref`ed it and is long gone.
 */
export function recordSelfHealOutcome(
  vault: string,
  outcome: SelfHealReindexOutcome,
  durationMs: number,
  error?: string,
): void {
  append(vault, {
    outcome,
    pid: process.pid,
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
    const rawPid: unknown = payload["pid"];
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
        pid: typeof rawPid === "number" ? rawPid : null,
        durationMs: typeof rawDuration === "number" ? rawDuration : null,
        error: typeof rawError === "string" ? rawError : null,
      }),
    );
  }
  return Object.freeze(rows);
}
