/**
 * Maintenance run journal (write-time-integrity-governance,
 * t_166d1226): bounded append-only JSONL in the vault-local state
 * dir. Every attempt lands here - including gate refusals - so the
 * operator can see WHY the quiet-window lane did or did not run
 * without trusting silence. Newest-N retention with an explicit
 * sweep on append, matching the activation-store discipline.
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  interleaveShardRows,
  JSONL_LEDGER_EXT,
  jsonlLedgerGrammar,
  readShardLinesByShard,
  resolveAppendShardId,
  shardedFileName,
} from "../ledger-shards.ts";
import { DERIVED_STORE_DIR } from "../path-constants.ts";
import { assertVaultIdentityForWrite } from "../vault-identity.ts";
import type { HostPressureUnmeasurableReason } from "./host-pressure.ts";
import { renameWithRetry } from "../../fs-atomic.ts";

export const MAINTENANCE_JOURNAL_CAP = 500;

/**
 * What one journal row records.
 *
 * A closed vocabulary rather than a bare union because these values are
 * persisted to `.open-second-brain/maintenance-runs[.<deviceId>].jsonl` and read back
 * by whichever build runs next - across an upgrade, that is not the build
 * that wrote them. The guard is the boundary for a row this build does
 * not understand.
 *
 * Two of the members are not decisions about whether to run:
 * `pressure:unmeasurable` is a NOTICE that a gate could not evaluate, and
 * it is emitted on its own line beside the decision, never instead of it.
 * `refused:streak` is a per-task refusal, so it appears among the task
 * rows rather than in place of them.
 */
export const MAINTENANCE_VERDICT = Object.freeze({
  /** The gates were open; the row's task ran (or the lane ran). */
  run: "run",
  skippedWindow: "skipped:window",
  skippedBusy: "skipped:busy",
  /** Host pressure was measured and stood at or above the configured percentage. */
  skippedPressure: "skipped:pressure",
  skippedLease: "skipped:lease",
  /** This task has failed too many times in a row to retry unforced. */
  refusedStreak: "refused:streak",
  /** The host-pressure gate could not evaluate; it was left open. */
  pressureUnmeasurable: "pressure:unmeasurable",
});

export const MAINTENANCE_VERDICTS: ReadonlyArray<string> = Object.freeze(
  Object.values(MAINTENANCE_VERDICT),
);

export type MaintenanceVerdict = (typeof MAINTENANCE_VERDICT)[keyof typeof MAINTENANCE_VERDICT];

export function isMaintenanceVerdict(value: unknown): value is MaintenanceVerdict {
  return typeof value === "string" && MAINTENANCE_VERDICTS.includes(value);
}

export interface MaintenanceJournalEntry {
  readonly ts: string;
  readonly holder: string;
  readonly verdict: MaintenanceVerdict;
  /** Present on per-task rows; absent on lane-level gate-refusal rows. */
  readonly task?: string;
  readonly ok?: boolean;
  readonly duration_ms?: number;
  readonly error?: string;
  /**
   * True on a failed row whose task hit its safeguard deadline. Journaled
   * and reported like any failure, but not counted toward the streak that
   * refuses the task: a pass that ran out of time is not a broken pass,
   * and refusing it would stop the keyword index from refreshing at all.
   */
  readonly timed_out?: boolean;
  /** Host pressure the gate read, on a `skipped:pressure` row. */
  readonly pressure_percent?: number;
  /** Why the gate could not read one, on a `pressure:unmeasurable` row. */
  readonly pressure_reason?: HostPressureUnmeasurableReason;
  /** Consecutive journaled failures behind a `refused:streak` row. */
  readonly streak?: number;
  /**
   * Model spend the task's run accounted for, on a row whose pass
   * completed and returned a receipt (t_9d155d0e). Priced by the cost
   * kernel before the provider was called; `forced` is true only when a
   * `--force-cost` bypass overrode a positive gate that would have
   * blocked the run. A failed attempt records no receipt: the spend of a
   * pass killed mid-flight is unmeasured, and the row says so by
   * carrying the failure without one.
   */
  readonly receipt?: MaintenanceSpendReceipt;
}

