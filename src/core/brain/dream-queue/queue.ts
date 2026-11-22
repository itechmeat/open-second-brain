/**
 * The core functions of the dream work queue (design D4, D5, D6): produce,
 * take, answer, apply, release, retry, cancel, and the read-only status.
 *
 * The queue exists only for a brain served from the brain store; the pass
 * decides that before it calls anything here. Every function that writes
 * passes the dream owner gate before and after taking the device-local
 * queue lock (so a transfer during lock wait refuses the write; unknown
 * ownership refuses too), then takes that lock exactly once:
 * the lock is not re-entrant, so each entry point runs over unlocked
 * internal steps (read, fold, settle, supersede, produce) and no entry
 * point calls another. A take that cannot get the lock within its budget
 * returns nothing with the reason `busy`; the others throw the lock error.
 *
 * Settle runs first in take and apply: it turns what the pure fold
 * derives into records (a `released` attempt for an expired lease, a
 * `cancelled` close for a dependant of a closed item under the `cancel`
 * rule).
 */

import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { appendRecord } from "../../store/appender.ts";
import { STORE_PARTITIONS, type StorePartition } from "../../store/constants.ts";
import type { StoreRecord } from "../../store/envelope.ts";
import { observeClock } from "../../store/clock-store.ts";
import { compareRecords } from "../../store/envelope.ts";
import { parseHlc } from "../../store/hlc.ts";
import { isLockContention, withLocalLock } from "../../store/local-lock.ts";
import { lostHeldPartitions } from "../../store/held-ledger.ts";
import { readStreamRecords } from "../../store/read/stream-read.ts";
import { isStoreOnly } from "../../store/store-only.ts";
import { heldPartitions, type StoreHandle } from "../../store/store-open.ts";
import { resolveConfiguredStoreRoot } from "../../store/store-paths.ts";
import { DREAM_OWNER_KINDS, type DreamOwner } from "../dream-owner/fold.ts";
import { DREAM_OWNER_HERE_COMMAND } from "../dream-owner/constants.ts";
import { assertDreamOwnerOn, recheckDreamOwner } from "../dream-owner/gate.ts";
import { withDreamPassLock } from "../dream-owner/owner.ts";
import {
  DREAM_QUEUE_LOCK,
  DREAM_QUEUE_STATE_DIR,
  DREAM_QUEUE_RETRY_COMMAND,
  DREAM_QUEUE_UNBOUND_CODE,
  DREAM_WORK_BACKLOG_MS,
  DREAM_WORK_STATES,
  type DreamWorkStateName,
  DREAM_WORK_ANSWER_KIND,
  DREAM_WORK_APPLIED_KIND,
  DREAM_WORK_ATTEMPT_KIND,
  DREAM_WORK_BACKOFF_MS,
  DREAM_WORK_CLOSED_KIND,
  DREAM_WORK_ITEM_KIND,
  DREAM_WORK_LEASE_KIND,
  DREAM_WORK_LEASE_MS,
  DREAM_WORK_LOCK_BUDGET_MS,
  DREAM_WORK_RETRY_KIND,
  DREAM_WORK_STREAM,
} from "./constants.ts";
import { foldDreamWork, type DreamWorkItem, type DreamWorkState } from "./fold.ts";
import { dreamWorkOperation, dreamWorkTraits, type DreamWorkContext } from "./operations.ts";
import {
  dreamWorkInputHash,
  dreamWorkItemId,
  dreamWorkResourceBarrier,
  dreamWorkReceipt,
  dreamWorkBodyRejection,
  isDreamWorkKind,
  type DreamWorkAttemptOutcome,
  type DreamWorkItemBody,
} from "./records.ts";

/** A queue write on a brain with no dream owner: nothing may take or answer there. */
export class DreamQueueUnboundError extends Error {
  readonly code = DREAM_QUEUE_UNBOUND_CODE;
  constructor() {
    super(
      "dream queue: this brain has no dream owner, so its queue cannot be changed; " +
        `bind one with \`${DREAM_OWNER_HERE_COMMAND}\``,
    );
    this.name = "DreamQueueUnboundError";
  }
}

export class DreamQueueIncompleteSnapshotError extends Error {
  readonly unreadable: ReadonlyArray<string>;

  constructor(unreadable: ReadonlyArray<string>) {
    super(`dream queue: cannot change an incomplete snapshot (${unreadable.join(", ")})`);
    this.name = "DreamQueueIncompleteSnapshotError";
    this.unreadable = unreadable;
  }
}

