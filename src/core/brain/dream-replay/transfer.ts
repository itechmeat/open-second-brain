/**
 * The replay across an owner transfer (design D8): the release of the
 * dream owner role names the last window the releasing device covered,
 * and a device that became the owner through that release runs no window
 * until its fold holds that window's coverage and every shard its
 * admission named is here up to the recorded offset. A forced takeover
 * has no release: the new owner continues from the newest coverage it
 * holds, and the status says that windows the previous owner covered may
 * not have arrived.
 */

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

import { readDeviceId } from "../../config.ts";
import type { StorePartition } from "../../store/constants.ts";
import { readStreamRecords } from "../../store/read/stream-read.ts";
import { configuredStore } from "../../store/read/store-entities.ts";
import { partitionDir } from "../../store/store-paths.ts";
import { DREAM_OWNER_KINDS, foldDreamOwner, type DreamOwnerState } from "../dream-owner/fold.ts";
import { foldDreamReplay, type DreamReplayState } from "./fold.ts";
import { DREAM_REPLAY_STREAM } from "./records.ts";

/** The window a release names as the last its device covered. */
export interface CoveredWindow {
  readonly day: string;
  readonly window: string;
  /** Record id of that window's admission. */
  readonly admission: string;
}

/** The last covered window of the store at `root`, for a release record. */
export function lastCoveredWindow(root: string): CoveredWindow | null {
  const read = readStreamRecords(root, "shared", { stream: DREAM_REPLAY_STREAM });
  const state = foldDreamReplay(read.records);
  if (state.lastCovered === null) return null;
  let newest: CoveredWindow | null = null;
  for (const { body } of state.coverage.values()) {
    if (body.day !== state.lastCovered) continue;
    const window = body.window ?? body.day;
    if (newest === null || window > newest.window) {
      newest = { day: body.day, window, admission: body.admission };
    }
  }
  return newest;
}

function ownerState(root: string): DreamOwnerState {
  const read = readStreamRecords(root, "shared", { stream: "settings" });
  return foldDreamOwner(read.records.filter((record) => DREAM_OWNER_KINDS.has(record.kind)));
}

function coveredOf(value: unknown): CoveredWindow | null {
  if (value === null || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  return typeof v["day"] === "string" &&
    typeof v["window"] === "string" &&
    typeof v["admission"] === "string"
    ? { day: v["day"], window: v["window"], admission: v["admission"] }
    : null;
}

/**
 * Why the owner on `store.device` must wait before it runs a window, or
 * null. A device that holds `private` waits for the private part every
 * admission it holds names: without it the late and clamped records of
 * that part would lose their admitted times. Beyond that, only a device
 * that became the owner through a release waits, and only for the window
 * that release names.
 */
export function waitForSync(
  store: {
    readonly root: string;
    readonly device: string;
    readonly partitions: ReadonlySet<StorePartition>;
  },
  state: DreamReplayState,
): string | null {
  const { root, device } = store;
  if (store.partitions.has("private") && state.unmergedParts.length > 0) {
    return (
      `the private part of the admission of ${state.unmergedParts.join(", ")} has not synced ` +
      "here yet; dream waits for sync"
    );
  }
  const owner = ownerState(root);
  if (owner.owner?.device !== device || owner.via !== "release" || owner.since === null) {
    return null;
  }
  const covered = coveredOf(owner.since.body["covered"]);
  if (covered === null) return null;
  if (!state.coverage.has(covered.window)) {
    return (
      `this device became the dream owner through a release that names ${covered.window} as the ` +
      "last covered window, and that window's coverage has not synced here yet; dream waits for sync"
    );
  }
  const admission = [...state.admissions.values()].find((a) => a.id === covered.admission);
  if (admission === undefined) {
    return `the admission of ${covered.window} has not synced here yet; dream waits for sync`;
  }
  for (const position of admission.body.positions) {
    const path = join(partitionDir(root, position.partition as StorePartition), position.shard);
    let size = -1;
    try {
      size = existsSync(path) ? statSync(path).size : -1;
    } catch {
      size = -1;
    }
    if (size < position.offset) {
      return (
        `${position.partition}/${position.shard} has not synced up to where ${covered.window} ` +
        "read it; dream waits for sync"
      );
    }
  }
  return null;
}

/** `waitForSync` for the configured store and this device, for doctor and the status. */
export function replayWaitsForSync(
  vault: string | null,
  state: DreamReplayState,
  configPath?: string,
): string | null {
  void vault;
  const store = configuredStore(configPath);
  if (store === null) return null;
  const device = readDeviceId(configPath ?? null);
  if (device === null) return null;
  return waitForSync({ root: store.root, device, partitions: store.partitions }, state);
}

/** Whether the owner took the role by force (no release named its coverage). */
export function ownerForced(root: string): boolean {
  return ownerState(root).via === "force";
}
