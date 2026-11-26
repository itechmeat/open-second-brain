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

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import { appendRecord, appendRecords, type AppendInput } from "../../store/appender.ts";
import { STORE_PARTITIONS, type StorePartition } from "../../store/constants.ts";
import type { StoreRecord } from "../../store/envelope.ts";
import { observeClock } from "../../store/clock-store.ts";
import { compareRecords } from "../../store/envelope.ts";
import { parseHlc } from "../../store/hlc.ts";
import { isLockContention } from "../../store/local-lock.ts";
import { acquireProcessLock } from "../../store/process-lock.ts";
import { lostHeldPartitions } from "../../store/held-ledger.ts";
import { readStreamRecords, type ShardTails } from "../../store/read/stream-read.ts";
import { isStoreOnly } from "../../store/store-only.ts";
import { heldPartitions, type StoreHandle } from "../../store/store-open.ts";
import { resolveConfiguredStoreRoot } from "../../store/store-paths.ts";
import { DREAM_OWNER_KINDS, type DreamOwner } from "../dream-owner/fold.ts";
import { foldSettings, settingValue } from "../../store/fold-settings.ts";
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
  DREAM_WORK_APPROVE_KIND,
  DREAM_APPLY_DRAFTS_SETTING,
  DREAM_WORK_LEASE_KIND,
  DREAM_WORK_LEASE_MS,
  DREAM_WORK_LOCK_BUDGET_MS,
  DREAM_WORK_RETRY_KIND,
  DREAM_WORK_STREAM,
} from "./constants.ts";
import { foldDreamWork, type DreamWorkItem, type DreamWorkState } from "./fold.ts";
import {
  dreamWorkOperation,
  dreamWorkTraits,
  type DreamWorkContext,
  type DreamWorkReads,
} from "./operations.ts";
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
  /**
   * What the caller keeps between entry points (a session's server):
   * an operation's reread of an item's input reads incrementally through
   * it. Absent, every reread reads the store afresh.
   */
  readonly reads?: DreamWorkReads;
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
  /** Setting records of `dream.apply_drafts`. */
  readonly drafts: StoreRecord[];
  readonly unreadable: string[];
  readonly pending: string[];
  readonly partitions: ReadonlySet<StorePartition>;
}

/**
 * The kept tails of one stream a caller's reads hold (`ShardTails`), as
 * read options: with them a reread parses only what was appended since.
 */
function keptTails(
  reads: DreamWorkReads | undefined,
  root: string,
  partition: StorePartition,
  stream: string,
): { readonly tails?: ShardTails } {
  if (reads === undefined) return {};
  return {
    tails: reads.memo(`queue-tails:${root}:${partition}:${stream}`, (): ShardTails => new Map()),
  };
}

/** Read the queue's records of `partitions` and the owner records, at `root`. */
function readRecordsAt(
  root: string,
  partitions: ReadonlySet<StorePartition>,
  reads?: DreamWorkReads,
): Snapshot {
  const work: Snapshot["work"] = [];
  const owner: StoreRecord[] = [];
  const drafts: StoreRecord[] = [];
  const unreadable: string[] = [];
  const pending: string[] = [];
  for (const partition of STORE_PARTITIONS) {
    if (!partitions.has(partition)) continue;
    const read = readStreamRecords(
      root,
      partition,
      { stream: DREAM_WORK_STREAM },
      keptTails(reads, root, partition, DREAM_WORK_STREAM),
    );
    for (const record of read.records) work.push({ partition, record });
    unreadable.push(...read.unreadable.map((rel) => `${partition}/${rel}`));
    for (const [kind, count] of read.pendingKinds) {
      if (isDreamWorkKind(kind) && count > 0) pending.push(`${partition}/${kind}:${count}`);
    }
  }
  if (partitions.has("shared")) {
    const settings = readStreamRecords(
      root,
      "shared",
      { stream: "settings" },
      keptTails(reads, root, "shared", "settings"),
    );
    for (const record of settings.records) {
      if (DREAM_OWNER_KINDS.has(record.kind)) owner.push(record);
      else if (record.body["key"] === DREAM_APPLY_DRAFTS_SETTING) drafts.push(record);
    }
    unreadable.push(...settings.unreadable.map((rel) => `shared/settings/${rel}`));
    for (const [kind, count] of settings.pendingKinds) {
      if (DREAM_OWNER_KINDS.has(kind) && count > 0) unreadable.push(`shared/${kind}:${count}`);
    }
  }
  return { work, owner, drafts, unreadable: [...unreadable, ...pending], pending, partitions };
}

