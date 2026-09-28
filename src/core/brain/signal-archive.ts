/**
 * Inbox archive policy (issue #195): which inbox signals can no longer
 * become candidates, and so leave `Brain/inbox/` for `Brain/inbox/archived/`.
 *
 * ## The rule
 *
 * An inbox signal is archivable when its `created_at` parses and lies
 * strictly before `now - dream.contradiction_window_days`.
 *
 * That is exactly the complement of `filterWithinWindow`, the filter every
 * counting path of the dream pass goes through: promotion, redundancy,
 * rebuttal and the contradiction classifier all count windowed signals only.
 * A signal outside the window therefore contributes to no candidate, and
 * because time only moves forward it never will again. Singletons, topics
 * below the promotion threshold, quarantined clusters and contended keys all
 * reduce to this one rule: while a signal is inside the window it stays,
 * whatever its topic's state, and once it has left the window no state of
 * its topic can make it count.
 *
 * Deliberately NOT archivable:
 *
 *   - a signal whose `created_at` does not parse. It can never count either,
 *     but it is malformed, and moving it would hide the defect from the
 *     doctor checks that report it;
 *   - a signal past its `expiration_date` but still inside the window. The
 *     dream pass does not read `expiration_date` (expiry filters READ
 *     surfaces, see `expiration.ts`), so such a signal still counts toward a
 *     candidate today, and archiving it would change a promotion outcome.
 *     Once it leaves the window it is archived like any other;
 *   - a signal the same pass consumes (promotes, notes redundant, suppresses
 *     or spends on a rebuttal). Those go to `processed/` as before;
 *   - a signal whose file name is already taken in the archive, by any
 *     entry of `inbox/archived/` (a tombstoned or unparseable file there
 *     takes the name as much as a live one). The move never overwrites; the
 *     collision is reported as a warning instead and plans nothing;
 *   - a tombstoned inbox signal. The scan never reads one, so it is not a
 *     candidate and not a record the plan can move. A tombstone is an
 *     operator decision about that file, recorded in place, and tombstones
 *     are bounded by operator actions rather than by capture volume, so the
 *     inbox stays bounded without moving them.
 *
 * ## The clock
 *
 * The rule runs against `min(now, wall clock)` ({@link archiveClock}). A
 * pass run with `--now` in the future plans promotions for that instant,
 * but a move to the archive is not undone by a later pass, so it never
 * archives a signal that is still inside the window at the real time.
 *
 * Archiving is a move of the file, byte for byte. Nothing is deleted, and the
 * archive stays readable by the provenance and history readers.
 *
 * Pure: no I/O. The only clock read is {@link archiveClock}'s default
 * wall clock, which a caller can inject.
 */

import { basename } from "node:path";

import type { PlanState, ScanResult, SignalRecord } from "./dream-plan.ts";
import type { DreamWarning } from "./dream-types.ts";
import type { BrainConfig } from "./types.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Warning code for an inbox signal whose archive name is already taken. */
export const ARCHIVE_NAME_COLLISION_CODE = "archive-name-collision";

/** Whether the archive step is enabled; absent means enabled. */
export function archiveEnabled(cfg: BrainConfig): boolean {
  return cfg.dream.archive_stale_signals !== false;
}

/**
 * Whether one signal's `created_at` lies outside the contradiction window.
 * The exact complement of `filterWithinWindow` for a parseable timestamp;
 * an unparseable one is neither inside nor archivable.
 */
export function isOutsideWindow(createdAt: string, windowDays: number, now: Date): boolean {
  const t = Date.parse(createdAt);
  if (!Number.isFinite(t)) return false;
  return t < now.getTime() - windowDays * DAY_MS;
}

/**
 * The instant the archive rule runs against: `now`, or the wall clock when
 * `now` lies ahead of it (see "The clock" above).
 */
export function archiveClock(now: Date, wallClock: Date = new Date()): Date {
  return now.getTime() > wallClock.getTime() ? wallClock : now;
}

/** The archive rule's verdict over a set of signal records. */
export interface ArchiveSelection {
  /** Active inbox signals the rule archives, in record order. */
  readonly archivable: ReadonlyArray<SignalRecord>;
  /** Active inbox signals the rule would archive but whose name is taken. */
  readonly collisions: ReadonlyArray<SignalRecord>;
}

/**
 * Apply the archive rule to `signals`: every active record whose
 * `created_at` lies outside the window at {@link archiveClock}`(now)`,
 * split by whether its file name is free in the archive. `archivedNames`
 * is the listing of `inbox/archived/`, every entry of it.
 *
 * The one selection both the dream plan and the `inbox-archivable` doctor
 * check go through, so the doctor's count is what a dry run archives less
 * the signals that pass consumes instead.
 */
export function selectArchivableSignals(
  signals: ReadonlyArray<SignalRecord>,
  archivedNames: ReadonlySet<string>,
  windowDays: number,
  now: Date,
): ArchiveSelection {
  const clock = archiveClock(now);
  const archivable: SignalRecord[] = [];
  const collisions: SignalRecord[] = [];
  for (const rec of signals) {
    if (!rec.active || !isOutsideWindow(rec.signal.created_at, windowDays, clock)) continue;
    if (archivedNames.has(basename(rec.path))) collisions.push(rec);
    else archivable.push(rec);
  }
  return { archivable, collisions };
}

/**
 * Plan the archive step onto `plan.signalsToArchive`. Runs after the topic
 * plan, so a signal the pass consumes is never archived. Returns the
 * warnings the step raised (name collisions).
 */
export function planSignalArchive(
  scan: ScanResult,
  cfg: BrainConfig,
  now: Date,
  plan: PlanState,
): DreamWarning[] {
  if (!archiveEnabled(cfg)) return [];
  const { archivable, collisions } = selectArchivableSignals(
    scan.signals,
    scan.archivedNames ?? archivedRecordNames(scan),
    cfg.dream.contradiction_window_days,
    now,
  );
  const consumed = (rec: SignalRecord): boolean =>
    plan.signalsToMove.has(rec.signal.id) || plan.signalsToArchive.has(rec.signal.id);
  const warnings: DreamWarning[] = [];
  for (const rec of collisions) {
    if (consumed(rec)) continue;
    const name = basename(rec.path);
    warnings.push({
      code: ARCHIVE_NAME_COLLISION_CODE,
      message:
        `signal ${rec.signal.id} is outside the contradiction window but inbox/archived/${name} ` +
        `already exists; it stays in the inbox. Compare the two files and remove the ` +
        `duplicate by hand.`,
    });
  }
  for (const rec of archivable) {
    if (consumed(rec)) continue;
    const id = rec.signal.id;
    plan.signalsToArchive.set(id, { id, path: rec.path });
  }
  return warnings;
}

/**
 * Fallback for a scan built without a directory listing (a hand-made
 * fixture): the names of the archived records it holds.
 */
function archivedRecordNames(scan: ScanResult): ReadonlySet<string> {
  return new Set(scan.signals.filter((r) => r.archived).map((r) => basename(r.path)));
}
