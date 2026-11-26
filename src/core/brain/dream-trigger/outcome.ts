/**
 * The outcome of a live dream pass (change `dream-session-trigger`,
 * design D4, spec "A day is closed only by a complete pass" and "Every
 * live pass records the day"): every way of running a live pass (the
 * worker `o2b dream run`, the dream verb, the MCP dream tool, the
 * maintenance lane) ends here, on the owner's device, and writes the day
 * record the same way.
 *
 *  1. Complete: the pass returned, the replay is not behind, no window is
 *     open, no source has a gap, and no queued item is ready, due and
 *     answerable by an executor this machine has. The day closes.
 *  2. Complete, with ready work nothing here answers: the day closes, and
 *     the record carries a note naming the work and what would answer it.
 *  3. Anything else (a throw, the deadline, windows behind, a gap,
 *     answerable work left, a read that could not be completed): the day
 *     stays open, the failure count grows by one, and no session starts a
 *     pass before one hour after the first failure, doubling, at most one
 *     day.
 *
 * The day is the UTC day the pass started on. The record is written under
 * the pass lock (so the owner, read there, is the owner of the pass that
 * just ended, and no other pass ends between the read of the day and the
 * write) and under the record's own lock (so the failure count is the
 * record's, carried, never rebuilt). A pass refused because another one
 * held the lock, or because this device is not the owner, records
 * nothing: it was not a pass of this device's day.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { discoverConfig } from "../../config.ts";
import { isLockBusy, isLockContention } from "../../store/local-lock.ts";
import { DreamNotOwnerError, openDreamOwnerStore } from "../dream-owner/gate.ts";
import { readDreamOwner, withDreamPassLock } from "../dream-owner/owner.ts";
import {
  describeWaitingGroup,
  queueStatus,
  readyByAnswerability,
  waitingByOperation,
} from "../dream-queue/status-view.ts";
import { daysBehind, readConfiguredReplay } from "../dream-replay/behind.ts";
import { DreamReplayUnreadableError } from "../dream-replay/pass.ts";
import { isoDate } from "../time.ts";
import {
  DREAM_TRIGGER_CLAIM_GRACE_MS,
  DREAM_TRIGGER_RETRY_BASE_MS,
  DREAM_TRIGGER_RETRY_CAP_MS,
  type DreamRunBy,
} from "./constants.ts";
import { processAlive } from "../../store-migration/holder-liveness.ts";
import {
  OPERATION,
  resolveSafeguardTimeoutMs,
  SAFEGUARD_DEFAULT_TIMEOUT_SECONDS,
} from "../safeguard.ts";
import { claimMadeAt, createClaim, releaseClaim, removeClaimIf, type ClaimSeen } from "./claim.ts";
import {
  configuredTriggerStoreRoot,
  dreamTriggerClaimPath,
  dreamTriggerRecordPath,
  dreamTriggerStoreExists,
  updateDreamTriggerRecord,
  type DreamRunOutcome,
  type DreamTriggerRecord,
} from "./record.ts";

/** What the replay says after a pass; `null` for a brain the replay does not serve. */
export type ReplayFacts =
  | { readonly unreadable: string }
  | {
      readonly unreadable: null;
      readonly behind: ReadonlyArray<string>;
      readonly open: string | null;
      readonly gaps: ReadonlyArray<string>;
    }
  | null;

/** What the queue says after a pass; `null` for a brain with no queue. */
export type QueueFacts = {
  readonly unreadable: ReadonlyArray<string>;
  /** This device held the private partition and lost it: its work is unknown. */
  readonly privateUnknown: boolean;
  /** Ready, due items something here answers, by operation. */
  readonly answerable: Readonly<Record<string, number>>;
  /** Ready, due items nothing here answers, by operation. */
  readonly unanswerable: Readonly<Record<string, number>>;
} | null;