/**
 * {@link readRecordsAt} for a store open on this device. Every record read
 * raises the local clock (the receive rule), so what this device writes
 * next folds after what it has seen.
 */
function readSnapshot(
  store: StoreHandle,
  partitions: ReadonlySet<StorePartition>,
  reads?: DreamWorkReads,
): Snapshot {
  const snapshot = readRecordsAt(store.root, partitions, reads);
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
  const drafts = settingValue(foldSettings(snapshot.drafts), DREAM_APPLY_DRAFTS_SETTING);
  return foldDreamWork({
    work: snapshot.work,
    owner: snapshot.owner,
    now,
    operations: dreamWorkTraits,
    partitions: snapshot.partitions,
    applyDrafts: drafts === "review" ? "review" : "auto",
  });
}

/** The folded queue as this device holds it (no gate, no writes). */
export function readDreamWork(
  store: StoreHandle,
  options: { readonly now?: number; readonly reads?: DreamWorkReads } = {},
): DreamWorkState & { readonly unreadable: ReadonlyArray<string> } {
  const snapshot = readSnapshot(store, store.partitions, options.reads);
  return { ...foldSnapshot(snapshot, options.now ?? Date.now()), unreadable: snapshot.unreadable };
}

/**
 * {@link readDreamWork} read now and folded on first use: what a reader
 * that may not need the fold checks first (the read's completeness).
 */
export function readDreamWorkLater(
  store: StoreHandle,
  options: { readonly now?: number; readonly reads?: DreamWorkReads } = {},
): {
  readonly unreadable: ReadonlyArray<string>;
  /**
   * Changes whenever what the queue has finished can change: the applied
   * records and the owner records read (their count and ids). Leases,
   * answers, attempts and closes leave it as it is.
   */
  readonly finishedKey: string;
  fold(): DreamWorkState;
} {
  const snapshot = readSnapshot(store, store.partitions, options.reads);
  const now = options.now ?? Date.now();
  let state: DreamWorkState | undefined;
  return {
    unreadable: snapshot.unreadable,
    finishedKey: finishedKeyOf(snapshot),
    fold: () => (state ??= foldSnapshot(snapshot, now)),
  };
}

