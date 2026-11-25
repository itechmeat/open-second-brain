/**
 * The dream work fold (design D1, D2): the `dream-work` records of the
 * partitions a device holds, and the dream owner records of the
 * `settings` stream, folded together in one total order (clock, device,
 * id; `prepareRecords`) into one state per item.
 *
 * Pure: no I/O, `now` is a parameter. Every device that holds the same
 * records folds the same states; only the owner's device writes them.
 *
 * Rules, judged at each record's place in the order:
 *
 *  - Every queue record is written by the device the owner fold names as
 *    the owner at that place. Any other is rejected (so a brain with no
 *    owner has no queue).
 *  - A second item record with an id already folded is ignored.
 *  - A lease raises the item's generation by more than every earlier
 *    lease; only the newest lease is live, and only until `expires_at`.
 *  - An answer is accepted only under the newest generation and for the
 *    item's own input; one answer per generation (the same receipt again
 *    is a duplicate).
 *  - An applied record needs the accepted answer it names.
 *  - Five failed attempts since the item or the last retry park it.
 *
 * Records that break a rule are rejected, listed and never applied, as in
 * the view writer fold.
 */

import type { StorePartition } from "../../store/constants.ts";
import type { StoreRecord } from "../../store/envelope.ts";
import { prepareRecords, type RejectedRecord } from "../../store/fold.ts";
import { DREAM_OWNER_KINDS, foldDreamOwner, type DreamOwner } from "../dream-owner/fold.ts";
import {
  DREAM_WORK_ANSWER_KIND,
  DREAM_WORK_APPLIED_KIND,
  DREAM_WORK_ATTEMPT_KIND,
  DREAM_WORK_CLOSED_KIND,
  DREAM_WORK_ITEM_KIND,
  DREAM_WORK_LEASE_KIND,
  DREAM_WORK_MAX_ATTEMPTS,
  DREAM_WORK_RETRY_KIND,
  DREAM_WORK_APPROVE_KIND,
  type DreamWorkStateName,
} from "./constants.ts";
import {
  dreamWorkBodyRejection,
  dreamWorkResourceBarrier,
  isDreamWorkKind,
  type DreamWorkAnswerBody,
  type DreamWorkAttemptBody,
  type DreamWorkClosedBody,
  type DreamWorkItemBody,
  type DreamWorkLeaseBody,
} from "./records.ts";

/** What an operation declares for the fold: what a closed predecessor means. */
export interface DreamWorkTraits {
  readonly closedPredecessor: "cancel" | "release";
  /** A text operation: held for review when `dream.apply_drafts` is `review`. */
  readonly text?: boolean;
}

export interface DreamWorkLease {
  readonly generation: number;
  readonly lease_token: string;
  readonly run: string;
  readonly expires_at: string;
  readonly device: string;
}

export interface DreamWorkAnswer {
  readonly record: string;
  readonly generation: number;
  readonly lease_token: string;
  readonly receipt: string;
  readonly value?: unknown;
  readonly text?: string;
  readonly agent: string;
  readonly model: string;
}

export interface DreamWorkItem {
  readonly id: string;
  readonly partition: StorePartition;
  readonly body: DreamWorkItemBody;
  /** The item record (its clock is the item's age). */
  readonly record: StoreRecord;
  /** Place of the item record in the fold order. */
  readonly place: number;
  readonly state: DreamWorkStateName;
  /** Waiting, its predecessors finished, no earlier holder of a resource, a known operation. */
  readonly ready: boolean;
  /** Not offered before this time (the backoff of the last failure). */
  readonly retry_at: string | null;
  /** Failed attempts since the item or the last retry. */
  readonly attempts: number;
  /** The newest lease's generation; 0 before the first take. */
  readonly generation: number;
  /** The newest lease while it is live. */
  readonly lease: DreamWorkLease | null;
  /** The newest lease when it expired with nothing ending it. */
  readonly lease_token: string | null;
  readonly expired: { readonly generation: number; readonly lease_token: string } | null;
  readonly answer: DreamWorkAnswer | null;
  readonly applied: { readonly generation: number; readonly effects: ReadonlyArray<string> } | null;
  readonly closed: {
    readonly reason: "cancelled" | "superseded";
    readonly note: string;
    readonly successor: string | null;
  } | null;
  /** The reason of the last failed attempt. */
  readonly last_reason: string | null;
  /** The reason of the last release, with the input it was given for. */
  readonly last_release: { readonly reason: string; readonly input_hash: string } | null;
  /** Ids (after supersession) of what holds the item back. */
  readonly blocked_by: ReadonlyArray<string>;
  /** Predecessors (after supersession) that are not finished. */
  readonly open_predecessors: ReadonlyArray<string>;
  /** Predecessors that were closed, for the operation's rule. */
  readonly closed_predecessors: ReadonlyArray<string>;
  /** The operation is unknown to this build: never ready. */
  readonly unknown_operation: boolean;
}

