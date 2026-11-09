/**
 * The view writer fold (design D7, spec `human-view` "One view writer"):
 * which one device renders the human view, computed from records in the
 * `settings` stream of the `shared` partition so every machine agrees.
 *
 * Input records, in fold order (clock, device, id):
 *
 *  - `view-writer-claim` `{ authority: "human", device }`: written by the
 *    first machine that initialises or migrates the store, for itself.
 *    When no writer is known yet, the first claim in fold order takes the
 *    role, so of two machines that claimed at the same time the one with
 *    the lowest (clock, device) wins once both claims have synced. Every
 *    later claim is ignored.
 *  - `view-writer-request` `{ authority: "human", device, force }`: the
 *    user, on `device`, asks for the role. With no writer yet it takes the
 *    role at once. With `force` it takes the role at once even though the
 *    current writer has not released it (the old writer is unreachable).
 *    Otherwise it is pending until the current writer releases it; a newer
 *    request replaces a pending one, and a request by the current writer
 *    cancels it.
 *  - `view-writer-released` `{ request, device, to }`: written by the
 *    current writer itself after it saw the pending request `request`
 *    and finished any render in progress. The role passes to the device
 *    that request named.
 *
 * Only the user moves the role: claims and requests need `human`
 * authority, and a device claims or requests only for itself. A release
 * counts only when the current writer wrote it for the pending request.
 * Anything else is rejected and listed, never applied.
 */

import { isValidDeviceId } from "../config.ts";
import type { StoreRecord } from "../store/envelope.ts";
import { prepareRecords, recordAuthority, type RejectedRecord } from "../store/fold.ts";
import { isUlid } from "../store/ulid.ts";
import {
  VIEW_WRITER_CLAIM_KIND,
  VIEW_WRITER_RELEASED_KIND,
  VIEW_WRITER_REQUEST_KIND,
} from "./constants.ts";

/** How the current writer got the role. */
export type ViewWriterVia = "claim" | "request" | "force" | "release";

export interface ViewWriterState {
  /** The device that renders the view, or `null` when no machine has the role yet. */
  readonly writer: string | null;
  /** The record that gave the current writer its role. */
  readonly since: StoreRecord | null;
  readonly via: ViewWriterVia | null;
  /** A move the current writer has not released yet. */
  readonly pending: StoreRecord | null;
  /** Every claim, valid or not, in fold order (the losers stay in the history). */
  readonly claims: ReadonlyArray<StoreRecord>;
  readonly rejected: ReadonlyArray<RejectedRecord>;
}

const VIEW_WRITER_KINDS: ReadonlySet<string> = new Set([
  VIEW_WRITER_CLAIM_KIND,
  VIEW_WRITER_REQUEST_KIND,
  VIEW_WRITER_RELEASED_KIND,
]);

function rejection(record: StoreRecord): string | null {
  const device = record.body["device"];
  if (typeof device !== "string" || !isValidDeviceId(device)) return "missing or invalid device";
  if (record.kind === VIEW_WRITER_RELEASED_KIND) {
    if (!isUlid(record.body["request"])) return "missing or invalid request id";
    if (device !== record.device) return "a release names the device that wrote it";
    return null;
  }
  if (recordAuthority(record) !== "human") return "only the user moves the view writer role";
  if (device !== record.device) return "a device claims or requests the role only for itself";
  if (record.kind === VIEW_WRITER_REQUEST_KIND && typeof record.body["force"] !== "boolean") {
    return "force must be true or false";
  }
  return null;
}

/** Fold view writer records (any order, duplicates allowed; other kinds ignored). */
export function foldViewWriter(input: Iterable<StoreRecord>): ViewWriterState {
  const { records } = prepareRecords(input);
  let writer: string | null = null;
  let since: StoreRecord | null = null;
  let via: ViewWriterVia | null = null;
  let pending: StoreRecord | null = null;
  const claims: StoreRecord[] = [];
  const rejected: RejectedRecord[] = [];
  const take = (record: StoreRecord, how: ViewWriterVia, device: string): void => {
    writer = device;
    since = record;
    via = how;
    pending = null;
  };
  for (const record of records) {
    if (!VIEW_WRITER_KINDS.has(record.kind)) continue;
    if (record.kind === VIEW_WRITER_CLAIM_KIND) claims.push(record);
    const reason = rejection(record);
    if (reason !== null) {
      rejected.push({ id: record.id, kind: record.kind, reason });
      continue;
    }
    const device = record.body["device"] as string;
    if (record.kind === VIEW_WRITER_CLAIM_KIND) {
      if (writer === null) take(record, "claim", device);
    } else if (record.kind === VIEW_WRITER_REQUEST_KIND) {
      if (writer === null) take(record, "request", device);
      else if (device === writer) pending = null;
      else if (record.body["force"] === true) take(record, "force", device);
      else pending = record;
    } else {
      const open = pending as StoreRecord | null;
      if (open !== null && record.body["request"] === open.id && record.device === writer) {
        take(record, "release", open.body["device"] as string);
      }
    }
  }
  return { writer, since, via, pending, claims, rejected };
}

/** The device a pending request asks to move the role to. */
export function pendingTarget(state: ViewWriterState): string | null {
  return state.pending === null ? null : (state.pending.body["device"] as string);
}
