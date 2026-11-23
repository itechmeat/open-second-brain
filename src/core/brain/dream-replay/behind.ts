/**
 * Windows behind (design D1, D10): the days before today a live pass
 * would replay before today's window. The staged flow validates today's
 * plan and then runs a live pass, so it is refused while windows are
 * behind or one is open: a pass that replays first, or finishes an open
 * window's frozen plan, would execute another plan than the one
 * validated. Read-only: no gate, no writes.
 */

import { configuredStore } from "../../store/read/store-entities.ts";
import { isStoreOnly } from "../../store/store-only.ts";
import { isoDate } from "../time.ts";
import type { DreamReplayState } from "./fold.ts";
import { readReplayState } from "./pass.ts";
import { daysFrom, nextDay } from "./records.ts";

/** The code a staged action answers with while windows are behind. */
export const DREAM_REPLAY_BEHIND_CODE = "dream_replay_behind";

/** The command that replays the windows behind. */
export const DREAM_REPLAY_COMMAND = "o2b brain dream";

/**
 * The folded replay stream of the configured store, or null for a brain
 * not served from it. Throws {@link DreamReplayUnreadableError} when the
 * stream cannot be read completely here: a fold of part of it would count
 * windows from a truncated history.
 */
export function readConfiguredReplay(
  vault: string | null,
  configPath?: string,
): DreamReplayState | null {
  if (
    vault !== null &&
    !isStoreOnly({ vault, ...(configPath !== undefined ? { configPath } : {}) })
  ) {
    return null;
  }
  const store = configuredStore(configPath);
  if (store === null || !store.partitions.has("shared")) return null;
  return readReplayState({ store });
}

/** The days before `now`'s day that a live pass would replay first. */
export function daysBehind(state: DreamReplayState | null, now: Date): string[] {
  if (state === null) return [];
  const yesterday = isoDate(new Date(now.getTime() - 86_400_000));
  const open = state.open?.body.day ?? null;
  if (open !== null && open <= yesterday) return daysFrom(open, yesterday);
  if (state.lastCovered === null) return [];
  return daysFrom(nextDay(state.lastCovered), yesterday);
}

/**
 * A staged action asked for while windows are behind, or while a window
 * is open (`open`: a pass stopped inside it, and the next live pass
 * finishes its frozen plan, not the plan a stage validates).
 */
export class DreamReplayBehindError extends Error {
  readonly code = DREAM_REPLAY_BEHIND_CODE;
  constructor(
    readonly days: ReadonlyArray<string>,
    readonly open: string | null = null,
  ) {
    super(
      days.length > 0
        ? `dream: ${days.length} window(s) are behind (${days[0]} to ${days.at(-1)}); ` +
            `run \`${DREAM_REPLAY_COMMAND}\` to replay them, then stage again`
        : `dream: the window of ${open} is open (a pass stopped inside it); ` +
            `run \`${DREAM_REPLAY_COMMAND}\` to finish it, then stage again`,
    );
    this.name = "DreamReplayBehindError";
  }
}

/** Refuse a staged action while windows are behind or one is open. */
export function assertNoWindowsBehind(
  vault: string | null,
  now: Date | undefined,
  configPath?: string,
): void {
  const state = readConfiguredReplay(vault, configPath);
  const days = daysBehind(state, now ?? new Date());
  if (days.length > 0) throw new DreamReplayBehindError(days);
  // Today's window open: the live pass of an apply would finish its frozen
  // plan, not the one a stage validated.
  const open = state?.open?.body.window ?? null;
  if (open !== null) throw new DreamReplayBehindError([], open);
}
