/**
 * The staging guard of the review queue below local reach (moved out of
 * `pending-lanes.ts` by change `lane-reach-residuals`, package 16, design
 * R14; the rule itself is 2.0.4's): a staging for a target that an open
 * entry held in `private` already holds is refused with the fixed answer,
 * the open entries read on the fold of every partition (the write rule),
 * where a local caller is answered with that entry.
 *
 * The queue's own reads stay in `pending-lanes.ts`, handed in as
 * {@link StagedEntryReads}, so this module imports nothing from that
 * module.
 */

import { assertCreateMatchAtReach } from "../../store/lane-reach-guard.ts";
import type { ReviewLane } from "../write-gate.ts";

/** The reads of the queue the guard needs, owned by `pending-lanes.ts`. */
export interface StagedEntryReads {
  /** The folder of a lane. */
  readonly dir: (vault: string, lane: ReviewLane) => string;
  /** The `.md` files of a lane's folder. */
  readonly files: (vault: string, dir: string) => string[];
  /** One staged file, read as an entry or as a named-unreadable row. */
  readonly entry: (
    vault: string,
    lane: ReviewLane,
    path: string,
  ) => { readonly unreadableReason?: string; readonly publishTarget?: string };
}

/**
 * Below local reach, refuse with the fixed answer a staging for any of
 * `targets` that an open entry of `lane` held in `private` already holds:
 * the open entries read on the fold of every partition (the write rule),
 * where a local caller is answered with that entry. Nothing is read
 * outside that scope or with no target.
 */
export function assertStagedTargetsAtReach(
  vault: string,
  lane: ReviewLane,
  targets: ReadonlyArray<string>,
  reads: StagedEntryReads,
): void {
  if (targets.length === 0) return;
  const laneDir = reads.dir(vault, lane);
  assertCreateMatchAtReach(vault, () =>
    reads.files(vault, laneDir).filter((path) => {
      const entry = reads.entry(vault, lane, path);
      return (
        entry.unreadableReason === undefined &&
        entry.publishTarget !== undefined &&
        targets.includes(entry.publishTarget)
      );
    }),
  );
}