export interface DayCompletion {
  readonly complete: boolean;
  /** Why the day is not complete, in a fixed order; empty when it is. */
  readonly reasons: ReadonlyArray<string>;
  /** Ready work nothing here answers, by operation. */
  readonly unanswerable: Readonly<Record<string, number>>;
}

function count(byOp: Readonly<Record<string, number>>): number {
  return Object.values(byOp).reduce((n, k) => n + k, 0);
}

/** Whether the facts read after a pass close the day, and why not. */
export function dayCompletion(replay: ReplayFacts, queue: QueueFacts): DayCompletion {
  const reasons: string[] = [];
  if (replay !== null) {
    if (replay.unreadable !== null) {
      reasons.push(`the replay could not be read completely (${replay.unreadable})`);
    } else {
      if (replay.behind.length > 0) {
        reasons.push(
          `${replay.behind.length} window(s) behind (${replay.behind[0]} to ${replay.behind.at(-1)})`,
        );
      }
      if (replay.open !== null) reasons.push(`the window of ${replay.open} is open`);
      if (replay.gaps.length > 0) reasons.push(`sources with a gap: ${replay.gaps.join(", ")}`);
    }
  }
  if (queue !== null) {
    if (queue.unreadable.length > 0) {
      reasons.push(`the work queue could not be read completely (${queue.unreadable.join(", ")})`);
    }
    if (queue.privateUnknown) reasons.push("the private work of this device is unknown");
    const answerable = count(queue.answerable);
    if (answerable > 0) reasons.push(`${answerable} ready work item(s) this machine answers`);
  }
  return {
    complete: reasons.length === 0,
    reasons,
    unanswerable: queue?.unanswerable ?? {},
  };
}

/** The delay before the next attempt after `failures` failed passes in a row (at least one). */
export function retryDelayMs(failures: number): number {
  const n = Math.max(1, failures);
  return Math.min(DREAM_TRIGGER_RETRY_BASE_MS * 2 ** (n - 1), DREAM_TRIGGER_RETRY_CAP_MS);
}

/**
 * What a pass left in the work queue before it ended: items produced and
 * answers recorded (by the decision model or the launched agent). Each is
 * a store append made when it happened, so it outlives the pass.
 */
export interface DreamWorkKept {
  readonly produced: number;
  readonly answered: number;
}

/** Whether a pass left any work in the queue. */
export function workKept(kept: DreamWorkKept | undefined): boolean {
  return kept !== undefined && kept.produced + kept.answered > 0;
}

/**
 * Whether a pass that threw `err` ends incomplete (exit 0) rather than
 * failed, given how its ending was recorded and the work it left. Only a
 * store lock that stayed busy can, and the record decides: it says
 * incomplete for a first busy ending after work was left, failed for one
 * with no work left or for the second in a row. A recording that failed
 * leaves the previous ending unknown, so the pass is a failure: a second
 * busy ending in a row must never pass for incomplete. With nothing to
 * record (no store, no dream owner on this device) there is no retry
 * schedule, and the work left decides.
 */
export function busyLockPassIncomplete(
  err: unknown,
  recording: DreamOutcomeRecording,
  kept: DreamWorkKept,
): boolean {
  if (!isLockBusy(err)) return false;
  switch (recording.kind) {
    case "recorded":
      return recording.record.last_run?.outcome === "incomplete";
    case "failed":
      return false;
    case "skipped":
      return workKept(kept);
  }
}

/** How a pass ended, as its caller saw it. */
export type DreamPassEnd =
  | { readonly kind: "returned"; readonly completion: DayCompletion; readonly note: string | null }
  | { readonly kind: "threw"; readonly message: string }
  /**
   * A store lock stayed busy past the pass's wait after the pass had left
   * work in the queue (`kept`): that work stays, so the day is incomplete,
   * not failed. A busy lock met before any work was left is `threw`.
   */
  | { readonly kind: "lock-busy"; readonly message: string; readonly kept: DreamWorkKept };

