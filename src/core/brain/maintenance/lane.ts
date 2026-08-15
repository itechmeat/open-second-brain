/**
 * Quiet-window maintenance lane (write-time-integrity-governance,
 * t_166d1226; host pressure and the failure streak, t_992f0c33). Heavy
 * passes (dream, reindex) run through four gates:
 *
 *   1. window   - a configured local-time hour window (tz-aware,
 *                 midnight wrap supported); unconfigured = always open.
 *   2. busy     - recent interactive query-rate from the existing
 *                 recall-telemetry continuity records; a vault without
 *                 telemetry counts as quiet.
 *   3. pressure - the host's normalised run queue, from
 *                 `maintenance.host_pressure_percent`; unconfigured =
 *                 always open. Where the metric is degenerate the gate
 *                 stays open and journals WHY, on its own line, so a
 *                 platform that cannot measure pressure never looks
 *                 like a quiet one.
 *   4. lease    - the expiring SQLite lease; never bypassable, even
 *                 with --force, because two concurrent heavy passes on
 *                 one vault is the exact failure this lane exists to
 *                 prevent.
 *
 * Then, per task, a consecutive-failure streak read off the journal:
 * a task that has failed `maintenance.failure_streak_limit` times in a
 * row is refused by name rather than retried, because nothing here
 * supervises a repeating failure and the lane's stale-first ordering
 * would otherwise hand a permanently broken task the lease first on
 * every pass.
 *
 * ## Two escapes, and why the narrow one exists
 *
 * A refusal is per task and the other tasks still run - but it stands
 * until something clears it, and only a SUCCESS clears it. So there has
 * to be a way to attempt the refused task again.
 *
 * `force` is the wide one: it bypasses the soft gates (window, busy,
 * pressure) and every streak refusal, for an operator who wants the pass
 * NOW. Making it the only way out was the defect: an operator whose
 * reindex is deterministically broken had to run the whole heavy lane
 * with their own window, busy and host-pressure protection switched off
 * in order to retry one task.
 *
 * {@link RunMaintenanceOptions.retryTasks} is the narrow one: it bypasses
 * the streak refusal for the tasks it NAMES and nothing else. Every gate
 * the operator configured still decides, the lease still decides, and a
 * task it does not name is still refused. It clears no state and writes
 * no row of its own: the attempt's own outcome row is what ends the
 * streak if it succeeds, and what deepens it if it does not, so a retry
 * that keeps failing costs one lane slot per invocation the operator
 * chose to make - not a standing exemption.
 *
 * Tasks run stale-first (least-recently succeeded first, never-run
 * before everything) and every attempt is journaled.
 */

import { listRecallTelemetry } from "../recall-telemetry.ts";
import { capOutput, SafeguardTimeoutError } from "../safeguard.ts";
import { loadMaintenanceConfigSafe } from "../policy/load.ts";
import { acquireLease, MAINTENANCE_LEASE_NAME, releaseLease } from "./lease.ts";
import {
  appendJournal,
  consecutiveTaskFailures,
  listJournal,
  MAINTENANCE_VERDICT,
  sweepJournal,
  type MaintenanceJournalEntry,
  type MaintenanceVerdict,
} from "./journal.ts";
import { HOST_PRESSURE, measureHostPressure, type HostPressureReading } from "./host-pressure.ts";

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

export interface HostPressureGate {
  /** Skip when the normalised run queue is at or above this percentage. */
  readonly percent: number;
}

export interface EvaluateGatesOptions {
  readonly now: Date;
  /** Absent = the window gate is always open (neutral default). */
  readonly window?: DailyWindow;
  readonly busy?: BusyGate;
  /**
   * Absent = the host-pressure gate is not configured and never fires.
   * {@link runMaintenance} fills it from the vault's `maintenance:`
   * block when the caller does not name one.
   */
  readonly pressure?: HostPressureGate;
  /** Injectable measurement; defaults to reading this host. */
  readonly readPressure?: () => HostPressureReading;
}

/**
 * What the soft gates decided, and what the pressure gate saw while
 * deciding it.
 *
 * The reading is returned alongside the verdict rather than folded into
 * it because "the host was too loaded" and "this host cannot say how
 * loaded it is" are different facts that the caller must journal on
 * different lines: one is a decision not to run, the other is a gate
 * that did not evaluate while the lane ran anyway.
 */
export interface MaintenanceGateDecision {
  readonly verdict: MaintenanceVerdict;
  /** Absent unless the host-pressure gate was reached and configured. */
  readonly pressure?: HostPressureReading;
}