/** A queue call about an item it cannot act on (unknown, or in the wrong state). */
export class DreamQueueItemError extends Error {
  constructor(message: string) {
    super(`dream queue: ${message}`);
    this.name = "DreamQueueItemError";
  }
}

export class DreamQueueValidationError extends Error {
  constructor(message: string) {
    super(`dream queue: ${message}`);
    this.name = "DreamQueueValidationError";
  }
}

/** The queue of one store on this device. */
export interface DreamQueue {
  readonly store: StoreHandle;
  readonly vault: string | null;
  /** Identity written on each record envelope. */
  readonly writer: string;
  readonly configPath?: string;
  /** Wall clock (default `Date.now`). */
  readonly now?: () => number;
  /** Owner observed by the live pass; entry points still recheck under their lock. */
  readonly passOwner?: DreamOwner;
}

/** The queue of `store`; every write passes the owner gate. */
export function dreamQueueOn(
  store: StoreHandle,
  options: Omit<DreamQueue, "store" | "passOwner">,
): DreamQueue {
  return { store, ...options };
}

/**
 * The queue a live pass uses after its own gate let it through on the
 * owner's device: the pass holds the pass lock, so a second look at the
 * role from inside it would only wait on that lock.
 */
export function dreamQueueForPass(
  store: StoreHandle,
  owner: DreamOwner,
  options: Omit<DreamQueue, "store" | "passOwner">,
): DreamQueue {
  return { store, ...options, passOwner: owner };
}

// ----- Reading ----------------------------------------------------------

interface Snapshot {
  readonly work: Array<{ partition: StorePartition; record: StoreRecord }>;
  readonly owner: StoreRecord[];
  readonly unreadable: string[];
  readonly pending: string[];
  readonly partitions: ReadonlySet<StorePartition>;
}

/** Read the queue's records of `partitions` and the owner records, at `root`. */
function readRecordsAt(root: string, partitions: ReadonlySet<StorePartition>): Snapshot {
  const work: Snapshot["work"] = [];
  const owner: StoreRecord[] = [];
  const unreadable: string[] = [];
  const pending: string[] = [];
  for (const partition of STORE_PARTITIONS) {
    if (!partitions.has(partition)) continue;
    const read = readStreamRecords(root, partition, { stream: DREAM_WORK_STREAM });
    for (const record of read.records) work.push({ partition, record });
    unreadable.push(...read.unreadable.map((rel) => `${partition}/${rel}`));
    for (const [kind, count] of read.pendingKinds) {
      if (isDreamWorkKind(kind) && count > 0) pending.push(`${partition}/${kind}:${count}`);
    }
  }
  if (partitions.has("shared")) {
    const settings = readStreamRecords(root, "shared", { stream: "settings" });
    for (const record of settings.records) {
      if (DREAM_OWNER_KINDS.has(record.kind)) owner.push(record);
    }
    unreadable.push(...settings.unreadable.map((rel) => `shared/settings/${rel}`));
    for (const [kind, count] of settings.pendingKinds) {
      if (DREAM_OWNER_KINDS.has(kind) && count > 0) unreadable.push(`shared/${kind}:${count}`);
    }
  }
  return { work, owner, unreadable: [...unreadable, ...pending], pending, partitions };
}

/**
 * {@link readRecordsAt} for a store open on this device. Every record read
 * raises the local clock (the receive rule), so what this device writes
 * next folds after what it has seen.
 */
function readSnapshot(store: StoreHandle, partitions: ReadonlySet<StorePartition>): Snapshot {
  const snapshot = readRecordsAt(store.root, partitions);
  let newest: StoreRecord | undefined;
  for (const { record } of snapshot.work) {
    if (newest === undefined || compareRecords(record, newest) > 0) newest = record;
  }
  if (newest !== undefined) {
    observeClock(store.deviceStateDir, store.device, parseHlc(newest.hlc)!);
  }
  return snapshot;
}

function foldSnapshot(snapshot: Snapshot, now: number): DreamWorkState {
  return foldDreamWork({
    work: snapshot.work,
    owner: snapshot.owner,
    now,
    operations: dreamWorkTraits,
    partitions: snapshot.partitions,
  });
}

/** The folded queue as this device holds it (no gate, no writes). */
export function readDreamWork(
  store: StoreHandle,
  options: { readonly now?: number } = {},
): DreamWorkState & { readonly unreadable: ReadonlyArray<string> } {
  const snapshot = readSnapshot(store, store.partitions);
  return { ...foldSnapshot(snapshot, options.now ?? Date.now()), unreadable: snapshot.unreadable };
}

// ----- Writing ----------------------------------------------------------