/** How the reason of a pass that stopped at a busy store lock starts. */
const LOCK_BUSY_REASON = "the pass stopped at a busy store lock";

function lockBusyReason(end: { readonly message: string; readonly kept: DreamWorkKept }): string {
  return (
    `${LOCK_BUSY_REASON}; kept in the work queue: ${end.kept.produced} item(s) produced, ` +
    `${end.kept.answered} answer(s) recorded (the next pass applies them): ${end.message}`
  );
}

/** Whether the run `previous` records also stopped at a busy store lock. */
function previousStoppedAtBusyLock(previous: DreamTriggerRecord): boolean {
  return (
    previous.last_run?.outcome === "incomplete" &&
    (previous.reason ?? "").startsWith(LOCK_BUSY_REASON)
  );
}

/**
 * The record after a pass that started at `startedAt` and ended at
 * `endedAt` with `end`, from the record as it was (`previous`). A pass of
 * an earlier day than the one the record holds leaves that day as it is
 * and records only the attempt and its retry time.
 */
export function decideDayOutcome(input: {
  readonly previous: DreamTriggerRecord;
  readonly startedAt: Date;
  readonly endedAt: Date;
  readonly by: DreamRunBy;
  readonly end: DreamPassEnd;
}): DreamTriggerRecord | null {
  const { previous, startedAt, endedAt, by } = input;
  // A store lock still busy in the next pass is stuck, not a passing
  // contention: that pass failed, whatever it left.
  const end: DreamPassEnd =
    input.end.kind === "lock-busy" && previousStoppedAtBusyLock(previous)
      ? {
          kind: "threw",
          message: `a store lock stayed busy in two passes in a row: ${input.end.message}`,
        }
      : input.end;
  const day = isoDate(startedAt);
  const run = (outcome: DreamRunOutcome) => ({
    started_at: startedAt.toISOString(),
    ended_at: endedAt.toISOString(),
    outcome,
    by,
  });
  if (previous.day !== null && previous.day > day) {
    // The record's day is ahead of this pass's clock (a clock set back):
    // the pass does not touch that day, but it is an attempt, so the next
    // one waits its retry delay instead of starting at every session.
    const outcome: DreamRunOutcome =
      end.kind === "threw"
        ? "failed"
        : end.kind === "lock-busy" || !end.completion.complete
          ? "incomplete"
          : "complete";
    return {
      ...previous,
      last_run: run(outcome),
      retry_at: new Date(endedAt.getTime() + retryDelayMs(previous.failures)).toISOString(),
    };
  }
  if (end.kind === "returned" && end.completion.complete) {
    const waiting = count(end.completion.unanswerable) > 0;
    return {
      ...previous,
      day,
      closed: true,
      reason: waiting ? "work waits that nothing on this machine answers" : null,
      note: waiting ? end.note : null,
      last_run: run(waiting ? "complete-unanswerable" : "complete"),
      failures: 0,
      retry_at: null,
      open_since: null,
      // The owner's note is shown at the next session start, once a day.
      line: waiting && end.note !== null ? { shown_day: null, text: end.note } : NO_LINE,
    };
  }
  const failures = previous.failures + 1;
  return {
    ...previous,
    day,
    closed: false,
    reason:
      end.kind === "threw"
        ? `the pass failed: ${end.message}`
        : end.kind === "lock-busy"
          ? lockBusyReason(end)
          : end.completion.reasons.join("; "),
    note: null,
    last_run: run(end.kind === "threw" ? "failed" : "incomplete"),
    failures,
    retry_at: new Date(endedAt.getTime() + retryDelayMs(failures)).toISOString(),
    open_since: previous.open_since ?? endedAt.toISOString(),
    line: NO_LINE,
  };
}

const NO_LINE = Object.freeze({ shown_day: null, text: null });

