/**
 * The dream owner role on this device (design D1, D3, D4): read it, claim
 * it when a brain is created, take, ask for or give it up with
 * `o2b dream owner`, and hand it over when another device asked. The fold
 * that decides who holds the role is `fold.ts`; this module writes the
 * records. Built like the view writer role (`src/core/view/writer.ts`).
 *
 * Rules:
 *
 *  - **Claim once.** Creation claims only when no owner is known.
 *  - **A fresh claim waits one catch-up.** A device that holds the role
 *    through its own claim runs a live pass only from the look after the
 *    one that first saw it hold the role (`claimSettled`), so a rival
 *    claim still in transit has a catch-up to arrive.
 *  - **Release under the pass lock.** The owner's device writes a release
 *    while it holds the device-local pass lock, so a pass in progress
 *    finishes before the release is written and none starts after it. The
 *    lock is judged by its holder's process (`src/core/store/process-lock.ts`), so a pass
 *    keeps it for as long as it runs. A lock held by a running pass is
 *    waited for only within the lock budget: past it the next look
 *    releases, and `o2b dream owner --release` refuses.
 *  - **Force warns.** A forced claim takes the role at once; the old
 *    owner keeps passing its own gate until its first catch-up after the
 *    forced claim reaches it.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { appendRecord, type AppendResult } from "../../store/appender.ts";
import { AUTHORITY_FIELD, type Authority } from "../../store/constants.ts";
import type { StoreRecord } from "../../store/envelope.ts";
import { compareRecords } from "../../store/envelope.ts";
import { observeClock } from "../../store/clock-store.ts";
import { parseHlc } from "../../store/hlc.ts";
import { isLockContention } from "../../store/local-lock.ts";
import { acquireProcessLock } from "../../store/process-lock.ts";
import { readShard } from "../../store/reader.ts";
import { listShards } from "../../store/shard-list.ts";
import type { StoreHandle } from "../../store/store-open.ts";
import { partitionDir } from "../../store/store-paths.ts";
import {
  DREAM_OWNER_CLAIM_KIND,
  DREAM_OWNER_CLAIM_SEEN_FILE,
  DREAM_OWNER_RELEASED_KIND,
  DREAM_OWNER_REQUEST_KIND,
  DREAM_OWNER_STATE_DIR,
  DREAM_PASS_LOCK,
} from "./constants.ts";
import { DREAM_OWNER_KINDS, foldDreamOwner, type DreamOwnerState } from "./fold.ts";

export interface DreamOwnerWriteOptions {
  /** Identity written on the record envelope: the agent (or tool) that ran the operation. */
  readonly writer: string;
  /** Whether a person or an agent made the move. */
  readonly authority: Extract<Authority, "human" | "agent">;
  readonly now?: () => number;
}

/**
 * A settings shard of `shared` could not be read, so the dream owner is
 * unknown: a live pass refuses on it, a preview still runs.
 */
export class DreamOwnerSettingsUnreadableError extends Error {
  constructor(
    readonly state: string,
    options?: ErrorOptions,
  ) {
    super(`unreadable settings shard: ${state}`, options);
    this.name = "DreamOwnerSettingsUnreadableError";
  }
}

/**
 * This machine does not hold the `shared` partition, where the owner
 * records live, so the dream owner is unknown here (not absent): a live
 * pass refuses on it, a preview still runs.
 */
export class DreamOwnerPartitionUnavailableError extends DreamOwnerSettingsUnreadableError {
  constructor(readonly partition: "shared") {
    super(`the ${partition} partition is not held on this machine`);
    this.name = "DreamOwnerPartitionUnavailableError";
  }
}

/**
 * The dream owner as this device sees it after reading the `settings`
 * stream of `shared`. A shard that cannot be read, or a `shared` partition
 * this machine does not hold, makes the fold unknown; callers must not
 * treat it as an absent owner. Every record read raises
 * the local clock (the receive rule), so a release this device writes in
 * answer folds after the request it answers.
 */
