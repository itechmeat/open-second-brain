/**
 * Trigger creation a call below local reach starts (change
 * `lane-private-partition-reach`, the write rule).
 *
 * Creating triggers from findings is maintenance of the machine's own
 * queue: each candidate is deduplicated against the newest trigger of its
 * cooldown key, held back by a dismissal or a cooldown, and recorded as a
 * recurrence on that trigger. Decided from a fold that cannot show a
 * `private` trigger, a finding the operator dismissed or holds open in
 * `private` would be queued again in `shared`. So the creation runs on the
 * fold of every partition, whatever the caller's reach, exactly as a local
 * call does, and only the answer is narrowed: a created trigger held in
 * `private` is left out, a skip is kept only when a trigger of its key is
 * shown to the caller, and an unreadable record held in `private` is not
 * named.
 */

import { privateWithheld, withPrivateShown } from "../../store/caller-reach.ts";
import { laneEntryInPrivate } from "../../store/lane-pages.ts";
import {
  createTriggers,
  readTriggers,
  type CreateTriggersOptions,
  type CreateTriggersResult,
} from "./store.ts";
import type { InsightCandidate } from "./types.ts";

/** {@link createTriggers} on the fold of every partition; its answer narrowed below local reach. */
export function createTriggersAtReach(
  vault: string,
  candidates: ReadonlyArray<InsightCandidate>,
  opts: CreateTriggersOptions,
): CreateTriggersResult {
  const narrow = privateWithheld();
  const result = withPrivateShown(() => createTriggers(vault, candidates, opts));
  if (!narrow) return result;
  const shownKeys = new Set(
    readTriggers(vault, { now: opts.now }).records.map((r) => r.cooldownKey),
  );
  return {
    created: result.created.filter((record) => !laneEntryInPrivate(vault, record.path)),
    skipped: result.skipped.filter((skip) => shownKeys.has(skip.cooldownKey)),
    unreadable: result.unreadable.filter((u) => !laneEntryInPrivate(vault, u.path)),
  };
}