/** The replay facts of the configured store after a pass started at `at`. */
export function readReplayFacts(
  vault: string | null,
  configPath: string | undefined,
  at: Date,
): ReplayFacts {
  let state: ReturnType<typeof readConfiguredReplay>;
  try {
    state = readConfiguredReplay(vault, configPath);
  } catch (err) {
    if (err instanceof DreamReplayUnreadableError) return { unreadable: err.shards.join(", ") };
    throw err;
  }
  if (state === null) return null;
  const latest = state.latestAdmission?.body ?? null;
  return {
    unreadable: null,
    behind: daysBehind(state, at),
    open: state.open?.body.window ?? null,
    gaps: [...(latest?.gaps ?? []), ...(latest?.left_out ?? [])].map(
      (g) => `${g.partition}/${g.shard}`,
    ),
  };
}

/**
 * The queue facts of the configured store, with the note naming the work
 * nothing here answers and what would answer it (`null` when none waits).
 */
export function readQueueFacts(
  vault: string | null,
  configPath: string | undefined,
  now: number,
  env: Readonly<Record<string, string | undefined>> = process.env,
): { readonly facts: QueueFacts; readonly note: string | null } {
  const configOpt = configPath !== undefined ? { configPath } : {};
  const status = queueStatus(vault, { ...configOpt, now });
  if (!status.available) return { facts: null, note: null };
  // Per item, by why it waits: a use in shadow or private evidence the
  // chain may not receive is not answered by another pass.
  const { answerable, unanswerable } = readyByAnswerability(status, { ...configOpt, env, now });
  const facts = {
    unreadable: status.unreadable,
    privateUnknown: status.private === "unknown",
    answerable,
    unanswerable,
  };
  if (Object.keys(unanswerable).length === 0) return { facts, note: null };
  const groups = waitingByOperation(status, { ...configOpt, env, now }).filter(
    (g) => unanswerable[g.operation] !== undefined,
  );
  const note =
    "Dream closed the day with work nothing on this machine answers: " +
    groups.map((g) => describeWaitingGroup(g)).join("; ") +
    ".";
  return { facts, note };
}

/**
 * Hold the trigger's claim for a whole live pass this process runs
 * itself (the dream verb, the MCP dream tool, the maintenance lane, `o2b
 * dream run` without `--claim`), so a session's day check does not start
 * a second front door beside it, and so this run does not start one
 * beside a pass already running (spec "nor while another pass is
 * running").
 *
 * A claim already there that still stands (its worker lives, or a day
 * check started its worker a moment ago) refuses the run before anything
 * of it runs: a {@link DreamRunClaimHeldError}, which is lock contention
 * (`ELOCKED`) as the pass lock reports it, naming the running pass. A
 * claim whose holder is gone is removed and taken. A claim that cannot be
 * made for another reason (a folder that refuses it) leaves the pass to
 * run as it would; no claim is kept for a store root that holds no store.
 * Returns the release, which never throws.
 */
export function holdDreamRunClaim(
  configPath: string | undefined,
  now: () => number = Date.now,
): () => void {
  let path: string;
  let grace: number;
  try {
    const storeRoot = configuredTriggerStoreRoot(discoverConfig(configPath));
    if (!dreamTriggerStoreExists(storeRoot)) return NO_RELEASE;
    path = dreamTriggerClaimPath(dreamTriggerRecordPath(storeRoot));
    grace = runClaimGraceMs(configPath);
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    return NO_RELEASE;
  }
  // Two tries: a claim whose holder is gone is removed, then taken.
  for (let attempt = 0; attempt < 2; attempt++) {
    let token: string | null;
    try {
      token = createClaim(path, now(), process.pid);
    } catch {
      return NO_RELEASE;
    }
    if (token !== null) return releaseOf(path, token);
    const judged: { standing: ClaimSeen | null } = { standing: null };
    try {
      removeClaimIf(path, (seen) => {
        if (seen.kind === "absent") return false;
        if (runClaimStands(seen, now(), grace)) judged.standing = seen;
        return judged.standing === null;
      });
    } catch (err) {
      // Another process holds the claim's own lock past the wait: it is
      // working with the claim now, so the claim is held.
      if (isLockContention(err)) throw new DreamRunClaimHeldError(path, null);
      return NO_RELEASE;
    }
    if (judged.standing !== null) throw new DreamRunClaimHeldError(path, judged.standing);
  }
  throw new DreamRunClaimHeldError(path, null);
}

