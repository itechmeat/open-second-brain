/**
 * The records a topic holds, for a person who asks what the topic is made
 * of (`o2b topic show <topic> --held`, `brain_topic` show with `held`).
 *
 * A topic holds the notes, signals and decisions assigned to it (its
 * `assign` records, and those of the topics merged into it, as the fold
 * resolves them). Its notes and signals are not items of the topic page:
 * the page shows what is earned (spec "Log entries are earned"; design D10
 * `event_kind`, whose deterministic answer for a record no agent gave a
 * kind is routine); its decisions, whose kind the agent named, show as
 * decision items derived when the page is read (`held-decisions.ts`). So
 * the page says how many records the topic holds and names the command
 * that lists them, and this module lists them.
 *
 * Log events (notes, decisions) are read from the `log` stream (the
 * stream reader, with its seen-shard and gap checks), keeping only held
 * ids: a log event has no removal or privacy patch in the store, so its
 * own record decides (its partition, and a `<private>` region). A caller
 * below local reach reads `shared` alone, and a record with a `<private>`
 * region is left out for it.
 *
 * A signal's state and privacy are never decided here: the entity reader
 * (`store/read/store-entities.ts`) folds every partition's lifecycle
 * records with its removal, rejection and privacy rules and names every
 * `events` shard it could not read or that vanished since this machine
 * read it. A signal lifecycle record (a move or a removal) whose body is
 * a blob that has not arrived is left out of that fold without a gap when
 * its line is quarantined, and its body, the signal it names included, is
 * not known: so that read also counts every such record it left out
 * (`readSignalLifecycles`), from the scan that built the fold. The
 * listing fails closed on that verdict (`heldSignalVerdict`, which the
 * assign refusal reads too):
 *
 *  - a signal is listed with its text only when the entity read is
 *    complete, no signal lifecycle record was left out pending, and the
 *    signal's entity still holds the held capture (not removed) in a
 *    state other than `rejected`, and, below local reach, the entity is
 *    not private;
 *  - a signal whose capture a removal voided, or whose lifecycle ends
 *    `rejected`, is forgotten and not listed at all (a complete read);
 *  - otherwise (an incomplete read or a lifecycle record left out pending,
 *    or a private signal below local reach)
 *    it is listed by id, kind and time with its text withheld, and counted
 *    under the reason.
 *
 * `consumed`, `archived`, `retired` and `expired` are lifecycle moves
 * whose text the product keeps, so such a signal is listed. For every
 * caller a text is read with its `<private>` regions removed, as planning
 * reads it (`candidates.ts`). On a large store the listing reads the
 * `events` and `log` streams, which is why it runs only on request.
 * Nothing is written.
 */

import { privateWithheld } from "../store/caller-reach.ts";
import { LOG_EVENT_KIND, SIGNAL_KIND, type StorePartition } from "../store/constants.ts";
import type { StoreRecord } from "../store/envelope.ts";
import { parseHlc } from "../store/hlc.ts";
import { valueCarriesPrivateRegion } from "../store/private-region.ts";
import {
  readEntitiesOf,
  type StoreEntities,
  type StoreSignal,
} from "../store/read/store-entities.ts";
import { readStreamRecords } from "../store/read/stream-read.ts";
import type { StoreInspection } from "../store/store-open.ts";
import { isHoldableRecord, topicCandidates } from "./candidates.ts";
import type { TopicFold } from "./fold.ts";

/** The ids of the records `topicId` holds, in id order. */
export function heldRecordIds(fold: TopicFold, topicId: string): string[] {
  const ids: string[] = [];
  for (const [record, topic] of fold.assignments) if (topic === topicId) ids.push(record);
  return ids.toSorted();
}

/** How many records each topic holds, by topic id. */
export function heldRecordCounts(fold: TopicFold): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const topic of fold.assignments.values()) {
    if (topic !== null) counts.set(topic, (counts.get(topic) ?? 0) + 1);
  }
  return counts;
}

/** Why a held signal's text is withheld. */
export const HELD_WITHHELD_REASON = Object.freeze({
  /**
   * An `events` shard could not be read in full or is gone, or a signal
   * lifecycle record's body has not arrived: the signal may be removed or private.
   */
  incompleteRead: "incomplete-read",
  /** The signal is private and the caller is below local reach. */
  private: "private",
} as const);
export type HeldWithheldReason = (typeof HELD_WITHHELD_REASON)[keyof typeof HELD_WITHHELD_REASON];