export function readDreamOwner(store: StoreHandle, now?: () => number): DreamOwnerState {
  if (!store.partitions.has("shared")) throw new DreamOwnerPartitionUnavailableError("shared");
  const root = partitionDir(store.root, "shared");
  const kept: StoreRecord[] = [];
  let newest: StoreRecord | undefined;
  let shards;
  try {
    shards = listShards(root, { stream: "settings" });
  } catch (cause) {
    throw new DreamOwnerSettingsUnreadableError(`${root} settings shard listing`, { cause });
  }
  for (const shard of shards) {
    let result: ReturnType<typeof readShard>;
    try {
      result = readShard(shard.path, { partitionRoot: root });
    } catch (cause) {
      throw new DreamOwnerSettingsUnreadableError(shard.path, { cause });
    }
    // A shard the reader refuses to open (a link or a special file under
    // the name) was not read either: its records are unknown, not absent.
    if (result.diagnostics.some((d) => d.kind === "not-a-file")) {
      throw new DreamOwnerSettingsUnreadableError(shard.path);
    }
    for (const r of result.records) {
      if (r.bodyState === "pending") {
        if (DREAM_OWNER_KINDS.has(r.record.kind)) {
          throw new DreamOwnerSettingsUnreadableError(
            `${shard.path} (pending ${r.record.kind} record ${r.record.id})`,
          );
        }
        continue;
      }
      if (newest === undefined || compareRecords(r.record, newest) > 0) newest = r.record;
      if (DREAM_OWNER_KINDS.has(r.record.kind)) kept.push(r.record);
    }
  }
  if (newest !== undefined) {
    observeClock(store.deviceStateDir, store.device, parseHlc(newest.hlc)!, now);
  }
  return foldDreamOwner(kept);
}

function appendSetting(
  store: StoreHandle,
  kind: string,
  body: Record<string, unknown>,
  options: Pick<DreamOwnerWriteOptions, "writer" | "now">,
): AppendResult {
  return appendRecord(
    store,
    { partition: "shared", stream: "settings", kind, agent: options.writer, body },
    options.now !== undefined ? { now: options.now } : {},
  );
}

function writeClaim(
  store: StoreHandle,
  agent: string,
  force: boolean,
  options: DreamOwnerWriteOptions,
): AppendResult {
  return appendSetting(
    store,
    DREAM_OWNER_CLAIM_KIND,
    { [AUTHORITY_FIELD]: options.authority, device: store.device, agent, force },
    options,
  );
}

export type DreamOwnerClaimResult =
  | { readonly claimed: true; readonly record: AppendResult }
  | { readonly claimed: false; readonly owner: { device: string; agent: string } };

/**
 * Record this device and `agent` as the owner unless an owner is already
 * known. Called when a brain is created (design D5).
 */
export function claimDreamOwner(
  store: StoreHandle,
  agent: string,
  options: DreamOwnerWriteOptions,
): DreamOwnerClaimResult {
  return withDreamPassLock(
    store,
    () => {
      const state = readDreamOwner(store, options.now);
      if (state.owner !== null) {
        return { claimed: false, owner: { device: state.owner.device, agent: state.owner.agent } };
      }
      return { claimed: true, record: writeClaim(store, agent, false, options) };
    },
    options.now !== undefined ? { now: options.now } : {},
  );
}

export type DreamOwnerTakeResult =
  | { readonly status: "already-owner"; readonly state: DreamOwnerState }
  | {
      readonly status: "taken" | "agent-changed" | "requested" | "forced";
      readonly previous: { readonly device: string; readonly agent: string } | null;
      readonly record: AppendResult;
      readonly warning: string | null;
    };

/**
 * Take, ask for or adopt the role on this device (`o2b dream owner
 * --here`, `brain_dream_owner` `take`):
 *
 *  - `taken`: there was no owner (an unbound brain is adopted), so the
 *    role is this device's now;
 *  - `agent-changed`: this device is the owner, and its agent is `agent` now;
 *  - `requested`: the owner's device releases the role at its next look;
 *  - `forced`: the role is this device's now, and the old owner keeps
 *    passing its own gate until the forced claim reaches it.
 */
export function takeDreamOwner(
  store: StoreHandle,
  agent: string,
  options: DreamOwnerWriteOptions & { readonly force: boolean },
): DreamOwnerTakeResult {
  const state = readDreamOwner(store, options.now);
  const owner = state.owner;
  if (owner === null) {
    return {
      status: "taken",
      previous: null,
      record: writeClaim(store, agent, false, options),
      warning: null,
    };
  }
  const previous = { device: owner.device, agent: owner.agent };
  if (owner.device === store.device) {
    if (owner.agent === agent) return { status: "already-owner", state };
    return {
      status: "agent-changed",
      previous,
      record: writeClaim(store, agent, false, options),
      warning: null,
    };
  }
  if (options.force) {
    return {
      status: "forced",
      previous,
      record: writeClaim(store, agent, true, options),
      warning:
        `the role moved without a release from ${owner.device}; if that machine is still ` +
        "running, it keeps passing its own gate, and may run dream passes, until its first " +
        "catch-up after this claim reaches it",
    };
  }
  return {
    status: "requested",
    previous,
    record: requestDreamOwner(store, agent, options),
    warning: null,
  };
}

/** Ask the owner's device for the role (the request half of {@link takeDreamOwner}). */
export function requestDreamOwner(
  store: StoreHandle,
  agent: string,
  options: DreamOwnerWriteOptions,
): AppendResult {
  readDreamOwner(store, options.now);
  return appendSetting(
    store,
    DREAM_OWNER_REQUEST_KIND,
    { [AUTHORITY_FIELD]: options.authority, device: store.device, agent },
    options,
  );
}

