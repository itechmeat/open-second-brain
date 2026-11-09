/**
 * The view writer role on this machine (design D7, task 2.7): claim it on
 * the first initialising or migrating machine, ask for it with
 * `o2b view writer --here` (or `--force`), and hand it over when the user
 * moved it elsewhere. The fold that decides who holds the role is
 * `writer-fold.ts`; this module writes the records.
 *
 * Rules:
 *
 *  - **Claim once.** A machine claims only when its catch-up shows no
 *    writer (the fold turns any valid claim into a writer, so a known
 *    claim stops it too; a malformed one does not). Two machines that
 *    claim before either claim has synced both write one; the fold picks
 *    the lowest (clock, device).
 *  - **A fresh claim waits one catch-up.** A device that holds the role
 *    through its own claim renders only from the pass after the one that
 *    first saw it hold the role (`claimSettled`), so a claim that loses
 *    to one still in transit has a pass to learn of it.
 *  - **Release under the render lock.** The current writer releases a
 *    pending request while it holds the device-local render lock, so a
 *    render in progress finishes before the release is written and none
 *    starts after it.
 *  - **Force warns.** A forced request takes the role at once; the old
 *    writer may render once more before the request reaches it.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { appendRecord, type AppendResult } from "../store/appender.ts";
import { AUTHORITY_FIELD } from "../store/constants.ts";
import type { StoreHandle } from "../store/store-open.ts";
import { withLocalLock } from "../store/local-lock.ts";
import { catchUp, partitionRecords } from "./catch-up.ts";
import {
  VIEW_CLAIM_SEEN_FILE,
  VIEW_RENDER_LOCK,
  VIEW_STATE_DIR,
  VIEW_WRITER_CLAIM_KIND,
  VIEW_WRITER_RELEASED_KIND,
  VIEW_WRITER_REQUEST_KIND,
} from "./constants.ts";
import { foldViewWriter, pendingTarget, type ViewWriterState } from "./writer-fold.ts";

export interface ViewWriterWriteOptions {
  /** Agent identity written on the record. */
  readonly agent: string;
  readonly now?: () => number;
}

/** The view writer as this machine sees it after a catch-up. */
export function readViewWriter(store: StoreHandle, now?: () => number): ViewWriterState {
  return foldViewWriter(partitionRecords(catchUp(store, now), "shared"));
}

function appendSetting(
  store: StoreHandle,
  kind: string,
  body: Record<string, unknown>,
  options: ViewWriterWriteOptions,
): AppendResult {
  return appendRecord(
    store,
    { partition: "shared", stream: "settings", kind, agent: options.agent, body },
    options.now !== undefined ? { now: options.now } : {},
  );
}

export type ClaimResult =
  | { readonly claimed: true; readonly record: AppendResult }
  | { readonly claimed: false; readonly writer: string | null };

/**
 * Record this device as the view writer unless a writer is already known
 * (a valid claim folds into one; a malformed claim stops nothing). Called
 * by store creation and by the migration.
 */
export function claimViewWriter(store: StoreHandle, options: ViewWriterWriteOptions): ClaimResult {
  const state = readViewWriter(store, options.now);
  // A valid claim always gives the role to someone, so only a known
  // writer stops the claim: a malformed claim (`rejected`) must not keep
  // every machine from ever claiming.
  if (state.writer !== null) return { claimed: false, writer: state.writer };
  const record = appendSetting(
    store,
    VIEW_WRITER_CLAIM_KIND,
    { [AUTHORITY_FIELD]: "human", device: store.device },
    options,
  );
  return { claimed: true, record };
}

export type RequestResult =
  | { readonly status: "already-writer"; readonly state: ViewWriterState }
  | {
      readonly status: "requested" | "forced" | "taken";
      readonly previous: string | null;
      readonly record: AppendResult;
      readonly warning: string | null;
    };

/**
 * Ask for the view writer role on this device (`o2b view writer --here`).
 * `taken`: there was no writer, so the role is this device's now;
 * `requested`: the current writer releases it at its next catch-up;
 * `forced`: the role is this device's now, and the old writer may render
 * once more before it learns of the move.
 */
export function requestViewWriter(
  store: StoreHandle,
  options: ViewWriterWriteOptions & { readonly force: boolean },
): RequestResult {
  const state = readViewWriter(store, options.now);
  if (state.writer === store.device && state.pending === null) {
    return { status: "already-writer", state };
  }
  const record = appendSetting(
    store,
    VIEW_WRITER_REQUEST_KIND,
    { [AUTHORITY_FIELD]: "human", device: store.device, force: options.force },
    options,
  );
  if (state.writer === null || state.writer === store.device) {
    return { status: "taken", previous: state.writer, record, warning: null };
  }
  if (!options.force) {
    return { status: "requested", previous: state.writer, record, warning: null };
  }
  return {
    status: "forced",
    previous: state.writer,
    record,
    warning:
      `the role moved without a release from ${state.writer}; if that machine is still running, ` +
      "it may render the view once more before this change reaches it, and stops at its first " +
      "catch-up after that",
  };
}

/** Device-local lock path held for a render pass and for a release. */
export function renderLockTarget(store: StoreHandle): string {
  return join(store.deviceStateDir, VIEW_STATE_DIR, VIEW_RENDER_LOCK);
}

/**
 * Hand the role over when this device is the writer and a request for
 * another device is pending: the release is written under the render
 * lock, after any render in progress. Returns the device the role went to.
 */
export function releaseIfRequested(
  store: StoreHandle,
  state: ViewWriterState,
  options: ViewWriterWriteOptions,
): string | null {
  const to = pendingTarget(state);
  if (state.writer !== store.device || state.pending === null || to === null) return null;
  const pending = state.pending;
  mkdirSync(join(store.deviceStateDir, VIEW_STATE_DIR), { recursive: true });
  withLocalLock(renderLockTarget(store), () =>
    appendSetting(
      store,
      VIEW_WRITER_RELEASED_KIND,
      { request: pending.id, device: store.device, to },
      options,
    ),
  );
  return to;
}

function claimSeenPath(store: StoreHandle): string {
  return join(store.deviceStateDir, VIEW_STATE_DIR, VIEW_CLAIM_SEEN_FILE);
}

/**
 * Whether this device, holding the role through its own claim, has
 * already caught up once since it first saw that: the first call for a
 * claim notes it in device-local state and answers `false`, every later
 * call answers `true`. Roles taken any other way are settled at once.
 */
export function claimSettled(store: StoreHandle, state: ViewWriterState): boolean {
  if (state.via !== "claim" || state.since === null) return true;
  const path = claimSeenPath(store);
  if (existsSync(path)) {
    try {
      const seen = JSON.parse(readFileSync(path, "utf8")) as { claim?: unknown };
      if (seen.claim === state.since.id) return true;
    } catch {
      // unreadable: note the claim again and wait one more pass
    }
  }
  mkdirSync(join(store.deviceStateDir, VIEW_STATE_DIR), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ claim: state.since.id })}\n`);
  return false;
}