/** What a person reads for each reason. */
export const HELD_WITHHELD_MESSAGE: Readonly<Record<HeldWithheldReason, string>> = Object.freeze({
  "incomplete-read":
    "an events shard could not be read in full, or a signal lifecycle record's body has not arrived, so whether the signal was forgotten or made private is not known here; run `o2b brain doctor`",
  private: "the signal is private, and a caller below local reach is not shown private text",
});

/** One held record as `show` lists it. */
export interface HeldRecord {
  readonly id: string;
  /** `signal`, or the log event's type (`note`, `decision-record`, `decision-resolved`). */
  readonly kind: string;
  /** Its text, `<private>` regions removed; absent when withheld. */
  readonly text?: string;
  /** When it was written (ISO-8601). */
  readonly at: string;
  readonly project: string | null;
  readonly private: boolean;
  /** Set when the text is withheld, and why. */
  readonly withheld?: HeldWithheldReason;
}

export interface HeldRecordsRead {
  readonly records: ReadonlyArray<HeldRecord>;
  /** Held ids no readable record was found for (a record of a shard not read, or not here yet). */
  readonly missing: number;
  /** Partition-relative paths of shards not read in full (`events` and `log`). */
  readonly unreadable: ReadonlyArray<string>;
  /** How many held signals were listed with their text withheld, by reason. */
  readonly withheld: Readonly<Partial<Record<HeldWithheldReason, number>>>;
}

function kindOf(record: StoreRecord): string {
  if (record.kind === SIGNAL_KIND) return "signal";
  if (record.kind === LOG_EVENT_KIND) return String(record.body["event_type"]);
  return record.kind;
}

/** The time a record was written, as planning reads it (a migrated one's legacy time). */
function atOf(record: StoreRecord): string {
  const [candidate] = topicCandidates([record], new Set());
  return new Date(candidate?.at ?? parseHlc(record.hlc)!.physical).toISOString();
}

/** What `record` is, for a refusal: its kind, and a log event's type. */
function describedKind(record: StoreRecord): string {
  return record.kind === LOG_EVENT_KIND
    ? `${String(record.body["event_type"])} log event`
    : `${record.kind} record`;
}

/** The store's signals as the held listing reads them, and what that read left out. */
interface SignalLifecycles {
  readonly entities: StoreEntities;
  /** Partition-qualified `events` shards not read in full, or gone. */
  readonly unreadable: ReadonlyArray<string>;
  /**
   * Signal lifecycle records (moves, removals) the same read left out
   * because their body is a blob that has not arrived, quarantined or
   * not. Such a body names its signal, so none can be told apart: every
   * one leaves every signal's verdict uncertain.
   */
  readonly pendingLifecycle: number;
}

/**
 * Read every signal's lifecycle from `store` (`readEntitiesOf`). The fold
 * and the count of lifecycle records it left out pending come from one
 * scan: a second scan for that count could run after a pending removal's
 * blob arrived, count nothing, and pass a fold that never saw the removal.
 */
function readSignalLifecycles(store: StoreInspection): SignalLifecycles {
  const entities = readEntitiesOf(store);
  return {
    entities,
    unreadable: entities.unreadable,
    pendingLifecycle: entities.pendingSignalLifecycle,
  };
}

/** What the held listing can say of one held signal capture, for certain. */
type HeldSignalVerdict =
  /** Listed with its text (at local reach) by the entity that holds it. */
  | { readonly verdict: "shown"; readonly entity: StoreSignal }
  /** A removal voided the capture, or the signal's lifecycle ends `rejected`. */
  | { readonly verdict: "removed" | "rejected" }
  /** Whether it is forgotten or private cannot be told: listed with its text withheld. */
  | { readonly verdict: "uncertain" };

/**
 * The one verdict the held listing lists a signal capture by, and the
 * assign refusal refuses by: `uncertain` while any `events` shard is
 * unread or any lifecycle record was left out pending, else the fold's
 * answer for the entity whose history holds `captureId`.
 */
function heldSignalVerdict(read: SignalLifecycles, captureId: string): HeldSignalVerdict {
  if (read.unreadable.length > 0 || read.pendingLifecycle > 0) return { verdict: "uncertain" };
  for (const entity of read.entities.signals.values()) {
    if (!entity.history.some((r) => r.kind === SIGNAL_KIND && r.id === captureId)) continue;
    return entity.state === "rejected" ? { verdict: "rejected" } : { verdict: "shown", entity };
  }
  return { verdict: "removed" };
}

