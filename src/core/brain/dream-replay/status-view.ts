/**
 * The replay section of the dream owner status (design D10 item 1; spec
 * "The status tells three things apart"): the last admitted position
 * (sources, any gaps by name), the last covered window with the windows
 * still behind, and the windows whose model work is unfinished. A window
 * whose model work waits is not reported as completed. Read-only.
 */

import type { DreamQueueStatus } from "../dream-queue/queue.ts";
import { configuredStore } from "../../store/read/store-entities.ts";
import { daysBehind, readConfiguredReplay } from "./behind.ts";
import { DreamReplayUnreadableError } from "./pass.ts";
import { ownerForced, replayWaitsForSync } from "./transfer.ts";

export type DreamReplayStatus =
  | {
      readonly available: false;
      readonly message: string;
    }
  | {
      readonly available: true;
      /** The positions of the newest admission: how many sources, and those incomplete. */
      readonly sources: number;
      readonly gaps: ReadonlyArray<string>;
      readonly lastCovered: string | null;
      readonly behind: number;
      /** A window admitted and not covered (a pass stopped inside it). */
      readonly open: string | null;
      /** Windows with model work in the queue that is not finished. */
      readonly unfinishedModelWork: ReadonlyArray<string>;
      /** Why this device waits before it runs a window, when it does. */
      readonly waitingForSync: string | null;
      /** The owner took the role by force: the previous owner's last windows may not have arrived. */
      readonly forced: boolean;
    };

/** The replay status of the configured store. */
export function replayStatus(
  vault: string | null,
  options: {
    readonly configPath?: string;
    readonly now?: Date;
    readonly queue?: DreamQueueStatus;
  } = {},
): DreamReplayStatus {
  let state: ReturnType<typeof readConfiguredReplay>;
  try {
    state = readConfiguredReplay(vault, options.configPath);
  } catch (error) {
    if (!(error instanceof DreamReplayUnreadableError)) throw error;
    return {
      available: false,
      message: `the replay's state is unknown here: ${error.message}`,
    };
  }
  if (state === null) {
    // A legacy pass is never reported as covered (spec).
    return {
      available: false,
      message: "the dream replay starts when the brain moves to the brain store",
    };
  }
  const latest = state.latestAdmission?.body ?? null;
  const unfinished = new Set<string>();
  if (options.queue?.available === true) {
    for (const item of options.queue.items) {
      if (item.state === "finished" || item.state === "closed") continue;
      unfinished.add(item.occurrence.slice(0, 10));
    }
  }
  const store = configuredStore(options.configPath);
  return {
    available: true,
    sources: latest?.positions.length ?? 0,
    gaps: [...(latest?.gaps ?? []), ...(latest?.left_out ?? [])].map(
      (g) => `${g.partition}/${g.shard}`,
    ),
    lastCovered: state.lastCovered,
    behind: daysBehind(state, options.now ?? new Date()).length,
    open: state.open?.body.window ?? null,
    unfinishedModelWork: [...unfinished].toSorted(),
    waitingForSync: replayWaitsForSync(vault, state, options.configPath),
    forced: store !== null && ownerForced(store.root),
  };
}

/** The status as JSON rows. */
export function replayStatusJson(status: DreamReplayStatus): Record<string, unknown> {
  if (!status.available) return { available: false, message: status.message };
  return {
    available: true,
    sources: status.sources,
    gaps: [...status.gaps],
    last_covered: status.lastCovered,
    behind: status.behind,
    open: status.open,
    unfinished_model_work: [...status.unfinishedModelWork],
    waiting_for_sync: status.waitingForSync,
    forced: status.forced,
  };
}

/** Lines for a person: what was admitted, what was evaluated, what model work waits. */
export function describeReplayStatus(status: DreamReplayStatus): string[] {
  if (!status.available) return [`Dream replay: ${status.message}.`];
  const lines = [
    `Dream replay: ${status.sources} source(s) admitted` +
      (status.gaps.length > 0 ? `, incomplete: ${status.gaps.join(", ")}` : "") +
      ".",
    status.lastCovered === null
      ? "No window is covered yet."
      : `Last covered window: ${status.lastCovered}; ${status.behind} window(s) behind.`,
  ];
  if (status.open !== null) lines.push(`Open window: ${status.open} (the next pass finishes it).`);
  if (status.unfinishedModelWork.length > 0) {
    lines.push(
      `Model work unfinished for: ${status.unfinishedModelWork.join(", ")} (those windows are not complete).`,
    );
  }
  if (status.waitingForSync !== null) lines.push(`Waiting for sync: ${status.waitingForSync}.`);
  if (status.forced) {
    lines.push(
      "The dream owner took the role by force: windows the previous owner covered may not have arrived here.",
    );
  }
  return lines;
}