/** Cap for persisted per-task error strings (journal + results). */
const LANE_ERROR_MAX_BYTES = 4096;

export interface MaintenanceTask {
  readonly name: string;
  readonly run: () => Promise<void>;
}

export interface RunMaintenanceOptions extends EvaluateGatesOptions {
  readonly holder: string;
  readonly tasks: ReadonlyArray<MaintenanceTask>;
  /**
   * Bypass the window, busy and pressure gates and every streak refusal -
   * never the lease.
   */
  readonly force?: boolean;
  /**
   * Task names to attempt past their streak refusal, this run only. Every
   * gate still applies; a name that is not a registered task is the
   * caller's to reject, because only the caller knows what it registered.
   */
  readonly retryTasks?: ReadonlyArray<string>;
  readonly leaseTtlMs?: number;
}

export interface MaintenanceTaskResult {
  readonly name: string;
  readonly ok: boolean;
  readonly duration_ms: number;
  readonly error?: string;
  /** True when the task tripped its cooperative safeguard deadline. */
  readonly timed_out?: boolean;
  /** True when the failure streak refused the task instead of running it. */
  readonly refused?: true;
  /** Consecutive journaled failures behind a refusal. */
  readonly failure_streak?: number;
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

/**
 * Evaluate the soft gates; the lease is checked at run time.
 *
 * The gates are ordered cheapest-first and, more importantly,
 * least-surprising-first: window and busy decide exactly as they did
 * before this gate existed, and the host is only probed once both have
 * let the pass through. A closed earlier gate therefore leaves no
 * pressure reading, which is honest — nothing was measured.
 */
export function evaluateGates(vault: string, opts: EvaluateGatesOptions): MaintenanceGateDecision {
  if (opts.window !== undefined && !dailyWindowContains(opts.now, opts.window)) {
    return { verdict: MAINTENANCE_VERDICT.skippedWindow };
  }
  const busy = opts.busy ?? {
    minutes: MAINTENANCE_BUSY_MINUTES,
    threshold: MAINTENANCE_BUSY_THRESHOLD,
  };
  const since = new Date(opts.now.getTime() - busy.minutes * 60_000).toISOString();
  const recent = listRecallTelemetry(vault, { since });
  if (recent.length >= busy.threshold) return { verdict: MAINTENANCE_VERDICT.skippedBusy };

  if (opts.pressure === undefined) return { verdict: MAINTENANCE_VERDICT.run };
  const pressure = (opts.readPressure ?? measureHostPressure)();
  // Unmeasurable leaves the gate OPEN. Closing it would stop this vault
  // being maintained at all wherever the metric is degenerate, and
  // treating the degenerate reading as a number would report a loaded
  // host as an idle one - which is the failure the reading exists to
  // make impossible. The caller journals the reason.
  if (pressure.state === HOST_PRESSURE.measured && pressure.percent >= opts.pressure.percent) {
    return { verdict: MAINTENANCE_VERDICT.skippedPressure, pressure };
  }
  return { verdict: MAINTENANCE_VERDICT.run, pressure };
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
  // Vault-side policy: the pressure threshold the caller did not name,
  // and the streak limit. An unreadable `_brain.yaml` raises here rather
  // than resolving to defaults - both knobs decide whether heavy work
  // starts, so a silent revert would run a pass the operator had gated.
  const policy = loadMaintenanceConfigSafe(vault);
  if (opts.force !== true) {
    const gate: EvaluateGatesOptions = {
      now: opts.now,
      ...(opts.window !== undefined ? { window: opts.window } : {}),
      ...(opts.busy !== undefined ? { busy: opts.busy } : {}),
      ...(opts.readPressure !== undefined ? { readPressure: opts.readPressure } : {}),
      ...resolvePressureGate(opts.pressure, policy.host_pressure_percent),
    };
    const decision = evaluateGates(vault, gate);
    // Two lines, never one: a gate that could not evaluate is its own
    // row, so the journal never leaves an operator to infer from a
    // running lane that the pressure gate was open because the host was
    // quiet.
    if (decision.pressure?.state === HOST_PRESSURE.unmeasurable) {
      appendJournal(vault, {
        ts: nowIso,
        holder: opts.holder,
        verdict: MAINTENANCE_VERDICT.pressureUnmeasurable,
        pressure_reason: decision.pressure.reason,
      });
    }
    if (decision.verdict !== MAINTENANCE_VERDICT.run) {
      appendJournal(vault, {
        ts: nowIso,
        holder: opts.holder,
        verdict: decision.verdict,
        ...(decision.pressure?.state === HOST_PRESSURE.measured
          ? { pressure_percent: decision.pressure.percent }
          : {}),
      });
      return { verdict: decision.verdict, tasks: [] };
    }
  }

  const ttl = opts.leaseTtlMs ?? MAINTENANCE_LEASE_TTL_MS;
  if (!acquireLease(vault, { holder: opts.holder, ttlMs: ttl, now: opts.now })) {
    appendJournal(vault, {
      ts: nowIso,
      holder: opts.holder,
      verdict: MAINTENANCE_VERDICT.skippedLease,
    });
    return { verdict: MAINTENANCE_VERDICT.skippedLease, tasks: [] };
  }

  try {
    const ordered = orderStaleFirst(vault, opts.tasks);
    const retry = new Set(opts.retryTasks ?? []);
    const results: MaintenanceTaskResult[] = [];
    for (const task of ordered) {
      const refusal =
        opts.force === true || retry.has(task.name)
          ? undefined
          : refuseOnStreak(vault, task.name, policy.failure_streak_limit);
      if (refusal !== undefined) {
        results.push(refusal.result);
        appendJournal(vault, { ts: nowIso, holder: opts.holder, ...refusal.entry });
        continue;
      }
      const startedAt = Date.now();
      let ok = true;
      let error: string | undefined;
      let timedOut = false;
      try {
        // Sequential by design: the lane exists to serialize heavy work.
        // eslint-disable-next-line no-await-in-loop
        await task.run();
      } catch (exc) {
        ok = false;
        timedOut = exc instanceof SafeguardTimeoutError;
        // Caps keep a pathological error string from flooding the
        // journal and every status render downstream.
        error = capOutput(
          exc instanceof Error ? exc.message : String(exc),
          LANE_ERROR_MAX_BYTES,
        ).text;
      }
      const duration = Date.now() - startedAt;
      results.push({
        name: task.name,
        ok,
        duration_ms: duration,
        ...(error ? { error } : {}),
        ...(timedOut ? { timed_out: true } : {}),
      });
      appendJournal(vault, {
        ts: nowIso,
        holder: opts.holder,
        verdict: MAINTENANCE_VERDICT.run,
        task: task.name,
        ok,
        duration_ms: duration,
        ...(error ? { error } : {}),
      });
    }
    // The cap rewrite happens only here, while the lease is held -
    // the one point where no other writer can race the journal.
    sweepJournal(vault);
    return { verdict: MAINTENANCE_VERDICT.run, tasks: results };
  } finally {
    releaseLease(vault, { holder: opts.holder, name: MAINTENANCE_LEASE_NAME });
  }
}

/**
 * The pressure gate to evaluate: the caller's, else the vault's, else
 * none. There is deliberately no third source and no default number - an
 * unconfigured gate never fires.
 */
function resolvePressureGate(
  named: HostPressureGate | undefined,
  configured: number | null,
): { pressure?: HostPressureGate } {
  if (named !== undefined) return { pressure: named };
  if (configured !== null) return { pressure: { percent: configured } };
  return {};
}

/** The task-result and journal rows of a streak refusal, or `undefined` to run. */
function refuseOnStreak(
  vault: string,
  task: string,
  limit: number,
):
  | { result: MaintenanceTaskResult; entry: Omit<MaintenanceJournalEntry, "ts" | "holder"> }
  | undefined {
  const streak = consecutiveTaskFailures(vault, task);
  if (streak < limit) return undefined;
  // The number is in the message because the journal row and the task
  // result are read on different surfaces, and an operator who sees only
  // one of them still has to know how deep the hole is and how to climb
  // out of it.
  const error =
    `refused: ${streak} consecutive journaled failures reached the ` +
    `maintenance.failure_streak_limit of ${limit}; fix the cause, then re-run with ` +
    `--retry ${task} to attempt this task alone with every other gate still in force, ` +
    `or --force to run the whole lane past every soft gate`;
  return {
    result: { name: task, ok: false, duration_ms: 0, error, refused: true, failure_streak: streak },
    // No `ok` on the row: a refusal is not an attempt, and recording one
    // as a failed attempt would deepen the very streak it reports until
    // no success could ever clear it.
    entry: { verdict: MAINTENANCE_VERDICT.refusedStreak, task, streak, error },
  };
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