/**
 * Why a topic cannot hold the record `id`, or `null` when it can (`o2b
 * topic assign`, `brain_topic` assign). A topic holds notes, signals and
 * decision events: an assign of any other id (a lane entry, a topic
 * record, an id this machine has never seen) used to be written, and the
 * topic then said its held record was "not found on this machine". The
 * `events` and `log` streams are read for that one id, at the caller's
 * reach (`shared` alone below local reach), the rule the held listing
 * reads by. Refused too, each with its own reason:
 *
 *  - a signal the product forgot (a removal voided its capture, or its
 *    lifecycle ends `rejected`): the held listing leaves such a signal out
 *    without counting it missing, so the topic would never show it;
 *  - a record whose body is a blob that has not arrived (quarantined or
 *    not): it is on this machine, so it is not called absent, but what it
 *    is cannot be told yet;
 *  - a signal the held listing could not show for certain
 *    (`heldSignalVerdict`): a shard of the `events` stream unreadable or
 *    gone since this machine read it, or a signal lifecycle record whose
 *    body has not arrived (quarantined or not), could hold its removal or
 *    rejection;
 *  - a signal capture whose `id` is not a non-empty string: the entity
 *    reader rejects it, so the held listing never shows it;
 *  - a record with no text the listing could show (an empty principle, a
 *    text wholly inside a `<private>` region);
 *  - an id not found while a shard could not be read.
 */
export function holdRefusal(store: StoreInspection, id: string): string | null {
  const withhold = privateWithheld();
  const found: StoreRecord[] = [];
  let unreadable = 0;
  let pending = false;
  for (const partition of [...store.partitions] as StorePartition[]) {
    if (withhold && partition !== "shared") continue;
    for (const stream of ["events", "log"] as const) {
      const read = readStreamRecords(
        store.root,
        partition,
        { stream },
        { keep: (r) => r.id === id },
      );
      unreadable += read.unreadable.length;
      // The reader names the blob of a kept record it left out pending,
      // a quarantined one included.
      pending ||= read.pendingBlobs.length > 0;
      found.push(...read.records.filter((r) => !(withhold && valueCarriesPrivateRegion(r.body))));
    }
  }
  const hold =
    "a topic holds notes, signals and decision events (`o2b topic show <topic> --held` lists what one holds)";
  const holdable = found.find(isHoldableRecord);
  if (holdable !== undefined) {
    // The held listing shows a record by the text the planner reads of it;
    // one with none (an empty principle, a text wholly inside a `<private>`
    // region) would never be listed, so it is refused rather than held unseen.
    if (topicCandidates([holdable], new Set()).length === 0) {
      return `record ${id} has no text a topic can show: ${hold}`;
    }
    return holdable.kind === SIGNAL_KIND ? forgottenSignal(store, holdable) : null;
  }
  if (found.length > 0) return `record ${id} is a ${describedKind(found[0]!)}: ${hold}`;
  if (pending) {
    return (
      `record ${id} is on this machine, but its body has not arrived (its blob is pending or ` +
      "quarantined), so what it is cannot be told; try again once the blob has arrived"
    );
  }
  if (unreadable > 0) {
    return (
      `no note, signal or decision event with id ${id} was found, but ${unreadable} shard(s) of ` +
      "this machine's store could not be read; try again once they can"
    );
  }
  return `no note, signal or decision event with id ${id} on this machine: ${hold}`;
}

/**
 * Why the held listing would not show the signal capture `capture` for
 * certain, or `null` when it would: the listing's own verdict
 * (`heldSignalVerdict`), read from every partition as the listing reads.
 */
