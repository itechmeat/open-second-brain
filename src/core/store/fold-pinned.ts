/**
 * The pinned context fold (design D4, task 1.6): the current-task
 * scratchpad every agent of the user shares, computed from its records.
 *
 * Input records (usually in the `events` stream):
 *
 *  - `pinned-set` `{ authority, content }`: replaces the whole pinned
 *    context with `content` (a string). An append is written as a set of
 *    the full new text, so the record says exactly what the writer saw.
 *  - `pinned-clear` `{ authority }`: a tombstone; the context is empty.
 *
 * Pinned context is one register, resolved by authority, then clock.
 * When agents on two machines replace it at nearly the same time, every
 * machine shows the replacement with the later clock; the other stays in
 * the history and can still be read from there.
 */

import { PINNED_CLEAR_KIND, PINNED_SET_KIND } from "./constants.ts";
import type { StoreRecord } from "./envelope.ts";
import {
  prepareRecords,
  recordAuthority,
  RegisterSet,
  TOMBSTONE,
  type RegisterEntry,
  type RejectedRecord,
} from "./fold.ts";

export interface PinnedFold {
  /** The current content; `null` when nothing was pinned or a clear won. */
  readonly content: string | null;
  /** Whether a clear won. */
  readonly cleared: boolean;
  /** Id of the winning record, or `null` when there are no pinned records. */
  readonly winner: string | null;
  /** Every applied pinned record in fold order, the winner included. */
  readonly history: ReadonlyArray<RegisterEntry<string>>;
  readonly rejected: ReadonlyArray<RejectedRecord>;
}

const KEY = "pinned";

function rejection(record: StoreRecord): string | null {
  if (recordAuthority(record) === null) return "missing or invalid authority";
  if (record.kind === PINNED_SET_KIND && typeof record.body["content"] !== "string") {
    return "content must be a string";
  }
  return null;
}

/** Fold pinned context records (any order, duplicates allowed). */
export function foldPinned(input: Iterable<StoreRecord>): PinnedFold {
  const { records } = prepareRecords(input);
  const register = new RegisterSet<string>();
  const rejected: RejectedRecord[] = [];
  for (const record of records) {
    if (record.kind !== PINNED_SET_KIND && record.kind !== PINNED_CLEAR_KIND) continue;
    const reason = rejection(record);
    if (reason !== null) {
      rejected.push({ id: record.id, kind: record.kind, reason });
      continue;
    }
    const authority = recordAuthority(record)!;
    const value =
      record.kind === PINNED_CLEAR_KIND ? TOMBSTONE : (record.body["content"] as string);
    register.offer(KEY, { record, authority, value });
  }
  const state = register.get(KEY);
  return {
    content: state?.value ?? null,
    cleared: state?.removed ?? false,
    winner: state?.winner.record.id ?? null,
    history: state?.history ?? [],
    rejected,
  };
}

/** The resolved pinned state as plain JSON, for the state digest. */
export function pinnedFingerprint(fold: PinnedFold): unknown {
  return {
    content: fold.content,
    cleared: fold.cleared,
    winner: fold.winner,
    rejected: fold.rejected.map((r) => r.id),
  };
}