const NO_RELEASE = (): void => {};

function releaseOf(path: string, token: string): () => void {
  return () => {
    try {
      releaseClaim(path, token);
    } catch {
      // remembered: this process's next claim gives it back first
    }
  };
}

/** How long a claim made by a day check may wait for its worker (the day check's rule). */
function runClaimGraceMs(configPath: string | undefined): number {
  const deadline =
    resolveSafeguardTimeoutMs(OPERATION.dream, configPath) ??
    SAFEGUARD_DEFAULT_TIMEOUT_SECONDS * 1000;
  return deadline + DREAM_TRIGGER_CLAIM_GRACE_MS;
}

/**
 * Whether a claim already there still stands for a run that wants its own:
 * its worker (the pid it wrote) lives; or no worker has proved it yet and
 * its maker started one within the start window, or the maker still lives
 * within the pass deadline; or it was read whole, is not a claim, and is
 * younger than the deadline; or it cannot be read now. Anything else was
 * left by a holder that is gone.
 */
export function runClaimStands(
  seen: Exclude<ClaimSeen, { kind: "absent" }>,
  nowMs: number,
  grace: number,
): boolean {
  if (seen.kind === "inconclusive") return true;
  const age = nowMs - claimMadeAt(seen);
  if (seen.kind === "unreadable") return age < grace;
  const { claim } = seen;
  if (claim.worker_pid !== null) return processAlive(claim.worker_pid);
  return age < DREAM_TRIGGER_CLAIM_GRACE_MS || (age < grace && processAlive(claim.pid));
}

/**
 * A whole live run refused because another one holds the trigger's claim:
 * lock contention, reported as the pass lock reports it.
 */
export class DreamRunClaimHeldError extends Error {
  readonly code = "ELOCKED";
  readonly path: string;
  constructor(path: string, seen: ClaimSeen | null) {
    super(
      `dream run claim busy: ${path}: ${describeClaimHolder(seen)}; ` +
        "retry once the dream pass finishes",
    );
    this.name = "DreamRunClaimHeldError";
    this.path = path;
  }
}

