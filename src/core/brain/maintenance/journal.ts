/**
 * Maintenance run journal (write-time-integrity-governance,
 * t_166d1226): bounded append-only JSONL in the vault-local state
 * dir. Every attempt lands here - including gate refusals - so the
 * operator can see WHY the quiet-window lane did or did not run
 * without trusting silence. Newest-N retention with an explicit
 * sweep on append, matching the activation-store discipline.
 */

import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { assertVaultIdentityForWrite } from "../vault-identity.ts";
import type { HostPressureUnmeasurableReason } from "./host-pressure.ts";

export const MAINTENANCE_JOURNAL_CAP = 500;

/**
 * What one journal row records.
 *
 * A closed vocabulary rather than a bare union because these values are
 * persisted to `.open-second-brain/maintenance-runs.jsonl` and read back
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
  /** Host pressure the gate read, on a `skipped:pressure` row. */
  readonly pressure_percent?: number;
  /** Why the gate could not read one, on a `pressure:unmeasurable` row. */
  readonly pressure_reason?: HostPressureUnmeasurableReason;
  /** Consecutive journaled failures behind a `refused:streak` row. */
  readonly streak?: number;
}

function journalPath(vault: string): string {
  return join(vault, ".open-second-brain", "maintenance-runs.jsonl");
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
  renameSync(tmp, path);
}

/** Journal entries, newest first. Unparseable lines are skipped. */
export function listJournal(vault: string, limit?: number): MaintenanceJournalEntry[] {
  const lines = readLines(journalPath(vault));
  const out: MaintenanceJournalEntry[] = [];
  for (const line of lines) {
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        out.push(parsed as MaintenanceJournalEntry);
      }
    } catch {
      // Fail-soft: a torn line never breaks the journal read.
    }
  }
  out.reverse();
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
