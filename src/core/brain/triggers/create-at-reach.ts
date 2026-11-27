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
  return createTriggersCountedAtReach(vault, candidates, opts).result;
}

/**
 * {@link createTriggersAtReach}, with the number of findings whose created
 * trigger or skip the narrowed answer leaves out (`withheld`): a count the
 * caller is answered (the scan's `candidates`) leaves them out too, so it
 * agrees with what `created` and `skipped` show (change
 * `lane-reach-residuals`, design R13). Zero at local reach.
 */
export function createTriggersCountedAtReach(
  vault: string,
  candidates: ReadonlyArray<InsightCandidate>,
  opts: CreateTriggersOptions,
): { readonly result: CreateTriggersResult; readonly withheld: number } {
  const narrow = privateWithheld();
  const result = withPrivateShown(() => createTriggers(vault, candidates, opts));
  if (!narrow) return { result, withheld: 0 };
  const shownKeys = new Set(
    readTriggers(vault, { now: opts.now }).records.map((r) => r.cooldownKey),
  );
  const narrowed: CreateTriggersResult = {
    created: result.created.filter((record) => !laneEntryInPrivate(vault, record.path)),
    skipped: result.skipped.filter((skip) => shownKeys.has(skip.cooldownKey)),
    unreadable: result.unreadable.filter((u) => !laneEntryInPrivate(vault, u.path)),
  };
  const withheld =
    result.created.length -
    narrowed.created.length +
    (result.skipped.length - narrowed.skipped.length);
  return { result: narrowed, withheld };
}
