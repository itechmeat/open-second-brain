/**
 * The dream owner fold (design D1, spec `dream-ownership` "A brain has at
 * most one dream owner"): which one device, and which agent on it, runs
 * live dream passes, computed from records in the `settings` stream of
 * the `shared` partition so every device agrees.
 *
 * Input records, in fold order (clock, device, id), the order the view
 * writer fold reads in (`prepareRecords`):
 *
 *  - `dream-owner-claim` `{ authority, device, agent, force }`: a device
 *    takes the role for itself. With no owner yet the first claim in fold
 *    order takes it, so of two devices that claimed before either claim
 *    synced the one with the lowest (clock, device) wins on every device.
 *    A claim by the owner's own device changes the owner's agent. A claim
 *    with `force` takes the role at once from another owner, without a
 *    release (the old owner is unreachable). Any other claim is ignored.
 *  - `dream-owner-request` `{ authority, device, agent }`: a device that
 *    is not the owner asks for the role. With no owner it takes the role
 *    at once. Otherwise it is pending until the owner's device releases
 *    it; a newer request replaces a pending one, and the replaced request
 *    has lost.
 *  - `dream-owner-released` `{ request, device, to }`: written by the
 *    owner's device. With `request` naming the pending request, the role
 *    passes to the device and agent that request named. With `request`
 *    and `to` both `null` the owner gives the role up and the brain has no
 *    owner.
 *
 * A device writes records only for itself. Unlike the view writer role,
 * an agent may move this role as well as a person: every claim and
 * request carries who made it, and the fold accepts both.
 * Anything malformed is rejected and listed, never applied.
 */

import { isValidDeviceId } from "../../config.ts";
import type { StoreRecord } from "../../store/envelope.ts";
import { prepareRecords, recordAuthority, type RejectedRecord } from "../../store/fold.ts";
import { isUlid } from "../../store/ulid.ts";
import {
  DREAM_OWNER_CLAIM_KIND,
  DREAM_OWNER_RELEASED_KIND,
  DREAM_OWNER_REQUEST_KIND,
} from "./constants.ts";

/** How the current owner's device got the role. */
export type DreamOwnerVia = "claim" | "force" | "request" | "release";

/** The current owner. */
export interface DreamOwner {
  readonly device: string;
  readonly agent: string;
  /** Clock of the record that last changed the owner's device or agent. */
  readonly revision: string;
}

/** A request the owner's device has not released yet. */
export interface DreamOwnerPending {
  readonly id: string;
  readonly device: string;
  readonly agent: string;
  /** Clock of the request record. */
  readonly at: string;
}

/** What became of a device's latest request. */
export type DreamOwnerRequestOutcome = "pending" | "granted" | "lost";

export interface DreamOwnerState {
  readonly owner: DreamOwner | null;
  /** The record that gave the owner's device the role (an agent change keeps it). */
  readonly since: StoreRecord | null;
  readonly via: DreamOwnerVia | null;
  readonly pending: DreamOwnerPending | null;
  /** By device, the latest request that device made and what became of it. */
  readonly requests: ReadonlyMap<
    string,
    { readonly id: string; readonly outcome: DreamOwnerRequestOutcome }
  >;
  /** Every valid claim, in fold order (the losers stay in the history). */
  readonly claims: number;
  readonly rejected: ReadonlyArray<RejectedRecord>;
}

export const DREAM_OWNER_KINDS: ReadonlySet<string> = new Set([
  DREAM_OWNER_CLAIM_KIND,
  DREAM_OWNER_REQUEST_KIND,
  DREAM_OWNER_RELEASED_KIND,
]);

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function rejection(record: StoreRecord): string | null {
  const device = record.body["device"];
  if (typeof device !== "string" || !isValidDeviceId(device)) return "missing or invalid device";
  if (device !== record.device) return "a device writes dream owner records only for itself";
  if (record.kind === DREAM_OWNER_RELEASED_KIND) {
    const request = record.body["request"];
    const to = record.body["to"];
    if (request === null && to === null) return null;
    if (!isUlid(request)) return "missing or invalid request id";
    if (typeof to !== "string" || !isValidDeviceId(to)) return "missing or invalid successor";
    return null;
  }
  if (recordAuthority(record) === null) return "missing or invalid authority";
  if (!nonEmpty(record.body["agent"])) return "missing agent";
  if (record.kind === DREAM_OWNER_CLAIM_KIND && typeof record.body["force"] !== "boolean") {
    return "force must be true or false";
  }
  return null;
}

/** Fold dream owner records (any order, duplicates allowed; other kinds ignored). */
export function foldDreamOwner(input: Iterable<StoreRecord>): DreamOwnerState {
  const { records } = prepareRecords(input);
  let owner: DreamOwner | null = null;
  let since: StoreRecord | null = null;
  let via: DreamOwnerVia | null = null;
  let pending: DreamOwnerPending | null = null;
  let claims = 0;
  const requests = new Map<string, { id: string; outcome: DreamOwnerRequestOutcome }>();
  const rejected: RejectedRecord[] = [];
  const losePending = (): void => {
    if (pending !== null) requests.set(pending.device, { id: pending.id, outcome: "lost" });
    pending = null;
  };
  const take = (record: StoreRecord, how: DreamOwnerVia, device: string, agent: string): void => {
    owner = { device, agent, revision: record.hlc };
    since = record;
    via = how;
  };
  for (const record of records) {
    if (!DREAM_OWNER_KINDS.has(record.kind)) continue;
    const reason = rejection(record);
    if (reason !== null) {
      rejected.push({ id: record.id, kind: record.kind, reason });
      continue;
    }
    const device = record.body["device"] as string;
    const current = owner as DreamOwner | null;
    if (record.kind === DREAM_OWNER_CLAIM_KIND) {
      claims += 1;
      const agent = (record.body["agent"] as string).trim();
      if (current === null) {
        take(record, record.body["force"] === true ? "force" : "claim", device, agent);
      } else if (current.device === device) {
        if (current.agent !== agent) owner = { device, agent, revision: record.hlc };
      } else if (record.body["force"] === true) {
        losePending();
        take(record, "force", device, agent);
      }
    } else if (record.kind === DREAM_OWNER_REQUEST_KIND) {
      const agent = (record.body["agent"] as string).trim();
      if (current === null) {
        losePending();
        take(record, "request", device, agent);
        requests.set(device, { id: record.id, outcome: "granted" });
      } else if (current.device !== device) {
        losePending();
        pending = { id: record.id, device, agent, at: record.hlc };
        requests.set(device, { id: record.id, outcome: "pending" });
      }
    } else {
      if (current === null || current.device !== record.device) continue;
      const open = pending as DreamOwnerPending | null;
      if (record.body["request"] === null) {
        losePending();
        owner = null;
        since = record;
        via = "release";
      } else if (open !== null && record.body["request"] === open.id) {
        take(record, "release", open.device, open.agent);
        requests.set(open.device, { id: open.id, outcome: "granted" });
        pending = null;
      }
    }
  }
  return { owner, since, via, pending, requests, claims, rejected };
}
