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
 *   - a signal whose file name is already taken in the archive. The move
 *     never overwrites; the collision is reported as a warning instead.
 *
 * Archiving is a move of the file, byte for byte. Nothing is deleted, and the
 * archive stays readable by the provenance and history readers.
 *
 * Pure: no I/O, no clock beyond the `now` it is handed.
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
  const windowDays = cfg.dream.contradiction_window_days;
  const archivedNames = new Set(
    scan.signals.filter((r) => r.archived).map((r) => basename(r.path)),
  );
  const warnings: DreamWarning[] = [];
  for (const rec of scan.signals) {
    if (!isArchivable(rec, windowDays, now)) continue;
    const id = rec.signal.id;
    if (plan.signalsToMove.has(id) || plan.signalsToArchive.has(id)) continue;
    const name = basename(rec.path);
    if (archivedNames.has(name)) {
      warnings.push({
        code: ARCHIVE_NAME_COLLISION_CODE,
        message:
          `signal ${id} is outside the contradiction window but inbox/archived/${name} ` +
          `already exists; it stays in the inbox. Compare the two files and remove the ` +
          `duplicate by hand.`,
      });
      continue;
    }
    plan.signalsToArchive.set(id, { id, path: rec.path });
  }
  return warnings;
}

function isArchivable(rec: SignalRecord, windowDays: number, now: Date): boolean {
  return rec.active && isOutsideWindow(rec.signal.created_at, windowDays, now);
}