/** FNV-1a over the ids of the applied and owner records of a snapshot, with their count. */
function finishedKeyOf(snapshot: Snapshot): string {
  let hash = 0x811c9dc5;
  let count = 0;
  const mix = (id: string): void => {
    count += 1;
    for (let i = 0; i < id.length; i++) {
      hash ^= id.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  };
  for (const { record } of snapshot.work)
    if (record.kind === DREAM_WORK_APPLIED_KIND) mix(record.id);
  for (const record of snapshot.owner) mix(record.id);
  return `${count}:${hash.toString(16)}`;
}

/**
 * The folded queue of the store at `root`, over `partitions`, read only:
 * no gate, no writes, and the local clock is not raised (a reader with no
 * store handle: the topic review).
 */
export function readDreamWorkAt(
  root: string,
  partitions: ReadonlySet<StorePartition>,
  options: { readonly now?: number } = {},
): DreamWorkState & { readonly unreadable: ReadonlyArray<string> } {
  const snapshot = readRecordsAt(root, partitions);
  return {
    ...foldSnapshot(snapshot, options.now ?? Date.now()),
    unreadable: snapshot.unreadable,
  };
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
    withQueueLock(
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
        const snapshot = readSnapshot(queue.store, queue.store.partitions, queue.reads);
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

/**
 * Run `fn` holding the queue's lock. The lock is judged by its holder's
 * process (`process-lock.ts`), not by its age: a dream session's server
 * killed in a call (a session ended at its budget) leaves a holder that is
 * gone, and the worker's release of the session's leases, or the next
 * pass, takes the lock over at once instead of waiting out the age rule.
 */
function withQueueLock<T>(target: string, fn: () => T, budgetMs: number): T {
  mkdirSync(dirname(target), { recursive: true });
  const release = acquireProcessLock(target, {
    budgetMs,
    label: "dream queue lock",
    remedy: "retry once the other dream work finishes",
  });
  try {
    return fn();
  } finally {
    release();
  }
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
      now: this.now,
      ...(this.#queue.configPath !== undefined ? { configPath: this.#queue.configPath } : {}),
      ...(this.#queue.reads !== undefined ? { reads: this.#queue.reads } : {}),
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
    this.#writtenSinceReread = true;
    this.#state = null;
    return appended.record;
  }

  /** Whether this step wrote since it last reread the store (or never reread). */
  #writtenSinceReread = true;

  /** Writes gathered by {@link gather}, appended as one batch at its end. */
  #gathered: AppendInput[] | null = null;

  /**
   * Run `fn` with the writes it makes through {@link put} gathered and
   * appended as one batch (one clock tick, one fsync per shard) when it
   * ends, in the order made, whether it returns or throws.
   */
  gather<T>(fn: () => T): T {
    this.#gathered = [];
    try {
      return fn();
    } finally {
      this.flushGathered();
      this.#gathered = null;
    }
  }

  /** Append what {@link gather} has gathered so far, so the fold sees it. */
  flushGathered(): void {
    if (this.#gathered === null || this.#gathered.length === 0) return;
    const inputs = this.#gathered;
    this.#gathered = [];
    this.#appendAll(inputs);
  }

  /**
   * {@link write} for a record whose envelope the caller does not read:
   * gathered while {@link gather} runs, written at once otherwise.
   */
  put(partition: StorePartition, kind: string, body: Record<string, unknown>): void {
    if (this.#gathered === null) {
      this.write(partition, kind, body);
      return;
    }
    const rejection = dreamWorkBodyRejection(kind, body);
    if (rejection !== null) throw new DreamQueueValidationError(rejection);
    this.#gathered.push({
      partition,
      stream: DREAM_WORK_STREAM,
      kind,
      agent: this.#queue.writer,
      body,
    });
  }

  /** Validate and append `entries` as one batch; their records, in order. */
  writeAll(
    entries: ReadonlyArray<{
      readonly partition: StorePartition;
      readonly kind: string;
      readonly body: Record<string, unknown>;
    }>,
  ): StoreRecord[] {
    const inputs: AppendInput[] = entries.map(({ partition, kind, body }) => {
      const rejection = dreamWorkBodyRejection(kind, body);
      if (rejection !== null) throw new DreamQueueValidationError(rejection);
      return { partition, stream: DREAM_WORK_STREAM, kind, agent: this.#queue.writer, body };
    });
    return this.#appendAll(inputs);
  }

  #appendAll(inputs: ReadonlyArray<AppendInput>): StoreRecord[] {
    if (inputs.length === 0) return [];
    const appended = appendRecords(
      this.#queue.store,
      inputs,
      this.#queue.now !== undefined ? { now: this.#queue.now } : {},
    );
    const records = appended.map((result, i) => {
      this.#snapshot.work.push({ partition: inputs[i]!.partition, record: result.record });
      this.#written.push(result.record.id);
      return result.record;
    });
    this.#writtenSinceReread = true;
    this.#state = null;
    return records;
  }

  /** Re-read the store: what another process wrote meanwhile becomes visible. */
  reread(): void {
    const fresh = readSnapshot(this.#queue.store, this.#queue.store.partitions, this.#queue.reads);
    if (fresh.unreadable.length > 0) throw new DreamQueueIncompleteSnapshotError(fresh.unreadable);
    this.#snapshot.work.splice(0, this.#snapshot.work.length, ...fresh.work);
    this.#snapshot.owner.splice(0, this.#snapshot.owner.length, ...fresh.owner);
    this.#writtenSinceReread = false;
    this.#state = null;
  }

  confirm(): void {
    if (this.#written.length === 0) return;
    // A reread made after the last write already holds what a new one
    // would read: the step holds the queue lock, and nothing it wrote
    // came after it.
    if (this.#writtenSinceReread) this.reread();
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
    inputHash?: string,
  ): void {
    this.put(item.partition, DREAM_WORK_ATTEMPT_KIND, {
      item: item.id,
      generation,
      lease_token: leaseToken,
      outcome,
      reason,
      retry_at: retryAt,
      ...(inputHash !== undefined ? { input_hash: inputHash } : {}),
    });
  }

  close(
    item: DreamWorkItem,
    reason: "cancelled" | "superseded",
    note: string,
    successor: string | null,
    authority: "human" | "agent",
  ): void {
    this.put(item.partition, DREAM_WORK_CLOSED_KIND, {
      item: item.id,
      reason,
      note,
      successor,
      authority,
    });
  }

  /** Ids this step wrote as items: known without folding again. */
  readonly #produced = new Set<string>();

  /** Write `body` as an item unless the fold already holds it. */
  produce(body: DreamWorkItemBody, partition: StorePartition): boolean {
    if (!this.#producible(body)) return false;
    this.write(partition, DREAM_WORK_ITEM_KIND, { ...body });
    this.#produced.add(body.id);
    return true;
  }

  #producible(body: DreamWorkItemBody): boolean {
    if (this.#produced.has(body.id)) return false;
    // The fold of the snapshot as read: items this step writes are known by id.
    return !(this.#state ?? this.#base()).items.has(body.id);
  }

  /**
   * {@link produce} for many items: each that the fold does not hold yet
   * is written, in order, as one batch append (one clock tick, one write
   * and one fsync per shard) instead of one append per item. Returns, in
   * order, whether each was written.
   */
  produceMany(
    entries: ReadonlyArray<{
      readonly body: DreamWorkItemBody;
      readonly partition: StorePartition;
    }>,
  ): boolean[] {
    const created = entries.map(({ body }) => {
      if (!this.#producible(body)) return false;
      const rejection = dreamWorkBodyRejection(DREAM_WORK_ITEM_KIND, { ...body });
      if (rejection !== null) throw new DreamQueueValidationError(rejection);
      this.#produced.add(body.id);
      return true;
    });
    const inputs: AppendInput[] = entries
      .filter((_, i) => created[i])
      .map(({ body, partition }) => ({
        partition,
        stream: DREAM_WORK_STREAM,
        kind: DREAM_WORK_ITEM_KIND,
        agent: this.#queue.writer,
        body: { ...body },
      }));
    this.#appendAll(inputs);
    return created;
  }

  /** The fold of the snapshot as it was read, kept for producing. */
  #baseState: DreamWorkState | null = null;
  #base(): DreamWorkState {
    return (this.#baseState ??= foldSnapshot(this.#snapshot, this.now));
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
    | { readonly status: "unavailable" }
    | { readonly status: "superseded"; readonly successor: string } {
    const operation = dreamWorkOperation(item.body.operation);
    if (operation === undefined) return { status: "current" };
    const input = operation.currentInput(item, this.context);
    if (input?.unavailable === true) return { status: "unavailable" };
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
    // The fold as last made (or as read): a recheck does not fold the
    // queue again for what this step wrote, so closing many stale items
    // in one take costs one fold, not one per item. What this step wrote
    // as items is known by id.
    const known = this.#state ?? this.#base();
    if (known.items.get(successor.id)?.state === "closed") {
      for (let attempt = 1; ; attempt += 1) {
        const reopened = {
          ...identity,
          occurrence: `${item.body.occurrence}/return-${attempt}`,
        };
        const id = dreamWorkItemId(reopened);
        if (!known.items.has(id) && !this.#produced.has(id)) {
          successor = { ...successor, ...reopened, id };
          break;
        }
      }
    }
    const partition =
      item.partition === "private" || input.partition === "private" ? "private" : item.partition;
    this.produce(successor, partition);
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
    const state = step.fold();
    const prior: PrivateBarrierItem[] = state.order.map((id) => state.items.get(id)!);
    const barriers = privateResourceBarriers(body, partition, prior);
    const itemBody = { ...body, private_resource_barriers: [...new Set(barriers)] };
    return { id: body.id, created: step.produce(itemBody, partition), partition };
  });
}

/**
 * Record every piece of work in `specs` that is not already queued, under
 * one gate, one lock and one read: producing a backlog item by item would
 * read and fold the whole stream once per item. The results are aligned
 * with `specs`, as {@link produceWork} would answer each.
 */
export function produceWorkBatch(
  queue: DreamQueue,
  specs: ReadonlyArray<ProduceSpec>,
): {
  readonly items: ReadonlyArray<{
    readonly id: string;
    readonly created: boolean;
    readonly partition: StorePartition;
  }>;
} {
  if (specs.length === 0) return { items: [] };
  const bodies = specs.map((spec) => ({
    body: dreamWorkItemBody(spec),
    partition: dreamWorkPartition(spec.sources),
  }));
  return entry(queue, (step) => {
    const state = step.fold();
    const prior: PrivateBarrierItem[] = state.order.map((id) => state.items.get(id)!);
    // Barriers are judged item by item, each against the private items
    // before it (in the store or earlier in this batch), then the new
    // items are written as one batch.
    const seen = new Set<string>();
    const planned = bodies.map(({ body, partition }) => {
      const barriers = privateResourceBarriers(body, partition, prior);
      const fresh = !seen.has(body.id) && !state.items.has(body.id);
      seen.add(body.id);
      if (partition === "private" && fresh) prior.push({ body, partition, state: "waiting" });
      return { body: { ...body, private_resource_barriers: barriers }, partition };
    });
    const created = step.produceMany(planned);
    return {
      items: planned.map(({ body, partition }, i) => ({
        id: body.id,
        created: created[i]!,
        partition,
      })),
    };
  });
}

function privateResourceBarriers(
  body: DreamWorkItemBody,
  partition: StorePartition,
  items: ReadonlyArray<PrivateBarrierItem>,
): string[] {
  if (partition !== "shared") return [];
  return [
    ...new Set(
      items
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
        .map(dreamWorkResourceBarrier),
    ),
  ];
}

type PrivateBarrierItem = Pick<DreamWorkItem, "partition" | "state"> & {
  readonly body: Pick<DreamWorkItemBody, "occurrence" | "resources">;
};

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
  options: {
    readonly run: string;
    readonly budgetMs?: number;
    /** Only items this admits are taken (an executor's operations). */
    readonly filter?: (item: DreamWorkItem) => boolean;
  },
): TakeResult {
  try {
    return entry(queue, (step) => take(step, options.run, options.filter), options.budgetMs);
  } catch (err) {
    if (isLockContention(err)) return { item: null, reason: "busy" };
    throw err;
  }
}

/**
 * {@link takeWork} for up to `max` items under one gate, one lock, one
 * settle and one confirmation of the leases: each item is picked, its
 * input rechecked and its lease written exactly as one take does, in
 * queue order. The items are picked from one fold (a lease changes only
 * its own item), folded again only after a recheck closed an item; a
 * lease the confirming reread does not show as live is left out.
 */
export function takeWorkBatch(
  queue: DreamQueue,
  options: {
    readonly run: string;
    readonly max: number;
    readonly budgetMs?: number;
    readonly filter?: (item: DreamWorkItem) => boolean;
  },
): { readonly items: ReadonlyArray<TakenItem>; readonly reason: "empty" | "busy" | null } {
  try {
    return entry(
      queue,
      (step) => takeMany(step, options.run, options.filter, options.max),
      options.budgetMs,
    );
  } catch (err) {
    if (isLockContention(err)) return { items: [], reason: "busy" };
    throw err;
  }
}

function takeMany(
  step: Step,
  run: string,
  filter: ((item: DreamWorkItem) => boolean) | undefined,
  max: number,
): { readonly items: ReadonlyArray<TakenItem>; readonly reason: "empty" | "busy" | null } {
  step.settle();
  const unavailable = new Set<string>();
  const chosen = new Set<string>();
  const picked: Array<{
    readonly partition: StorePartition;
    readonly body: Record<string, unknown>;
    readonly item: TakenItem;
  }> = [];
  // One fold per round: an item a recheck closes is passed over and the
  // scan goes on in the same fold (closing an item never makes another
  // one ready in it: its successor, or the next item holding its
  // resources, waits for the next round). Only when the round closed
  // something and the batch is not full is the queue folded again.
  const passed = new Set<string>();
  pick: for (let guard = 0; picked.length < max && guard < 10_000; guard++) {
    const state = step.fold();
    const now = step.now;
    let closedAny = false;
    for (const id of state.order) {
      if (picked.length >= max) break pick;
      const next = state.items.get(id)!;
      if (
        chosen.has(id) ||
        unavailable.has(id) ||
        passed.has(id) ||
        !next.ready ||
        !takeEligible(next, step.store.partitions) ||
        (next.retry_at !== null && Date.parse(next.retry_at) > now) ||
        (filter !== undefined && !filter(next))
      ) {
        continue;
      }
      const checked = step.recheck(next);
      if (checked.status === "unavailable") {
        unavailable.add(id);
        continue;
      }
      // A recheck that closed the item may have written its successor:
      // it is offered in the next round's fold.
      if (checked.status !== "current") {
        passed.add(id);
        closedAny = true;
        continue;
      }
      chosen.add(id);
      const generation = next.generation + 1;
      const lease_token = randomUUID();
      const expires = new Date(now + DREAM_WORK_LEASE_MS).toISOString();
      picked.push({
        partition: next.partition,
        body: {
          item: next.id,
          generation,
          lease_token,
          run,
          owner_revision: step.owner.revision,
          expires_at: expires,
        },
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
      });
    }
    if (!closedAny) break;
  }
  if (picked.length === 0) return { items: [], reason: "empty" };
  // The leases as one batch append, then one reread confirms every lease,
  // as a take confirms its one.
  const records = step.writeAll(
    picked.map(({ partition, body }) => ({ partition, kind: DREAM_WORK_LEASE_KIND, body })),
  );
  const leased = picked.map(({ item }, i) => ({ lease: records[i]!, item }));
  step.reread();
  const confirmed = step.fold();
  const rejected = new Set(confirmed.rejected.map((r) => r.id));
  const items = leased
    .filter(({ lease, item }) => {
      if (rejected.has(lease.id)) return false;
      const now = confirmed.items.get(item.id);
      return (
        now?.lease_token === item.lease_token &&
        now.lease !== null &&
        Date.parse(now.lease.expires_at) > step.now
      );
    })
    .map(({ item }) => item);
  return { items, reason: items.length === 0 ? "busy" : null };
}

function take(
  step: Step,
  run: string,
  filter: ((item: DreamWorkItem) => boolean) | undefined,
): TakeResult {
  step.settle();
  const unavailable = new Set<string>();
  // One fold per round, as in a batch: an item a recheck closes is passed
  // over in the same fold; the queue is folded again only after a round
  // that closed something and found nothing to take.
  const passed = new Set<string>();
  for (let guard = 0; guard < 10_000; guard++) {
    const state = step.fold();
    const now = step.now;
    let closedAny = false;
    let next: DreamWorkItem | undefined;
    for (const id of state.order) {
      const item = state.items.get(id)!;
      if (
        !item.ready ||
        unavailable.has(item.id) ||
        passed.has(item.id) ||
        !takeEligible(item, step.store.partitions) ||
        (item.retry_at !== null && Date.parse(item.retry_at) > now) ||
        (filter !== undefined && !filter(item))
      ) {
        continue;
      }
      const checked = step.recheck(item);
      if (checked.status === "unavailable") {
        unavailable.add(item.id);
        continue;
      }
      if (checked.status !== "current") {
        passed.add(item.id);
        closedAny = true;
        continue;
      }
      next = item;
      break;
    }
    if (next === undefined) {
      if (closedAny) continue;
      return { item: null, reason: "empty" };
    }
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
  | { readonly status: "unavailable"; readonly reason: string }
  | { readonly status: "refused"; readonly reason: string }
  | { readonly status: "failed"; readonly reason: string; readonly retry_at: string }
  | { readonly status: "superseded"; readonly successor: string }
  | { readonly status: "cancelled"; readonly reason: string };

/** Accept an answer only under the live lease and for the current input. */
export function answerWork(queue: DreamQueue, input: AnswerInput): AnswerResult {
  return entry(queue, (step) => answer(step, input));
}

/**
 * {@link answerWork} for several answers under one gate, one lock and one
 * confirmation: each is checked, rechecked, validated and recorded exactly
 * as one answer is, in order. An answer about an item this device does
 * not hold is refused on its own. The items are read from one fold:
 * an answer changes only its own item, and an item named twice is read
 * again before its second answer.
 */
export function answerWorkBatch(
  queue: DreamQueue,
  inputs: ReadonlyArray<AnswerInput>,
): AnswerResult[] {
  if (inputs.length === 0) return [];
  return entry(queue, (step) =>
    // The answers' records are appended as one batch at the end; an item
    // named again first gets the earlier answers written and folded.
    step.gather(() => {
      const state = step.fold();
      const seen = new Set<string>();
      return inputs.map((input) => {
        const again = seen.has(input.item);
        if (again) step.flushGathered();
        const known = again ? undefined : state.items.get(input.item);
        seen.add(input.item);
        try {
          return answer(step, input, known);
        } catch (err) {
          if (err instanceof DreamQueueItemError) {
            return { status: "refused" as const, reason: err.message };
          }
          throw err;
        }
      });
    }),
  );
}

function answer(step: Step, input: AnswerInput, known?: DreamWorkItem): AnswerResult {
  const item = known ?? step.item(input.item);
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
  const invalid = operation.validate(
    {
      ...(input.value !== undefined ? { value: input.value } : {}),
      ...(input.text !== undefined ? { text: input.text } : {}),
    },
    item,
  );
  if (invalid !== null) {
    const retryAt = new Date(step.now + backoff(item.attempts)).toISOString();
    step.attempt(item, input.generation, input.lease_token, "failed", invalid, retryAt);
    return { status: "failed", reason: invalid, retry_at: retryAt };
  }
  const recheck = step.recheck(item);
  if (recheck.status === "unavailable") {
    return { status: "unavailable", reason: "current input is unavailable" };
  }
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
  step.put(item.partition, DREAM_WORK_ANSWER_KIND, {
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
      // Topic planning applies these under its own lock.
      if (operation.appliedBy === "planning") continue;
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

/**
 * Give a lease back with no wait. `reason` (an executor's: `shadow`,
 * `egress-refused`) is kept by the fold with the item's input, so the
 * executor can tell it already asked about that input.
 */
export function releaseWork(
  queue: DreamQueue,
  input: {
    readonly item: string;
    readonly generation: number;
    readonly lease_token: string;
    readonly reason?: string;
  },
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
    step.attempt(
      item,
      input.generation,
      input.lease_token,
      "released",
      input.reason ?? "released by the worker",
      null,
      input.reason !== undefined ? item.body.input_hash : undefined,
    );
    return { released: true };
  });
}

/** Release every lease `run` still holds, under one lock; returns how many. */
export function releaseRunWork(queue: DreamQueue, run: string): number {
  return entry(queue, (step) => {
    let released = 0;
    const state = step.fold();
    for (const id of state.order) {
      const item = state.items.get(id)!;
      if (item.state !== "leased" || item.lease === null || item.lease.run !== run) continue;
      if (!step.store.partitions.has(item.partition)) continue;
      step.attempt(
        item,
        item.lease.generation,
        item.lease.lease_token,
        "released",
        "the session ended",
      );
      released += 1;
    }
    return released;
  });
}

/**
 * End a lease with a failed attempt (an executor that could not answer:
 * a timeout, a refused request): the backoff and parking of design D1
 * apply.
 */
export function failWork(
  queue: DreamQueue,
  input: {
    readonly item: string;
    readonly generation: number;
    readonly lease_token: string;
    readonly reason: string;
  },
): { readonly failed: boolean; readonly retry_at: string | null } {
  return entry(queue, (step) => {
    const item = step.item(input.item);
    if (
      item.state !== "leased" ||
      item.lease?.generation !== input.generation ||
      item.lease.lease_token !== input.lease_token ||
      Date.parse(item.lease.expires_at) <= step.now
    ) {
      return { failed: false, retry_at: null };
    }
    const retryAt = new Date(step.now + backoff(item.attempts)).toISOString();
    step.attempt(item, input.generation, input.lease_token, "failed", input.reason, retryAt);
    return { failed: true, retry_at: retryAt };
  });
}

/**
 * Mark accepted items of an operation applied by planning as applied,
 * with the ids of the records planning wrote for each (or a marker such
 * as `abstained`), under one gate and one lock. An item that is not
 * accepted is refused and left as it is.
 */
export function markAppliedByPlanning(
  queue: DreamQueue,
  entries: ReadonlyArray<{
    readonly item: string;
    readonly generation: number;
    readonly lease_token: string;
    readonly receipt: string;
    readonly effects: ReadonlyArray<string>;
  }>,
): {
  readonly applied: ReadonlyArray<string>;
  readonly refused: ReadonlyArray<{ readonly item: string; readonly reason: string }>;
} {
  if (entries.length === 0) return { applied: [], refused: [] };
  return entry(queue, (step) => {
    const applied: string[] = [];
    const refused: Array<{ item: string; reason: string }> = [];
    const state = step.fold();
    for (const { item: id, generation, lease_token, receipt, effects } of entries) {
      const item = state.items.get(id);
      if (item === undefined) {
        refused.push({ item: id, reason: "no such item on this device" });
        continue;
      }
      if (item.state !== "accepted" || item.answer === null) {
        refused.push({ item: id, reason: `the item is ${item.state}, not accepted` });
        continue;
      }
      if (
        item.answer.generation !== generation ||
        item.answer.lease_token !== lease_token ||
        item.answer.receipt !== receipt
      ) {
        refused.push({ item: id, reason: "the accepted answer was replaced" });
        continue;
      }
      step.write(item.partition, DREAM_WORK_APPLIED_KIND, {
        item: item.id,
        generation,
        lease_token,
        receipt,
        effects: [...effects],
      });
      applied.push(item.id);
    }
    return { applied, refused };
  });
}

/**
 * Close accepted items whose subject changed before planning applied
 * them: reread each item's input, cancel it when the subject is gone and
 * supersede it when the input changed. An item still current is left.
 */
export function recheckAccepted(
  queue: DreamQueue,
  ids: ReadonlyArray<string>,
): ReadonlyArray<{ readonly item: string; readonly status: string }> {
  if (ids.length === 0) return [];
  return entry(queue, (step) =>
    ids.map((id) => {
      const item = step.fold().items.get(id);
      if (item === undefined || item.state !== "accepted") return { item: id, status: "skipped" };
      return { item: id, status: step.recheck(item).status };
    }),
  );
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

/** Approve a text answer held for review: the next pass applies it (a person's call). */
export function approveWork(queue: DreamQueue, id: string): void {
  entry(queue, (step) => {
    const item = step.item(id);
    if (item.state !== "awaiting-review") {
      throw new DreamQueueItemError(`item ${id} is ${item.state}, not awaiting review`);
    }
    step.write(item.partition, DREAM_WORK_APPROVE_KIND, { item: item.id, authority: "human" });
  });
}

/** Close a text answer held for review: nothing is written (a person's call). */
export function rejectWork(queue: DreamQueue, id: string, reason: string): void {
  entry(queue, (step) => {
    const item = step.item(id);
    if (item.state !== "awaiting-review") {
      throw new DreamQueueItemError(`item ${id} is ${item.state}, not awaiting review`);
    }
    step.close(item, "cancelled", `rejected: ${reason}`, null, "human");
  });
}

/** Close an item as cancelled (a person's call). */
/**
 * Close the open items that ask a question again: of every operation in
 * `operations`, the waiting items about a subject (same question version)
 * that has a newer open item are closed as superseded by the newest one,
 * in one entry and one append. A take would close each of them when it
 * reached it (its input changed); closing them at once keeps the queue's
 * counts true and its takes short. An item out on a lease, answered, or
 * set aside for its own input (`setAside`) is never closed here, and the
 * newest open item is always kept. Returns how many were closed.
 */
export function closeDuplicateWork(
  queue: DreamQueue,
  operations: ReadonlySet<string>,
  setAside: (item: DreamWorkItem) => boolean = () => false,
): number {
  return entry(queue, (step) => {
    const state = step.fold();
    const groups = new Map<string, DreamWorkItem[]>();
    for (const id of state.order) {
      const item = state.items.get(id)!;
      if (!operations.has(item.body.operation)) continue;
      if (!step.store.partitions.has(item.partition)) continue;
      const open =
        item.state === "waiting" ||
        item.state === "leased" ||
        item.state === "accepted" ||
        item.state === "awaiting-review";
      if (!open || setAside(item)) continue;
      const key = [
        item.body.operation,
        item.body.subject,
        item.body.prompt_version,
        item.body.schema_version,
      ].join("\u0000");
      const group = groups.get(key);
      if (group === undefined) groups.set(key, [item]);
      else group.push(item);
    }
    let closed = 0;
    step.gather(() => {
      for (const group of groups.values()) {
        if (group.length < 2) continue;
        const newest = group.reduce((a, b) => (b.place > a.place ? b : a));
        for (const item of group) {
          if (item === newest || item.state !== "waiting" || item.lease !== null) continue;
          step.close(item, "superseded", "asked again", newest.id, "agent");
          closed += 1;
        }
      }
    });
    return closed;
  });
}

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
  /** The reason of the last release, while it was given for the item's current input. */
  readonly release: string | null;
  /** The answer's text, its agent and model, for a text answer not applied yet. */
  readonly text?: string;
  readonly author?: { readonly agent: string; readonly model: string };
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
      /**
       * Per operation of the listed items: whether something on this machine
       * answers it (filled by the status view, which reads the machine's
       * settings; `false` from a bare read).
       */
      readonly executor: Readonly<Record<string, boolean>>;
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
      release:
        item.last_release !== null && item.last_release.input_hash === item.body.input_hash
          ? item.last_release.reason
          : null,
      ...((item.state === "accepted" || item.state === "awaiting-review") &&
      typeof item.answer?.text === "string"
        ? {
            text: item.answer.text,
            author: { agent: item.answer.agent, model: item.answer.model },
          }
        : {}),
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
    executor: Object.fromEntries(
      [...new Set(items.map((i) => i.operation))].map((op) => [op, false]),
    ),
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