export interface DreamWorkState {
  readonly items: ReadonlyMap<string, DreamWorkItem>;
  /** Item ids in queue order: occurrence, then place in the fold. */
  readonly order: ReadonlyArray<string>;
  readonly rejected: ReadonlyArray<RejectedRecord>;
  /** The owner after every owner record. */
  readonly owner: DreamOwner | null;
}

export interface DreamWorkFoldInput {
  /** `dream-work` records with the partition each was read from. */
  readonly work: Iterable<{ readonly partition: StorePartition; readonly record: StoreRecord }>;
  /** Dream owner records of the `settings` stream of `shared`. */
  readonly owner: Iterable<StoreRecord>;
  /** Milliseconds since the epoch: what has expired and what is due. */
  readonly now: number;
  /**
   * The traits of an operation, or `undefined` when this build does not
   * know it. Without it every operation is known and a closed predecessor
   * cancels.
   */
  readonly operations?: (operation: string) => DreamWorkTraits | undefined;
  /** Partitions held by this device; absent means both for fixture folds. */
  readonly partitions?: ReadonlySet<StorePartition>;
  /** The shared setting `dream.apply_drafts` (default `auto`). */
  readonly applyDrafts?: "auto" | "review";
}

interface Building {
  id: string;
  partition: StorePartition;
  body: DreamWorkItemBody;
  record: StoreRecord;
  place: number;
  newest: DreamWorkLease | null;
  ended: boolean;
  answer: DreamWorkAnswer | null;
  applied: { generation: number; effects: string[] } | null;
  closed: DreamWorkItem["closed"];
  attempts: number;
  retry_at: string | null;
  last_reason: string | null;
  last_release: { reason: string; input_hash: string } | null;
  approved: boolean;
}

const DEFAULT_TRAITS: DreamWorkTraits = { closedPredecessor: "cancel" };

/** Fold dream work records (any order, duplicates allowed). */
export function foldDreamWork(input: DreamWorkFoldInput): DreamWorkState {
  const partitionOf = new Map<string, StorePartition>();
  const all: StoreRecord[] = [];
  for (const { partition, record } of input.work) {
    if (!isDreamWorkKind(record.kind)) continue;
    if (!partitionOf.has(record.id)) partitionOf.set(record.id, partition);
    all.push(record);
  }
  for (const record of input.owner) if (DREAM_OWNER_KINDS.has(record.kind)) all.push(record);
  const { records } = prepareRecords(all);

  const ownerRecords: StoreRecord[] = [];
  let owner: DreamOwner | null = null;
  const items = new Map<string, Building>();
  const rejected: RejectedRecord[] = [];
  let place = 0;
  const reject = (record: StoreRecord, reason: string): void => {
    rejected.push({ id: record.id, kind: record.kind, reason });
  };

  for (const record of records) {
    if (DREAM_OWNER_KINDS.has(record.kind)) {
      ownerRecords.push(record);
      owner = foldDreamOwner(ownerRecords).owner;
      continue;
    }
    const current = owner as DreamOwner | null;
    if (current === null) {
      reject(record, "no dream owner is bound");
      continue;
    }
    if (record.device !== current.device) {
      reject(record, `written by ${record.device}, not the dream owner ${current.device}`);
      continue;
    }
    const bodyReason = dreamWorkBodyRejection(record.kind, record.body);
    if (bodyReason !== null) {
      reject(record, bodyReason);
      continue;
    }
    if (record.kind === DREAM_WORK_ITEM_KIND) {
      const body = record.body as unknown as DreamWorkItemBody;
      if (items.has(body.id)) continue;
      items.set(body.id, {
        id: body.id,
        partition: partitionOf.get(record.id) ?? "shared",
        body,
        record,
        place: place++,
        newest: null,
        ended: false,
        answer: null,
        applied: null,
        closed: null,
        attempts: 0,
        retry_at: null,
        last_reason: null,
        last_release: null,
        approved: false,
      });
      continue;
    }
    const target = items.get(record.body["item"] as string);
    if (target === undefined) {
      reject(record, "names an item this fold does not hold");
      continue;
    }
    const reason = applyRecord(target, record);
    if (reason !== null) reject(record, reason);
  }

  return finish(items, rejected, owner, input);
}

