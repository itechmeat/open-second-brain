/**
 * Quiet-window maintenance lane (write-time-integrity-governance,
 * t_166d1226). Heavy passes (dream, reindex) run through three gates:
 *
 *   1. window  - a configured local-time hour window (tz-aware,
 *                midnight wrap supported); unconfigured = always open.
 *   2. busy    - recent interactive query-rate from the existing
 *                recall-telemetry continuity records; a vault without
 *                telemetry counts as quiet.
 *   3. lease   - the expiring SQLite lease; never bypassable, even
 *                with --force, because two concurrent heavy passes on
 *                one vault is the exact failure this lane exists to
 *                prevent.
 *
 * `--force` bypasses the soft gates (window, busy) for an operator
 * who wants the pass NOW; tasks run stale-first (least-recently
 * succeeded first, never-run before everything) and every attempt is
 * journaled.
 */

import { listRecallTelemetry } from "../recall-telemetry.ts";
import { acquireLease, MAINTENANCE_LEASE_NAME, releaseLease } from "./lease.ts";
import { appendJournal, listJournal, type MaintenanceVerdict } from "./journal.ts";

/** Default lease TTL: generous enough for a full reindex + dream. */
export const MAINTENANCE_LEASE_TTL_MS = 30 * 60 * 1000;
/** Default busy gate: this many queries in the window means busy. */
export const MAINTENANCE_BUSY_THRESHOLD = 5;
/** Default busy lookback window in minutes. */
export const MAINTENANCE_BUSY_MINUTES = 10;

export interface DailyWindow {
  /** Local hour [0..23] the window opens (inclusive). */
  readonly startHour: number;
  /** Local hour [0..23] the window closes (exclusive). */
  readonly endHour: number;
  readonly tz: string;
}

export interface BusyGate {
  readonly minutes: number;
  readonly threshold: number;
}

export interface EvaluateGatesOptions {
  readonly now: Date;
  /** Absent = the window gate is always open (neutral default). */
  readonly window?: DailyWindow;
  readonly busy?: BusyGate;
}

export interface MaintenanceTask {
  readonly name: string;
  readonly run: () => Promise<void>;
}

export interface RunMaintenanceOptions extends EvaluateGatesOptions {
  readonly holder: string;
  readonly tasks: ReadonlyArray<MaintenanceTask>;
  /** Bypass window and busy gates - never the lease. */
  readonly force?: boolean;
  readonly leaseTtlMs?: number;
}

export interface MaintenanceTaskResult {
  readonly name: string;
  readonly ok: boolean;
  readonly duration_ms: number;
  readonly error?: string;
}

export interface RunMaintenanceResult {
  readonly verdict: MaintenanceVerdict;
  readonly tasks: ReadonlyArray<MaintenanceTaskResult>;
}

/** True when `now` falls inside the local-time window (wrap-aware). */
export function dailyWindowContains(now: Date, window: DailyWindow): boolean {
  const hour = Number(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: window.tz,
      hour: "2-digit",
      hourCycle: "h23",
    }).format(now),
  );
  if (window.startHour === window.endHour) return true; // degenerate: always open
  if (window.startHour < window.endHour) {
    return hour >= window.startHour && hour < window.endHour;
  }
  // Midnight wrap: 22-04 means [22..24) plus [0..4).
  return hour >= window.startHour || hour < window.endHour;
}

/** Evaluate the soft gates; the lease is checked at run time. */
export function evaluateGates(vault: string, opts: EvaluateGatesOptions): MaintenanceVerdict {
  if (opts.window !== undefined && !dailyWindowContains(opts.now, opts.window)) {
    return "skipped:window";
  }
  const busy = opts.busy ?? {
    minutes: MAINTENANCE_BUSY_MINUTES,
    threshold: MAINTENANCE_BUSY_THRESHOLD,
  };
  const since = new Date(opts.now.getTime() - busy.minutes * 60_000).toISOString();
  const recent = listRecallTelemetry(vault, { since });
  if (recent.length >= busy.threshold) return "skipped:busy";
  return "run";
}

/**
 * Run the registered heavy tasks through the gates. Tasks execute
 * stale-first: least-recently succeeded first (from the journal),
 * never-run before everything, so a task that keeps failing or got
 * starved naturally floats to the front.
 */
export async function runMaintenance(
  vault: string,
  opts: RunMaintenanceOptions,
): Promise<RunMaintenanceResult> {
  const nowIso = opts.now.toISOString();
  if (opts.force !== true) {
    const verdict = evaluateGates(vault, opts);
    if (verdict !== "run") {
      appendJournal(vault, { ts: nowIso, holder: opts.holder, verdict });
      return { verdict, tasks: [] };
    }
  }

  const ttl = opts.leaseTtlMs ?? MAINTENANCE_LEASE_TTL_MS;
  if (!acquireLease(vault, { holder: opts.holder, ttlMs: ttl, now: opts.now })) {
    appendJournal(vault, { ts: nowIso, holder: opts.holder, verdict: "skipped:lease" });
    return { verdict: "skipped:lease", tasks: [] };
  }

  try {
    const ordered = orderStaleFirst(vault, opts.tasks);
    const results: MaintenanceTaskResult[] = [];
    for (const task of ordered) {
      const startedAt = Date.now();
      let ok = true;
      let error: string | undefined;
      try {
        // Sequential by design: the lane exists to serialize heavy work.
        // eslint-disable-next-line no-await-in-loop
        await task.run();
      } catch (exc) {
        ok = false;
        error = exc instanceof Error ? exc.message : String(exc);
      }
      const duration = Date.now() - startedAt;
      results.push({ name: task.name, ok, duration_ms: duration, ...(error ? { error } : {}) });
      appendJournal(vault, {
        ts: nowIso,
        holder: opts.holder,
        verdict: "run",
        task: task.name,
        ok,
        duration_ms: duration,
        ...(error ? { error } : {}),
      });
    }
    return { verdict: "run", tasks: results };
  } finally {
    releaseLease(vault, { holder: opts.holder, name: MAINTENANCE_LEASE_NAME });
  }
}

function orderStaleFirst(vault: string, tasks: ReadonlyArray<MaintenanceTask>): MaintenanceTask[] {
  const lastSuccess = new Map<string, string>();
  for (const entry of listJournal(vault)) {
    if (entry.task === undefined || entry.ok !== true) continue;
    if (!lastSuccess.has(entry.task)) lastSuccess.set(entry.task, entry.ts); // newest-first list
  }
  return [...tasks].toSorted((a, b) => {
    const aTs = lastSuccess.get(a.name) ?? "";
    const bTs = lastSuccess.get(b.name) ?? "";
    return aTs.localeCompare(bTs);
  });
}
