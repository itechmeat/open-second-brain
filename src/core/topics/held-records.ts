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
 * read it. The listing fails closed on that verdict:
 *
 *  - a signal is listed with its text only when the entity read is
 *    complete and the signal's entity still holds the held capture (not
 *    removed) in a state other than `rejected`, and, below local reach,
 *    the entity is not private;
 *  - a signal whose capture a removal voided, or whose lifecycle ends
 *    `rejected`, is forgotten and not listed at all (a complete read);
 *  - otherwise (an incomplete read, or a private signal below local reach)
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
import { readEntitiesOf, type StoreSignal } from "../store/read/store-entities.ts";
import { readStreamRecords } from "../store/read/stream-read.ts";
import type { StoreInspection } from "../store/store-open.ts";
import { topicCandidates } from "./candidates.ts";
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
  /** An `events` shard could not be read in full or is gone: the signal may be removed or private. */
  incompleteRead: "incomplete-read",
  /** The signal is private and the caller is below local reach. */
  private: "private",
} as const);
export type HeldWithheldReason = (typeof HELD_WITHHELD_REASON)[keyof typeof HELD_WITHHELD_REASON];

/** What a person reads for each reason. */
export const HELD_WITHHELD_MESSAGE: Readonly<Record<HeldWithheldReason, string>> = Object.freeze({
  "incomplete-read":
    "an events shard could not be read in full, so whether the signal was forgotten or made private is not known here; run `o2b brain doctor`",
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
  const entities = readEntitiesOf(store);
  const complete = entities.unreadable.length === 0;
  unreadable.push(...entities.unreadable);
  const holder = new Map<string, StoreSignal>();
  for (const entity of entities.signals.values()) {
    for (const record of entity.history) {
      if (record.kind === SIGNAL_KIND && wanted.has(record.id)) holder.set(record.id, entity);
    }
  }
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
    const entity = holder.get(capture.id);
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
    if (!complete) {
      listed(HELD_WITHHELD_REASON.incompleteRead);
      continue;
    }
    // Removed (the entity no longer holds this capture) or rejected: forgotten.
    if (entity === undefined || entity.state === "rejected") continue;
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
