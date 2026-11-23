/**
 * The one line a machine that is not the dream owner says (change
 * `dream-session-trigger`, design D6, spec "Other machines say one thing,
 * once"): when the owner has covered no window for three days, a session
 * here shows one line naming the owner, its last covered day and the
 * command that takes the role, at most once a day. Every other session on
 * such a machine says nothing about dream.
 *
 * The newest coverage record of the shared partition is the synced fact:
 * a pass that changes nothing writes no log event, but every covered
 * window has its coverage record. With none, the owner's own record says
 * how long the role has been held. A replay that cannot be read here says
 * nothing: unknown is not silent.
 */

import { parseHlc } from "../../store/hlc.ts";
import { DREAM_OWNER_HERE_COMMAND } from "../dream-owner/constants.ts";
import type { DreamOwner } from "../dream-owner/fold.ts";
import { readConfiguredReplay } from "../dream-replay/behind.ts";
import { DREAM_TRIGGER_SILENT_OWNER_DAYS } from "./constants.ts";

const DAY_MS = 86_400_000;

/** Whole UTC days from `day` (`YYYY-MM-DD`) to the day of `now`. */
export function daysSince(day: string, now: number): number {
  const start = Date.parse(`${day}T00:00:00.000Z`);
  if (Number.isNaN(start)) return 0;
  const today = Date.parse(`${new Date(now).toISOString().slice(0, 10)}T00:00:00.000Z`);
  return Math.floor((today - start) / DAY_MS);
}

/** The line for `owner`, last covered on `lastCovered` (or never). */
export function silentOwnerLine(owner: DreamOwner, lastCovered: string | null): string {
  return (
    `Dream is owned by ${owner.device} (${owner.agent}) and last covered ` +
    `${lastCovered ?? "no day yet"}. To run it here: ${DREAM_OWNER_HERE_COMMAND}`
  );
}

/**
 * The line to show on this machine about `owner`, or `null` when the
 * owner covered a window within the last three days, or when that cannot
 * be known here.
 */
export function silentOwnerLineFor(
  vault: string | null,
  configPath: string | undefined,
  owner: DreamOwner,
  now: number,
): string | null {
  let lastCovered: string | null;
  try {
    lastCovered = readConfiguredReplay(vault, configPath)?.lastCovered ?? null;
  } catch {
    return null;
  }
  if (lastCovered !== null) {
    return daysSince(lastCovered, now) > DREAM_TRIGGER_SILENT_OWNER_DAYS
      ? silentOwnerLine(owner, lastCovered)
      : null;
  }
  const held = parseHlc(owner.revision)?.physical;
  if (held === undefined) return null;
  return now - held > DREAM_TRIGGER_SILENT_OWNER_DAYS * DAY_MS
    ? silentOwnerLine(owner, null)
    : null;
}