/** One entry point: gate, then the queue lock once, then `fn` over a fresh snapshot. */
function entry<T>(
  queue: DreamQueue,
  fn: (step: Step) => T,
  budgetMs: number = DREAM_WORK_LOCK_BUDGET_MS,
): T {
  const initialOwner = gate(queue);
  const target = join(queue.store.deviceStateDir, DREAM_QUEUE_STATE_DIR, DREAM_QUEUE_LOCK);
  const mutate = () =>
    withLocalLock(
      target,
      () => {
        const owner = recheckDreamOwner(
          {
            status: "owner",
            owner: initialOwner,
            device: queue.store.device,
            store: queue.store,
          },
          queue.now,
        );
        const snapshot = readSnapshot(queue.store, queue.store.partitions);
        if (snapshot.unreadable.length > 0) {
          throw new DreamQueueIncompleteSnapshotError(snapshot.unreadable);
        }
        const step = new Step(queue, owner, snapshot);
        const result = fn(step);
        step.confirm();
        return result;
      },
      budgetMs,
    );
  return queue.passOwner !== undefined
    ? mutate()
    : withDreamPassLock(queue.store, mutate, queue.now !== undefined ? { now: queue.now } : {});
}

function gate(queue: DreamQueue): DreamOwner {
  if (queue.passOwner !== undefined) {
    return recheckDreamOwner(
      {
        status: "owner",
        owner: queue.passOwner,
        device: queue.store.device,
        store: queue.store,
      },
      queue.now,
    );
  }
  const result = assertDreamOwnerOn(queue.store, {
    ...(queue.configPath !== undefined ? { configPath: queue.configPath } : {}),
    ...(queue.now !== undefined ? { now: queue.now } : {}),
  });
  if (result.status !== "owner") throw new DreamQueueUnboundError();
  return result.owner;
}

/** The unlocked internal steps of one entry point, over one snapshot. */
class Step {
  readonly #queue: DreamQueue;
  readonly owner: DreamOwner;
  readonly #snapshot: Snapshot;
  #state: DreamWorkState | null = null;
  readonly #written: string[] = [];

  constructor(queue: DreamQueue, owner: DreamOwner, snapshot: Snapshot) {
    this.#queue = queue;
    this.owner = owner;
    this.#snapshot = snapshot;
  }