/** Apply one record to its item; the rejection reason, or `null` when applied. */
function applyRecord(item: Building, record: StoreRecord): string | null {
  const generationOf = (): number => record.body["generation"] as number;
  switch (record.kind) {
    case DREAM_WORK_LEASE_KIND: {
      const body = record.body as unknown as DreamWorkLeaseBody;
      if (item.closed !== null) return "the item is closed";
      if (item.answer !== null) return "the item already has an accepted answer";
      if (body.generation < (item.newest?.generation ?? 0)) {
        return "the generation is not above every earlier lease";
      }
      if (body.generation === item.newest?.generation) {
        return "another lease already won this generation";
      }
      item.newest = {
        generation: body.generation,
        lease_token: body.lease_token,
        run: body.run,
        expires_at: body.expires_at,
        device: record.device,
      };
      item.ended = false;
      return null;
    }
    case DREAM_WORK_ANSWER_KIND: {
      const body = record.body as unknown as DreamWorkAnswerBody;
      if (item.closed !== null) return "the item is closed";
      if (item.newest === null || body.generation !== item.newest.generation) {
        return "the answer is not under the newest lease";
      }
      if (body.lease_token !== item.newest.lease_token) return "the lease token was replaced";
      if (item.answer !== null) {
        return item.answer.receipt === body.receipt ? null : "the lease already has an answer";
      }
      if (item.ended) return "the lease already ended";
      if (body.input_hash !== item.body.input_hash) return "the answer is for another input";
      item.answer = {
        record: record.id,
        generation: body.generation,
        lease_token: body.lease_token,
        receipt: body.receipt,
        ...(body.value !== undefined ? { value: body.value } : {}),
        ...(body.text !== undefined ? { text: body.text } : {}),
        agent: body.agent,
        model: body.model,
      };
      item.ended = true;
      return null;
    }
    case DREAM_WORK_ATTEMPT_KIND: {
      const body = record.body as unknown as DreamWorkAttemptBody;
      if (body.generation > (item.newest?.generation ?? 0)) return "no lease of that generation";
      if (body.generation !== item.newest!.generation)
        return "the attempt is not for the newest lease";
      if (body.lease_token !== item.newest!.lease_token) return "the lease token was replaced";
      if (body.outcome === "refused") return null;
      if (item.answer !== null && item.answer.generation === body.generation) {
        return "the lease already has an accepted answer";
      }
      if (item.ended) return null;
      item.ended = true;
      if (body.outcome === "failed") {
        item.attempts += 1;
        item.retry_at = body.retry_at;
        item.last_reason = body.reason;
      } else {
        item.last_release = {
          reason: body.reason,
          input_hash: body.input_hash ?? item.body.input_hash,
        };
      }
      return null;
    }
    case DREAM_WORK_APPLIED_KIND: {
      if (item.answer === null) return "no accepted answer to apply";
      if (
        item.answer.generation !== generationOf() ||
        item.answer.receipt !== record.body["receipt"] ||
        item.newest?.lease_token !== record.body["lease_token"]
      ) {
        return "the applied record names another answer";
      }
      if (item.closed !== null) return "the item is closed";
      if (item.applied !== null) return null;
      item.applied = {
        generation: generationOf(),
        effects: [...(record.body["effects"] as string[])],
      };
      return null;
    }
    case DREAM_WORK_CLOSED_KIND: {
      const body = record.body as unknown as DreamWorkClosedBody;
      if (item.applied !== null) return "the item is finished";
      if (item.closed !== null) return null;
      item.closed = { reason: body.reason, note: body.note, successor: body.successor };
      return null;
    }
    case DREAM_WORK_APPROVE_KIND:
      if (item.closed !== null || item.applied !== null) return "the item is no longer open";
      if (item.answer === null) return "no answer to approve";
      item.approved = true;
      return null;
    case DREAM_WORK_RETRY_KIND:
      if (item.closed !== null || item.applied !== null) return "the item is no longer open";
      item.attempts = 0;
      item.retry_at = null;
      return null;
    default:
      return "not a dream work kind";
  }
}