function forgottenSignal(store: StoreInspection, capture: StoreRecord): string | null {
  const signal = capture.body["id"];
  // The entity reader rejects such a capture, so the held listing could
  // never show it.
  if (typeof signal !== "string" || signal === "") {
    return `signal ${capture.id}: its id is not a non-empty string, so the store cannot keep it as a signal`;
  }
  const read = readSignalLifecycles(store);
  const verdict = heldSignalVerdict(read, capture.id);
  switch (verdict.verdict) {
    case "shown":
      return null;
    case "removed":
    case "rejected":
      return `signal ${capture.id} was ${verdict.verdict}: a topic holds what the product keeps, and a ${verdict.verdict} signal is forgotten`;
    case "uncertain": {
      // The held listing withholds every signal on such a read, so the
      // assign is refused rather than written on a guess.
      const left = [
        ...(read.unreadable.length > 0
          ? [`${read.unreadable.length} shard(s) of this machine's store could not be read`]
          : []),
        ...(read.pendingLifecycle > 0
          ? [
              `${read.pendingLifecycle} signal lifecycle record(s) of this machine's store have a body that has not arrived`,
            ]
          : []),
      ];
      return (
        `signal ${capture.id}: ${left.join(", and ")}, so whether it was removed or rejected ` +
        "cannot be told; try again once they can be read"
      );
    }
  }
}

/** Read the records of `ids` from `store`, for the caller of the work running now. */
export function readHeldRecords(
  store: StoreInspection,
  ids: ReadonlyArray<string>,
): HeldRecordsRead {
  const wanted = new Set(ids);
  const withhold = privateWithheld();
  const unreadable: string[] = [];
  const records: HeldRecord[] = [];
  const withheld: Partial<Record<HeldWithheldReason, number>> = {};
  const found = new Set<string>();

  // Log events: their own record decides.
  const logRecords: StoreRecord[] = [];
  const privateLog = new Set<string>();
  for (const partition of [...store.partitions] as StorePartition[]) {
    if (withhold && partition !== "shared") continue;
    const read = readStreamRecords(
      store.root,
      partition,
      { stream: "log" },
      { keep: (r) => wanted.has(r.id) && r.kind === LOG_EVENT_KIND },
    );
    unreadable.push(...read.unreadable.map((rel) => `${partition}/${rel}`));
    for (const record of read.records) {
      logRecords.push(record);
      if (partition === "private") privateLog.add(record.id);
    }
  }
  for (const candidate of topicCandidates(logRecords, privateLog)) {
    found.add(candidate.id);
    if (withhold && candidate.private) continue;
    const record = logRecords.find((r) => r.id === candidate.id)!;
    records.push({
      id: candidate.id,
      kind: kindOf(record),
      text: candidate.text,
      at: new Date(candidate.at).toISOString(),
      project: candidate.project,
      private: candidate.private,
    });
  }

  // Signals: the entity reader's verdict, failing closed.
  const lifecycles = readSignalLifecycles(store);
  unreadable.push(...lifecycles.unreadable);
  // The held captures the store holds at all (forgotten ones included), so
  // a forgotten capture is told from one not here yet.
  const captures: StoreRecord[] = [];
  for (const partition of [...store.partitions] as StorePartition[]) {
    const read = readStreamRecords(
      store.root,
      partition,
      { stream: "events" },
      { keep: (r) => wanted.has(r.id) && r.kind === SIGNAL_KIND },
    );
    captures.push(...read.records);
  }
  const counted = new Set<string>();
  for (const capture of captures) {
    if (counted.has(capture.id)) continue;
    counted.add(capture.id);
    found.add(capture.id);
    const verdict = heldSignalVerdict(lifecycles, capture.id);
    const entity = verdict.verdict === "shown" ? verdict.entity : undefined;
    const listed = (reason: HeldWithheldReason): void => {
      withheld[reason] = (withheld[reason] ?? 0) + 1;
      records.push({
        id: capture.id,
        kind: "signal",
        at: atOf(capture),
        project: null,
        private: entity?.private ?? true,
        withheld: reason,
      });
    };
    if (verdict.verdict === "uncertain") {
      listed(HELD_WITHHELD_REASON.incompleteRead);
      continue;
    }
    // Removed (the entity no longer holds this capture) or rejected: forgotten.
    if (entity === undefined) continue;
    if (withhold && entity.private) {
      listed(HELD_WITHHELD_REASON.private);
      continue;
    }
    const [candidate] = topicCandidates([capture], new Set(entity.private ? [capture.id] : []));
    if (candidate === undefined) continue;
    records.push({
      id: capture.id,
      kind: "signal",
      text: candidate.text,
      at: new Date(candidate.at).toISOString(),
      project: candidate.project,
      private: entity.private,
    });
  }

  records.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.id < b.id ? -1 : 1));
  // A forgotten record is not "missing": it is gone on purpose.
  return { records, missing: wanted.size - found.size, unreadable, withheld };
}