  get now(): number {
    return (this.#queue.now ?? Date.now)();
  }

  get context(): DreamWorkContext {
    return {
      store: this.#queue.store,
      vault: this.#queue.vault,
      ...(this.#queue.configPath !== undefined ? { configPath: this.#queue.configPath } : {}),
    };
  }

  get store(): StoreHandle {
    return this.#queue.store;
  }

  fold(): DreamWorkState {
    return (this.#state ??= foldSnapshot(this.#snapshot, this.now));
  }

  item(id: string): DreamWorkItem {
    const found = this.fold().items.get(id);
    if (found === undefined) throw new DreamQueueItemError(`no item ${id} on this device`);
    return found;
  }

  write(partition: StorePartition, kind: string, body: Record<string, unknown>): StoreRecord {
    const rejection = dreamWorkBodyRejection(kind, body);
    if (rejection !== null) throw new DreamQueueValidationError(rejection);
    const appended = appendRecord(
      this.#queue.store,
      { partition, stream: DREAM_WORK_STREAM, kind, agent: this.#queue.writer, body },
      this.#queue.now !== undefined ? { now: this.#queue.now } : {},
    );
    this.#snapshot.work.push({ partition, record: appended.record });
    this.#written.push(appended.record.id);
    this.#state = null;
    return appended.record;
  }

  /** Re-read the store: what another process wrote meanwhile becomes visible. */
  reread(): void {
    const fresh = readSnapshot(this.#queue.store, this.#queue.store.partitions);
    if (fresh.unreadable.length > 0) throw new DreamQueueIncompleteSnapshotError(fresh.unreadable);
    this.#snapshot.work.splice(0, this.#snapshot.work.length, ...fresh.work);
    this.#snapshot.owner.splice(0, this.#snapshot.owner.length, ...fresh.owner);
    this.#state = null;
  }

  confirm(): void {
    if (this.#written.length === 0) return;
    this.reread();
    const ids = new Set(this.#snapshot.work.map(({ record }) => record.id));
    if (this.#written.some((id) => !ids.has(id))) {
      throw new DreamQueueIncompleteSnapshotError(["a queue append was not confirmed"]);
    }
    const rejected = new Map(this.fold().rejected.map((record) => [record.id, record]));
    if (
      this.#written.some((id) => {
        const record = rejected.get(id);
        return (
          record !== undefined &&
          !(
            record.kind === DREAM_WORK_LEASE_KIND &&
            record.reason === "another lease already won this generation"
          )
        );
      })
    ) {
      throw new DreamQueueItemError("a queue append was rejected during confirmation");
    }
  }

  attempt(
    item: DreamWorkItem,
    generation: number,
    leaseToken: string,
    outcome: DreamWorkAttemptOutcome,
    reason: string,
    retryAt: string | null = null,
  ): void {
    this.write(item.partition, DREAM_WORK_ATTEMPT_KIND, {
      item: item.id,
      generation,
      lease_token: leaseToken,
      outcome,
      reason,
      retry_at: retryAt,
    });
  }

  close(
    item: DreamWorkItem,
    reason: "cancelled" | "superseded",
    note: string,
    successor: string | null,
    authority: "human" | "agent",
  ): void {
    this.write(item.partition, DREAM_WORK_CLOSED_KIND, {
      item: item.id,
      reason,
      note,
      successor,
      authority,
    });
  }

  /** Write `body` as an item unless the fold already holds it. */
  produce(body: DreamWorkItemBody, partition: StorePartition): boolean {
    if (this.fold().items.has(body.id)) return false;
    this.write(partition, DREAM_WORK_ITEM_KIND, { ...body });
    return true;
  }

  /**
   * Settle what the fold derives: a released attempt for every expired
   * lease, a cancelled close for every dependant of a closed item under
   * the `cancel` rule.
   */
  settle(): void {
    for (const id of this.fold().order) {
      const item = this.fold().items.get(id)!;
      if (!this.store.partitions.has(item.partition)) continue;
      if (item.expired !== null) {
        this.attempt(
          item,
          item.expired.generation,
          item.expired.lease_token,
          "released",
          "the lease expired",
        );
      }
      if (
        item.closed_predecessors.length > 0 &&
        item.state !== "closed" &&
        item.state !== "finished"
      ) {
        this.close(
          item,
          "cancelled",
          `predecessor closed: ${item.closed_predecessors.join(", ")}`,
          null,
          "agent",
        );
      }
    }
  }

  /**
   * Reread the item's input. Returns the item when it still holds; closes
   * it (cancelled when the subject is gone, superseded by a successor
   * for a changed input) and returns what happened otherwise.
   */
  recheck(
    item: DreamWorkItem,
  ):
    | { readonly status: "current" }
    | { readonly status: "cancelled" }
    | { readonly status: "superseded"; readonly successor: string } {
    const operation = dreamWorkOperation(item.body.operation);
    if (operation === undefined) return { status: "current" };
    const input = operation.currentInput(item, this.context);
    if (input === null) {
      this.close(item, "cancelled", "subject gone", null, "agent");
      return { status: "cancelled" };
    }
    if (input.input_hash === item.body.input_hash) return { status: "current" };
    const identity = {
      operation: item.body.operation,
      subject: item.body.subject,
      occurrence: item.body.occurrence,
      input_hash: input.input_hash,
      prompt_version: item.body.prompt_version,
      schema_version: item.body.schema_version,
    };
    let successor: DreamWorkItemBody = {
      ...item.body,
      ...identity,
      id: dreamWorkItemId(identity),
      evidence: [...(input.evidence ?? item.body.evidence)],
      payload: { ...(input.payload ?? item.body.payload) },
    };
    if (this.fold().items.get(successor.id)?.state === "closed") {
      for (let attempt = 1; ; attempt += 1) {
        const reopened = {
          ...identity,
          occurrence: `${item.body.occurrence}/return-${attempt}`,
        };
        const id = dreamWorkItemId(reopened);
        if (!this.fold().items.has(id)) {
          successor = { ...successor, ...reopened, id };
          break;
        }
      }
    }
    this.produce(successor, item.partition);
    this.close(item, "superseded", "the input changed", successor.id, "agent");
    return { status: "superseded", successor: successor.id };
  }
}

function backoff(attempts: number): number {
  return DREAM_WORK_BACKOFF_MS[Math.min(attempts, DREAM_WORK_BACKOFF_MS.length - 1)]!;
}

// ----- Produce ----------------------------------------------------------

/** What a producer hands the queue. */
export interface ProduceSpec {
  readonly operation: string;
  readonly subject: string;
  readonly occurrence: string;
  /** The input the answer is produced for; hashed into `input_hash`. */
  readonly input: unknown;
  readonly prompt_version: string;
  readonly schema_version: string;
  readonly answer_schema: Readonly<Record<string, unknown>>;
  readonly after: ReadonlyArray<string>;
  readonly resources: ReadonlyArray<string>;
  readonly evidence: ReadonlyArray<string>;
  readonly payload: Readonly<Record<string, unknown>>;
  /** The partitions of the records the evidence and payload are built from. */
  readonly sources: ReadonlyArray<StorePartition>;
}

/** The partition of the most private source (design D5). */
export function dreamWorkPartition(sources: ReadonlyArray<StorePartition>): StorePartition {
  return sources.includes("private") ? "private" : "shared";
}

/** The item body `spec` describes. */
export function dreamWorkItemBody(spec: ProduceSpec): DreamWorkItemBody {
  const identity = {
    operation: spec.operation,
    subject: spec.subject,
    occurrence: spec.occurrence,
    input_hash: dreamWorkInputHash(spec.input),
    prompt_version: spec.prompt_version,
    schema_version: spec.schema_version,
  };
  return {
    id: dreamWorkItemId(identity),
    ...identity,
    answer_schema: { ...spec.answer_schema },
    after: [...spec.after],
    resources: [...spec.resources],
    private_resource_barriers: [],
    evidence: [...spec.evidence],
    payload: { ...spec.payload },
  };
}

/** Record the work unless it is already queued. */
export function produceWork(
  queue: DreamQueue,
  spec: ProduceSpec,
): { readonly id: string; readonly created: boolean; readonly partition: StorePartition } {
  const body = dreamWorkItemBody(spec);
  const partition = dreamWorkPartition(spec.sources);
  return entry(queue, (step) => {
    const barriers =
      partition === "shared"
        ? step
            .fold()
            .order.map((id) => step.fold().items.get(id)!)
            .filter(
              (item) =>
                item.partition === "private" &&
                item.body.occurrence <= body.occurrence &&
                item.state !== "finished" &&
                item.state !== "closed" &&
                item.body.resources.some((resource) => body.resources.includes(resource)),
            )
            .flatMap((item) =>
              item.body.resources.filter((resource) => body.resources.includes(resource)),
            )
            .map(dreamWorkResourceBarrier)
        : [];
    const itemBody = { ...body, private_resource_barriers: [...new Set(barriers)] };
    return { id: body.id, created: step.produce(itemBody, partition), partition };
  });
}

/**
 * The items of `operation` the fold holds, in queue order: what a
 * producer reads to know what it already handed out. No gate, no writes.
 */
export function producedItems(store: StoreHandle, operation: string): DreamWorkItem[] {
  const state = readDreamWork(store);
  return state.order
    .map((id) => state.items.get(id)!)
    .filter((item) => item.body.operation === operation);
}

// ----- Take -------------------------------------------------------------

export interface TakenItem {
  readonly id: string;
  readonly operation: string;
  readonly subject: string;
  readonly partition: StorePartition;
  readonly input_hash: string;
  readonly answer_schema: Readonly<Record<string, unknown>>;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly evidence: ReadonlyArray<string>;
  readonly generation: number;
  readonly lease_token: string;
  readonly expires_at: string;
}

export type TakeResult =
  | { readonly item: TakenItem; readonly reason?: undefined }
  | { readonly item: null; readonly reason: "empty" | "busy" };

/** Lease the first ready item this device may take. */
export function takeWork(
  queue: DreamQueue,
  options: { readonly run: string; readonly budgetMs?: number },
): TakeResult {
  try {
    return entry(queue, (step) => take(step, options.run), options.budgetMs);
  } catch (err) {
    if (isLockContention(err)) return { item: null, reason: "busy" };
    throw err;
  }
}

function take(step: Step, run: string): TakeResult {
  step.settle();
  for (let guard = 0; guard < 10_000; guard++) {
    const state = step.fold();
    const now = step.now;
    const next = state.order
      .map((id) => state.items.get(id)!)
      .find(
        (item) =>
          item.ready &&
          takeEligible(item, step.store.partitions) &&
          (item.retry_at === null || Date.parse(item.retry_at) <= now),
      );
    if (next === undefined) return { item: null, reason: "empty" };
    if (step.recheck(next).status !== "current") continue;
    const generation = next.generation + 1;
    const lease_token = randomUUID();
    const expires = new Date(now + DREAM_WORK_LEASE_MS).toISOString();
    const lease = step.write(next.partition, DREAM_WORK_LEASE_KIND, {
      item: next.id,
      generation,
      lease_token,
      run,
      owner_revision: step.owner.revision,
      expires_at: expires,
    });
    // A stale lock taken over can let a second worker lease the same
    // generation: the one that folds first keeps it, the other steps back.
    step.reread();
    if (step.fold().rejected.some((r) => r.id === lease.id)) {
      return { item: null, reason: "busy" };
    }
    const confirmed = step.fold().items.get(next.id);
    if (
      confirmed?.lease_token !== lease_token ||
      confirmed.lease === null ||
      Date.parse(confirmed.lease.expires_at) <= step.now
    ) {
      return { item: null, reason: "busy" };
    }
    return {
      item: {
        id: next.id,
        operation: next.body.operation,
        subject: next.body.subject,
        partition: next.partition,
        input_hash: next.body.input_hash,
        answer_schema: next.body.answer_schema,
        payload: next.body.payload,
        evidence: next.body.evidence,
        generation,
        lease_token,
        expires_at: expires,
      },
    };
  }
  return { item: null, reason: "empty" };
}

function takeEligible(item: DreamWorkItem, partitions: ReadonlySet<StorePartition>): boolean {
  return (
    partitions.has(item.partition) &&
    // A shared-only holder cannot establish resource order against private items that may arrive later.
    (partitions.has("private") || item.body.resources.length === 0)
  );
}

// ----- Answer -----------------------------------------------------------

export interface AnswerInput {
  readonly item: string;
  readonly generation: number;
  readonly lease_token: string;
  readonly value?: unknown;
  readonly text?: string;
  readonly agent: string;
  readonly model: string;
}

export type AnswerResult =
  | { readonly status: "accepted"; readonly receipt: string }
  | { readonly status: "refused"; readonly reason: string }
  | { readonly status: "failed"; readonly reason: string; readonly retry_at: string }
  | { readonly status: "superseded"; readonly successor: string }
  | { readonly status: "cancelled"; readonly reason: string };

/** Accept an answer only under the live lease and for the current input. */
export function answerWork(queue: DreamQueue, input: AnswerInput): AnswerResult {
  return entry(queue, (step) => answer(step, input));
}

function answer(step: Step, input: AnswerInput): AnswerResult {
  const item = step.item(input.item);
  const receipt = dreamWorkReceipt({
    item: item.id,
    generation: input.generation,
    input_hash: item.body.input_hash,
    ...(input.value !== undefined ? { value: input.value } : {}),
    ...(input.text !== undefined ? { text: input.text } : {}),
  });
  if (item.lease_token !== input.lease_token) {
    return { status: "refused", reason: "the lease token was replaced" };
  }
  if (item.answer !== null && item.answer.generation === input.generation) {
    if (item.answer.lease_token === input.lease_token && item.answer.receipt === receipt) {
      return { status: "accepted", receipt };
    }
  }
  const refuse = (reason: string): AnswerResult => {
    if (input.generation >= 1 && input.generation === item.generation) {
      step.attempt(item, input.generation, input.lease_token, "refused", reason);
    }
    return { status: "refused", reason };
  };
  if (item.state !== "leased" || item.lease?.generation !== input.generation) {
    return refuse(
      item.generation === input.generation
        ? `the lease is no longer live (the item is ${item.state})`
        : `the lease was replaced (generation ${item.generation})`,
    );
  }
  if (item.lease.device !== step.owner.device) {
    return refuse("the lease was granted by a previous dream owner");
  }
  const operation = dreamWorkOperation(item.body.operation);
  if (operation === undefined) return refuse(`operation ${item.body.operation} is unknown here`);
  if (item.open_predecessors.length > 0) {
    step.attempt(
      item,
      input.generation,
      input.lease_token,
      "released",
      "a predecessor is no longer finished",
    );
    return { status: "refused", reason: "a predecessor is no longer finished" };
  }
  const invalid = operation.validate({
    ...(input.value !== undefined ? { value: input.value } : {}),
    ...(input.text !== undefined ? { text: input.text } : {}),
  });
  if (invalid !== null) {
    const retryAt = new Date(step.now + backoff(item.attempts)).toISOString();
    step.attempt(item, input.generation, input.lease_token, "failed", invalid, retryAt);
    return { status: "failed", reason: invalid, retry_at: retryAt };
  }
  const recheck = step.recheck(item);
  if (recheck.status !== "current") {
    // The item is closed now; the refused attempt records the answer.
    step.attempt(
      item,
      input.generation,
      input.lease_token,
      "refused",
      "the input changed while the item was out",
    );
    return recheck.status === "superseded"
      ? recheck
      : { status: "cancelled", reason: "subject gone" };
  }
  if (Date.parse(item.lease.expires_at) <= step.now) {
    return refuse("the lease expired before the answer was accepted");
  }
  step.write(item.partition, DREAM_WORK_ANSWER_KIND, {
    item: item.id,
    generation: input.generation,
    lease_token: input.lease_token,
    input_hash: item.body.input_hash,
    ...(input.value !== undefined ? { value: input.value } : {}),
    ...(input.text !== undefined ? { text: input.text } : {}),
    agent: input.agent,
    model: input.model,
    receipt,
  });
  return { status: "accepted", receipt };
}

// ----- Apply ------------------------------------------------------------

export interface ApplyResult {
  readonly applied: ReadonlyArray<string>;
  readonly failed: ReadonlyArray<{ readonly item: string; readonly reason: string }>;
}

/** Apply every accepted answer, in queue order, on the owner's device. */
export function applyAccepted(queue: DreamQueue): ApplyResult {
  return entry(queue, (step) => {
    step.settle();
    const applied: string[] = [];
    const failed: Array<{ item: string; reason: string }> = [];
    const state = step.fold();
    for (const id of state.order) {
      const item = state.items.get(id)!;
      if (item.state !== "accepted" || item.answer === null) continue;
      if (item.blocked_by.length > 0) continue;
      if (!step.store.partitions.has(item.partition)) continue;
      const operation = dreamWorkOperation(item.body.operation);
      if (operation === undefined) continue;
      try {
        const effects = operation.apply(item, item.answer, step.context);
        step.write(item.partition, DREAM_WORK_APPLIED_KIND, {
          item: item.id,
          generation: item.answer.generation,
          lease_token: item.answer.lease_token,
          receipt: item.answer.receipt,
          effects,
        });
        applied.push(item.id);
      } catch (err) {
        failed.push({ item: item.id, reason: err instanceof Error ? err.message : String(err) });
      }
    }
    return { applied, failed };
  });
}

// ----- Release, retry, cancel --------------------------------------------

/** Give a lease back with no wait. */
export function releaseWork(
  queue: DreamQueue,
  input: { readonly item: string; readonly generation: number; readonly lease_token: string },
): { readonly released: boolean } {
  return entry(queue, (step) => {
    const item = step.item(input.item);
    if (
      item.state !== "leased" ||
      item.lease?.generation !== input.generation ||
      item.lease.lease_token !== input.lease_token ||
      Date.parse(item.lease.expires_at) <= step.now
    ) {
      return { released: false };
    }
    step.attempt(item, input.generation, input.lease_token, "released", "released by the worker");
    return { released: true };
  });
}

/** Offer a parked item again, its attempts counted from zero (a person's call). */
export function retryWork(queue: DreamQueue, id: string): void {
  entry(queue, (step) => {
    const item = step.item(id);
    if (item.state !== "parked") {
      throw new DreamQueueItemError(`item ${id} is ${item.state}, not parked`);
    }
    step.write(item.partition, DREAM_WORK_RETRY_KIND, { item: item.id, authority: "human" });
  });
}

/** Close an item as cancelled (a person's call). */
export function cancelWork(queue: DreamQueue, id: string, reason: string): void {
  entry(queue, (step) => {
    const item = step.item(id);
    if (item.state === "finished" || item.state === "closed") {
      throw new DreamQueueItemError(`item ${id} is ${item.state}`);
    }
    step.close(item, "cancelled", reason, null, "human");
  });
}

// ----- Status -----------------------------------------------------------

/** One item as the listing shows it. */
export interface DreamQueueListing {
  readonly id: string;
  readonly operation: string;
  readonly subject: string;
  readonly occurrence: string;
  readonly partition: StorePartition;
  readonly state: DreamWorkStateName;
  readonly ready: boolean;
  readonly attempts: number;
  readonly retry_at: string | null;
  readonly age_ms: number;
  readonly reason: string | null;
}

export interface DreamQueueParked {
  readonly id: string;
  readonly partition: StorePartition;
  readonly operation: string;
  readonly reason: string;
  readonly retry_command: string;
}

export type DreamQueueStatus =
  | {
      readonly available: true;
      readonly counts: Readonly<Record<DreamWorkStateName, number>>;
      /** Waiting items that may be taken now. */
      readonly ready: number;
      readonly oldest_ready: { readonly id: string; readonly age_ms: number } | null;
      /** The oldest ready item waited longer than the reporting threshold. */
      readonly backlog: boolean;
      readonly parked: ReadonlyArray<DreamQueueParked>;
      readonly unknown_operations: ReadonlyArray<string>;
      /** Records the fold rejected, by kind. */
      readonly rejected: Readonly<Record<string, number>>;
      readonly unreadable: ReadonlyArray<string>;
      /**
       * `held`: this device folds private work; `absent`: it never held
       * the partition and cannot know of any; `unknown`: it held the
       * partition and lost it.
       */
      readonly private: "held" | "absent" | "unknown";
      /** Whether this version has anything that answers items (it has not). */
      readonly executor: false;
      readonly items: ReadonlyArray<DreamQueueListing>;
    }
  | {
      readonly available: false;
      readonly reason: "legacy-tree" | "no-store";
      readonly message: string;
    };

function ageOf(item: DreamWorkItem, now: number): number {
  return Math.max(0, now - (parseHlc(item.record.hlc)?.physical ?? now));
}

/**
 * The queue of the store at `root` as this device holds it (design D8):
 * no gate and no writes, readable on any device, and on one whose
 * held-partition ledger shows a partition lost (where the store does not
 * open).
 */
export function queueStatusAt(
  root: string,
  options: {
    readonly now?: number;
    /** Below local reach: show nothing of the private partition. */
    readonly withholdPrivate?: boolean;
  } = {},
): DreamQueueStatus {
  const now = options.now ?? Date.now();
  const found = heldPartitions(root);
  const storeId = found.storeId;
  const held = new Set(found.held);
  if (options.withholdPrivate === true) held.delete("private");
  if (storeId === null) {
    return {
      available: false,
      reason: "no-store",
      message: "the queue starts with the brain store",
    };
  }
  const lost = lostHeldPartitions(root, held);
  const snapshot = readRecordsAt(root, held);
  const state = foldSnapshot(snapshot, now);
  const counts = Object.fromEntries(DREAM_WORK_STATES.map((s) => [s, 0])) as Record<
    DreamWorkStateName,
    number
  >;
  const items: DreamQueueListing[] = [];
  const parked: DreamQueueParked[] = [];
  const unknown = new Set<string>();
  let ready = 0;
  let oldest: { id: string; age_ms: number } | null = null;
  for (const id of state.order) {
    const item = state.items.get(id)!;
    counts[item.state] += 1;
    const age = ageOf(item, now);
    if (item.unknown_operation && item.state === "waiting") unknown.add(item.body.operation);
    const due = item.retry_at === null || Date.parse(item.retry_at) <= now;
    if (item.ready && due && takeEligible(item, held)) {
      ready += 1;
      if (oldest === null || age > oldest.age_ms) oldest = { id, age_ms: age };
    }
    if (item.state === "parked") {
      parked.push({
        id,
        partition: item.partition,
        operation: item.body.operation,
        reason: item.last_reason ?? "failed",
        retry_command: `${DREAM_QUEUE_RETRY_COMMAND} ${id}`,
      });
    }
    items.push({
      id,
      operation: item.body.operation,
      subject: item.body.subject,
      occurrence: item.body.occurrence,
      partition: item.partition,
      state: item.state,
      ready: item.ready && due && takeEligible(item, held),
      attempts: item.attempts,
      retry_at: item.retry_at,
      age_ms: age,
      reason: item.closed?.note ?? item.last_reason,
    });
  }
  const rejected: Record<string, number> = {};
  for (const r of state.rejected) rejected[r.kind] = (rejected[r.kind] ?? 0) + 1;
  return {
    available: true,
    counts,
    ready: snapshot.unreadable.length > 0 ? 0 : ready,
    oldest_ready: snapshot.unreadable.length > 0 ? null : oldest,
    backlog:
      snapshot.unreadable.length === 0 && oldest !== null && oldest.age_ms > DREAM_WORK_BACKLOG_MS,
    parked,
    unknown_operations: [...unknown].toSorted(),
    rejected,
    unreadable: snapshot.unreadable,
    private:
      options.withholdPrivate === true
        ? "absent"
        : held.has("private")
          ? "held"
          : lost.includes("private")
            ? "unknown"
            : "absent",
    executor: false,
    items,
  };
}

/**
 * {@link queueStatusAt} for the brain `vault` serves on this machine: a
 * brain still in the legacy tree has no queue yet.
 */
export function queueStatus(
  vault: string | null,
  options: {
    readonly configPath?: string;
    readonly now?: number;
    readonly withholdPrivate?: boolean;
  } = {},
): DreamQueueStatus {
  const context = {
    vault,
    ...(options.configPath !== undefined ? { configPath: options.configPath } : {}),
  };
  if (vault !== null && !isStoreOnly(context)) {
    return {
      available: false,
      reason: "legacy-tree",
      message: "the queue starts when the brain moves to the brain store",
    };
  }
  const { root } = resolveConfiguredStoreRoot(options.configPath);
  return queueStatusAt(root, {
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.withholdPrivate !== undefined ? { withholdPrivate: options.withholdPrivate } : {}),
  });
}