function describeClaimHolder(seen: ClaimSeen | null): string {
  if (seen === null || seen.kind === "absent") {
    return "another dream pass on this machine is taking the claim now";
  }
  if (seen.kind === "inconclusive") {
    return "a dream pass on this machine holds it; the claim cannot be read now";
  }
  const since = new Date(claimMadeAt(seen)).toISOString();
  if (seen.kind === "unreadable") return `a dream pass on this machine holds it since ${since}`;
  const { claim } = seen;
  return claim.worker_pid !== null
    ? `a dream pass run by process ${claim.worker_pid} holds it since ${since}`
    : `a dream pass started by process ${claim.pid} holds it since ${since}; its worker is starting`;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface RecordDreamOutcomeOptions {
  readonly configPath?: string;
  /** Wall clock when the pass started (its day is the day closed). */
  readonly startedAt: Date;
  /** The pass's result, or what it threw. */
  readonly result: { readonly returned: true } | { readonly threw: unknown };
  /**
   * What the pass left in the work queue before it threw. A pass that
   * stopped at a busy store lock is incomplete only when it left some;
   * otherwise (or when this is absent) it failed.
   */
  readonly kept?: DreamWorkKept;
  readonly by: DreamRunBy;
  /** Clock of the end (default `Date.now`). */
  readonly now?: () => number;
}

/**
 * Record the outcome of a live pass of `vault` on this device. Returns
 * the record written, or `null` when nothing was recorded: a refusal, a
 * device that is not the owner, a brain with no store or no owner, a
 * pass lock another pass holds (that pass records its own), or a
 * recording that could not be made. Never throws: the pass's own result
 * stands.
 */
export function recordDreamOutcome(
  vault: string | null,
  options: RecordDreamOutcomeOptions,
): DreamTriggerRecord | null {
  const recorded = recordDreamOutcomeResult(vault, options);
  return recorded.kind === "recorded" ? recorded.record : null;
}

/** What recording a pass's outcome did. */
export type DreamOutcomeRecording =
  /** The day record was written. */
  | { readonly kind: "recorded"; readonly record: DreamTriggerRecord }
  /** Nothing to record: a refusal, not the owner, no store, no owner, another pass's lock. */
  | { readonly kind: "skipped" }
  /** The recording failed: the day of a pass that ran is not recorded. */
  | { readonly kind: "failed"; readonly message: string };

const SKIPPED: DreamOutcomeRecording = Object.freeze({ kind: "skipped" });

/**
 * {@link recordDreamOutcome}, saying whether nothing was to be recorded
 * or the recording failed, for a caller that keeps the trigger's claim
 * when a pass that ran left no record (`o2b dream run --claim`). Never
 * throws.
 */
export function recordDreamOutcomeResult(
  vault: string | null,
  options: RecordDreamOutcomeOptions,
): DreamOutcomeRecording {
  const { result } = options;
  if ("threw" in result) {
    // The dream pass lock another pass holds: that pass records its own.
    // A store lock that stayed busy is this pass's ending, recorded below.
    if (
      result.threw instanceof DreamNotOwnerError ||
      (isLockContention(result.threw) && !isLockBusy(result.threw))
    ) {
      return SKIPPED;
    }
  }
  try {
    const opened = openDreamOwnerStore(vault, options.configPath);
    if (opened.store === null) return SKIPPED;
    const store = opened.store;
    if (!store.partitions.has("shared")) return SKIPPED;
    const config = discoverConfig(options.configPath);
    const storeRoot = configuredTriggerStoreRoot(config);
    const path = dreamTriggerRecordPath(storeRoot);
    const now = options.now ?? Date.now;
    const written = withDreamPassLock(store, () => {
      const owner = readDreamOwner(store).owner;
      if (owner === null || owner.device !== store.device) return null;
      const endedAt = new Date(now());
      let end: DreamPassEnd;
      if ("threw" in result) {
        const kept = options.kept;
        end =
          isLockBusy(result.threw) && kept !== undefined && workKept(kept)
            ? { kind: "lock-busy", message: message(result.threw), kept }
            : { kind: "threw", message: message(result.threw) };
      } else {
        try {
          const queue = readQueueFacts(vault, options.configPath, endedAt.getTime());
          const completion = dayCompletion(
            readReplayFacts(vault, options.configPath, options.startedAt),
            queue.facts,
          );
          end = { kind: "returned", completion, note: queue.note };
        } catch (err) {
          // Unknown is not complete: the day stays open.
          end = {
            kind: "returned",
            completion: {
              complete: false,
              reasons: [`the state after the pass could not be read (${message(err)})`],
              unanswerable: {},
            },
            note: null,
          };
        }
      }
      return updateDreamTriggerRecord(path, storeRoot, (previous) =>
        decideDayOutcome({
          previous: {
            ...previous,
            owner: {
              device: owner.device,
              agent: owner.agent,
              revision: owner.revision,
              mine: true,
            },
          },
          startedAt: options.startedAt,
          endedAt,
          by: options.by,
          end,
        }),
      );
    });
    return written === null ? SKIPPED : { kind: "recorded", record: written };
  } catch (err) {
    return { kind: "failed", message: message(err) };
  }
}