/** Device-local lock path held for a live pass and for a release. */
export function dreamPassLockTarget(store: StoreHandle): string {
  return join(store.deviceStateDir, DREAM_OWNER_STATE_DIR, DREAM_PASS_LOCK);
}

/**
 * Run `fn` under the pass lock of this device (`src/core/store/process-lock.ts`):
 * held for as long as this process runs `fn`, however long, and taken over
 * only once this process is gone. `now` is the clock of the lock's age rule
 * for a holder that cannot be checked.
 */
export function withDreamPassLock<T>(
  store: StoreHandle,
  fn: () => T,
  options: { readonly now?: () => number } = {},
): T {
  mkdirSync(join(store.deviceStateDir, DREAM_OWNER_STATE_DIR), { recursive: true });
  const release = acquireProcessLock(dreamPassLockTarget(store), {
    ...options,
    label: "dream pass lock",
    remedy: "retry once the dream pass finishes",
  });
  try {
    return fn();
  } finally {
    release();
  }
}

export type DreamOwnerReleaseResult =
  | { readonly status: "released" }
  | { readonly status: "not-owner"; readonly owner: { device: string; agent: string } | null };

/** Give the role up with no successor (`o2b dream owner --release`). */
export function releaseDreamOwner(
  store: StoreHandle,
  options: Pick<DreamOwnerWriteOptions, "writer" | "now">,
): DreamOwnerReleaseResult {
  return withDreamPassLock(
    store,
    () => {
      const state = readDreamOwner(store, options.now);
      if (state.owner?.device !== store.device) {
        return {
          status: "not-owner",
          owner:
            state.owner === null ? null : { device: state.owner.device, agent: state.owner.agent },
        };
      }
      appendSetting(
        store,
        DREAM_OWNER_RELEASED_KIND,
        { request: null, device: store.device, to: null },
        options,
      );
      return { status: "released" };
    },
    options.now !== undefined ? { now: options.now } : {},
  );
}

/**
 * Hand the role over when this device is the owner and a request is
 * pending: the release is written under the pass lock. A pass that holds
 * the lock is waited for only within the lock budget (far shorter than a
 * pass): past it the release is left to the next look, and `null` is
 * returned. Returns the device the role went to, or `null`.
 * The supplied look only decides whether a lock is worth taking; the
 * current owner and request are read again under the lock before release.
 */
export function releaseIfRequested(
  store: StoreHandle,
  state: DreamOwnerState,
  options: Pick<DreamOwnerWriteOptions, "writer" | "now">,
): string | null {
  if (state.owner?.device !== store.device || state.pending === null) return null;
  try {
    return withDreamPassLock(
      store,
      () => {
        const current = readDreamOwner(store, options.now);
        const pending = current.pending;
        if (current.owner?.device !== store.device || pending === null) return null;
        appendSetting(
          store,
          DREAM_OWNER_RELEASED_KIND,
          { request: pending.id, device: store.device, to: pending.device },
          options,
        );
        return pending.device;
      },
      options.now !== undefined ? { now: options.now } : {},
    );
  } catch (err) {
    if (isLockContention(err)) return null;
    throw err;
  }
}

function claimSeenPath(store: StoreHandle): string {
  return join(store.deviceStateDir, DREAM_OWNER_STATE_DIR, DREAM_OWNER_CLAIM_SEEN_FILE);
}

function seenClaim(store: StoreHandle): unknown {
  try {
    return (JSON.parse(readFileSync(claimSeenPath(store), "utf8")) as { claim?: unknown }).claim;
  } catch {
    return undefined;
  }
}

/**
 * Whether {@link claimSettled} has already noted this device's current
 * claim, without noting anything: for a read that must not spend the
 * wait (a status, a dry run).
 */
export function claimSeen(store: StoreHandle, state: DreamOwnerState): boolean {
  if (state.via !== "claim" || state.since === null) return true;
  if (state.owner?.device !== store.device) return true;
  return seenClaim(store) === state.since.id;
}

/**
 * Whether this device, holding the role through its own claim, has
 * already looked once since it first saw that: the first call for a claim
 * notes it in device-local state and answers `false`, every later call
 * answers `true`. A role taken any other way is settled at once.
 */
export function claimSettled(store: StoreHandle, state: DreamOwnerState): boolean {
  if (claimSeen(store, state) || state.since === null) return true;
  mkdirSync(join(store.deviceStateDir, DREAM_OWNER_STATE_DIR), { recursive: true });
  writeFileSync(claimSeenPath(store), `${JSON.stringify({ claim: state.since.id })}\n`);
  return false;
}