function stateOf(item: Building, now: number, review: boolean): DreamWorkStateName {
  if (item.closed !== null) return "closed";
  if (item.applied !== null) return "finished";
  if (item.answer !== null) return review && !item.approved ? "awaiting-review" : "accepted";
  if (item.attempts >= DREAM_WORK_MAX_ATTEMPTS) return "parked";
  if (item.newest !== null && !item.ended && now < Date.parse(item.newest.expires_at)) {
    return "leased";
  }
  return "waiting";
}

function compareOrder(a: Building, b: Building): number {
  if (a.body.occurrence !== b.body.occurrence) {
    return a.body.occurrence < b.body.occurrence ? -1 : 1;
  }
  return a.place - b.place;
}

/** States, readiness and order (design D2). */
function finish(
  items: Map<string, Building>,
  rejected: RejectedRecord[],
  owner: DreamOwner | null,
  input: DreamWorkFoldInput,
): DreamWorkState {
  const traitsOf = (operation: string): DreamWorkTraits | undefined =>
    input.operations === undefined ? DEFAULT_TRAITS : input.operations(operation);
  const states = new Map<string, DreamWorkStateName>();
  const review = input.applyDrafts === "review";
  for (const item of items.values()) {
    const text = traitsOf(item.body.operation)?.text === true;
    states.set(item.id, stateOf(item, input.now, review && text));
  }

  // Dependants that named a superseded id follow to its successor.
  const resolve = (id: string): string => {
    const seen = new Set<string>();
    let current = id;
    for (;;) {
      const closed = items.get(current)?.closed;
      if (closed?.reason !== "superseded" || closed.successor === null || seen.has(current)) {
        return current;
      }
      seen.add(current);
      current = closed.successor;
    }
  };

  const ordered = [...items.values()].toSorted(compareOrder);
  const afterById = new Map(ordered.map((item) => [item.id, item.body.after.map(resolve)]));
  const active = ordered.filter((item) => {
    const state = states.get(item.id)!;
    return state !== "finished" && state !== "closed";
  });
  const indegree = new Map(active.map((item) => [item.id, 0]));
  const dependants = new Map<string, string[]>();
  for (const item of active) {
    for (const predecessorId of new Set(afterById.get(item.id) ?? [])) {
      const predecessor = items.get(predecessorId);
      const predecessorState = states.get(predecessorId);
      if (
        predecessor === undefined ||
        predecessorState === "finished" ||
        predecessorState === "closed"
      ) {
        continue;
      }
      indegree.set(item.id, indegree.get(item.id)! + 1);
      dependants.set(predecessorId, [...(dependants.get(predecessorId) ?? []), item.id]);
    }
  }
  // Each step takes the earliest active item (in queue order) whose
  // predecessors are all placed: a min-heap of queue positions of the
  // items ready to place, so a large queue is ordered in n log n.
  const holderOrder: Building[] = [];
  const position = new Map(active.map((item, i) => [item.id, i]));
  const placed = new Set<string>();
  const heap = new PositionHeap();
  active.forEach((item, i) => {
    if (indegree.get(item.id) === 0) heap.push(i);
  });
  while (heap.size > 0) {
    const next = active[heap.pop()]!;
    placed.add(next.id);
    holderOrder.push(next);
    for (const dependant of dependants.get(next.id) ?? []) {
      const left = indegree.get(dependant)! - 1;
      indegree.set(dependant, left);
      if (left === 0) heap.push(position.get(dependant)!);
    }
  }
  // A cycle in resolved predecessors cannot be made runnable by resource ordering.
  if (holderOrder.length < active.length) {
    holderOrder.push(...active.filter((item) => !placed.has(item.id)));
  }
  const held = new Map<string, string>();
  for (const item of holderOrder) {
    for (const resource of item.body.resources) {
      if (!held.has(resource)) held.set(resource, item.id);
    }
  }
  const out = new Map<string, DreamWorkItem>();
  for (const item of ordered) {
    const state = states.get(item.id)!;
    const traits = traitsOf(item.body.operation);
    const blocked: string[] = [];
    const closedPredecessors: string[] = [];
    for (const raw of item.body.after) {
      const id = resolve(raw);
      const predecessor = states.get(id);
      if (predecessor === "finished") continue;
      if (predecessor === "closed") {
        if ((traits ?? DEFAULT_TRAITS).closedPredecessor === "release") continue;
        closedPredecessors.push(id);
      }
      blocked.push(id);
    }
    const openPredecessors = [...blocked];
    for (const resource of item.body.resources) {
      const holder = held.get(resource);
      if (holder !== undefined && !blocked.includes(holder)) {
        if (holder !== item.id) blocked.push(holder);
      }
    }
    const partitionHidden =
      item.body.private_resource_barriers.length > 0 &&
      input.partitions !== undefined &&
      !input.partitions.has("private");
    if (partitionHidden) {
      const barriers = new Set(item.body.private_resource_barriers);
      blocked.push(
        ...item.body.resources.filter((resource) =>
          barriers.has(dreamWorkResourceBarrier(resource)),
        ),
      );
    }
    const expired =
      state === "waiting" && item.newest !== null && !item.ended
        ? { generation: item.newest.generation, lease_token: item.newest.lease_token }
        : null;
    out.set(item.id, {
      id: item.id,
      partition: item.partition,
      body: item.body,
      record: item.record,
      place: item.place,
      state,
      ready: state === "waiting" && blocked.length === 0 && traits !== undefined,
      retry_at: item.retry_at,
      attempts: item.attempts,
      generation: item.newest?.generation ?? 0,
      lease: state === "leased" ? item.newest : null,
      lease_token: item.newest?.lease_token ?? null,
      expired,
      answer: item.answer,
      applied: item.applied,
      closed: item.closed,
      last_reason: item.last_reason,
      last_release: item.last_release,
      blocked_by: blocked,
      closed_predecessors: closedPredecessors,
      open_predecessors: openPredecessors,
      unknown_operation: traits === undefined,
    });
  }
  return { items: out, order: ordered.map((i) => i.id), rejected, owner };
}

/** A binary min-heap of non-negative integers (queue positions). */
class PositionHeap {
  readonly #a: number[] = [];

  get size(): number {
    return this.#a.length;
  }

  push(value: number): void {
    const a = this.#a;
    a.push(value);
    let i = a.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (a[parent]! <= a[i]!) break;
      [a[parent], a[i]] = [a[i]!, a[parent]!];
      i = parent;
    }
  }

  pop(): number {
    const a = this.#a;
    const top = a[0]!;
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l]! < a[m]!) m = l;
        if (r < a.length && a[r]! < a[m]!) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i]!, a[m]!];
        i = m;
      }
    }
    return top;
  }
}