/**
 * What one model-spending pass spent, as the cost kernel priced it
 * before the provider was called. Lives beside the journal entry it
 * persists on, because the row is the audit unit the lane renders - and
 * journal.ts is the lower layer both the lane and its surfaces already
 * read, so the shape cannot grow a second definition.
 */
export interface MaintenanceSpendReceipt {
  /** The model the pass named; null when the config leaves it unset. */
  readonly model: string | null;
  readonly tokens: number;
  readonly estimatedUsd: number;
  /** True when `--force-cost` overrode a positive gate that would have blocked the run. */
  readonly forced: boolean;
}

/**
 * The metrics surface a completed reindex pass's spend receipt is
 * recorded under. Both lane front doors (`o2b brain maintenance` and
 * `brain_maintenance`) append here, so one surface name covers a run's
 * spend whatever door ran it.
 */
export const MAINTENANCE_SPEND_METRIC = "maintenance_spend";

/** The journal's shard stem: `maintenance-runs[.<deviceId>].jsonl`. */
export const MAINTENANCE_JOURNAL_STEM = "maintenance-runs";

/** The journal's file-name layout, handed to the shared shard grammar. */
const JOURNAL_GRAMMAR = jsonlLedgerGrammar(MAINTENANCE_JOURNAL_STEM);

/**
 * The journal file THIS device appends to, and the only shard the cap
 * sweep rewrites: `maintenance-runs[.<deviceId>].jsonl` (t_774dea61). The
 * empty device id yields the legacy un-sharded name.
 */
function journalPath(vault: string): string {
  return join(
    vault,
    DERIVED_STORE_DIR,
    shardedFileName(MAINTENANCE_JOURNAL_STEM, resolveAppendShardId(), JSONL_LEDGER_EXT),
  );
}

export function appendJournal(vault: string, entry: MaintenanceJournalEntry): void {
  // Vault-identity write guard (context-integrity-gates, Unit J).
  assertVaultIdentityForWrite(vault);
  const path = journalPath(vault);
  mkdirSync(dirname(path), { recursive: true });
  // O_APPEND, one line per call: concurrent gate-refusal writers
  // (which run BEFORE the lease is held) interleave instead of
  // overwriting each other through a read-modify-rewrite race. The
  // cap is enforced separately by `sweepJournal`, which runMaintenance
  // calls while it holds the lease - the only safe rewrite point.
  appendFileSync(path, JSON.stringify(entry) + "\n");
}

/** Trim the journal to the newest `cap` lines. Lease-holder only. */
export function sweepJournal(vault: string, cap: number = MAINTENANCE_JOURNAL_CAP): void {
  // Vault-identity write guard (context-integrity-gates, Unit J).
  assertVaultIdentityForWrite(vault);
  const path = journalPath(vault);
  const lines = readLines(path);
  if (lines.length <= cap) return;
  const kept = lines.slice(lines.length - cap);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, kept.join("\n") + "\n");
  renameWithRetry(tmp, path);
}

/**
 * When a row was written, as the merge orders it. A row whose stamp does
 * not parse sorts as the oldest, so it can never displace a readable row
 * from the head of the newest-first list.
 */
function entryTime(entry: MaintenanceJournalEntry): number {
  const time = Date.parse(entry.ts);
  return Number.isFinite(time) ? time : Number.NEGATIVE_INFINITY;
}

/** One journal line as an entry, or `null` for a torn or non-object line. */
function parseEntry(line: string): MaintenanceJournalEntry | null {
  try {
    const parsed: unknown = JSON.parse(line);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as MaintenanceJournalEntry)
      : null;
  } catch {
    // Fail-soft: a torn line never breaks the journal read.
    return null;
  }
}

/**
 * Journal entries, newest first - the one order both this list and
 * {@link consecutiveTaskFailures} walk.
 *
 * Every device's shard (t_774dea61) is interleaved by row timestamp, so a
 * failure on one device that is newer than a success on another reads as
 * newer whatever the shard names are; each shard's own append order is
 * never changed, so a single-shard vault reads exactly as before.
 * Unparseable lines are skipped.
 */
export function listJournal(vault: string, limit?: number): MaintenanceJournalEntry[] {
  const shards = readShardLinesByShard(dirname(journalPath(vault)), JOURNAL_GRAMMAR).map(
    (shard) => ({
      shardId: shard.shardId,
      rows: shard.rows.map(parseEntry).filter((entry) => entry !== null),
    }),
  );
  const out = interleaveShardRows(shards, entryTime).toReversed();
  return limit !== undefined ? out.slice(0, Math.max(0, limit)) : out;
}

/**
 * How many times in a row `task` has failed since its newest success.
 *
 * The count is the portable stand-in for a crash-loop counter: nothing in
 * this project survives an invocation except what is on disk, and the
 * journal already records every attempt with its outcome. Two properties
 * make it usable as a refusal input:
 *
 *   - a single success ENDS the count, because the walk stops at the
 *     newest row that is not a failure - a transient fault therefore
 *     cannot accumulate into a permanent refusal;
 *   - only rows that record a completed ATTEMPT are counted. A gate
 *     refusal and a lease skip are not attempts, so they cannot deepen a
 *     streak.
 *   - a failure that is a safeguard TIMEOUT (`timed_out`) is skipped: it
 *     neither deepens the streak nor ends it, so a long pass that keeps
 *     running out of budget is reported every night but never refused.
 *
 * A row that ran but recorded no outcome stops the walk as well: refusing
 * work on evidence this build cannot read is the wrong direction to err.
 *
 * ## Why a `refused:streak` row ends the walk by ADDING its own count
 *
 * This journal is a ring buffer ({@link MAINTENANCE_JOURNAL_CAP}), and a
 * lane that writes several rows per pass retires roughly a hundred passes'
 * history. Counted naively, a refused task's three `run/ok:false` rows are
 * pushed off the tail by the very refusal rows they cause, and the count
 * silently returns to zero - the refusal un-refusing itself on a schedule
 * set by how chatty the journal is, with no event anywhere.
 *
 * So the refusal row is read as what it is: the journal's own durable
 * record of the count that was reached. The walk stops there and returns
 * the failures NEWER than it plus the number it recorded, which is the
 * same total those rolled-off rows would have produced. It cannot inflate
 * a streak - a refusal reproduces the number it was given, never one more
 * - and it cannot outlive a recovery, because a success is newer than
 * every refusal it follows and stops the walk first.
 *
 * Residual, stated rather than hidden: below the limit no refusal row
 * exists, so a streak whose rows roll off is counted only from what is
 * retained. That undercount errs toward RUNNING the task, which is the
 * direction this function already errs in for an unreadable outcome.
 */
export function consecutiveTaskFailures(vault: string, task: string): number {
  let streak = 0;
  for (const entry of listJournal(vault)) {
    if (entry.task !== task) continue;
    if (entry.verdict === MAINTENANCE_VERDICT.refusedStreak) {
      // A row from a build that did not record the number carries no
      // evidence, so it is skipped rather than read as a zero.
      if (Number.isInteger(entry.streak) && (entry.streak ?? 0) >= 0) {
        return streak + (entry.streak ?? 0);
      }
      continue;
    }
    if (entry.verdict !== MAINTENANCE_VERDICT.run) continue;
    if (entry.ok !== false) break;
    // A timeout neither counts nor ends the streak: see `timed_out`.
    if (entry.timed_out === true) continue;
    streak += 1;
  }
  return streak;
}

function readLines(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0);
}
