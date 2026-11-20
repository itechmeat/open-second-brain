/**
 * The write path of topics (spec `topics` "Topic events as the write
 * path"; task 3.1): an agent, a command or the dream pass changes a topic
 * only by appending topic records to its own shard of the `topics` stream.
 * Nothing here writes a view page; the view writer renders pages from
 * these records.
 *
 * One call is one store operation (`store-write.ts`): every record lands
 * in one partition, and it is `private` when
 *
 *  - the caller asks for it (`private: true`),
 *  - a `topic-create` in the batch has the personal scope and the caller
 *    did not say otherwise (spec brain-store "personal-scope topics SHALL
 *    default to private"),
 *  - any topic the batch names already lives in `private` (records never
 *    move between partitions, so a private topic's events stay there),
 *  - an event edits, completes or resolves an item that has a record in
 *    `private` (a private item on a shared topic: its new text or state
 *    stays private too),
 *  - an `undo` in the batch names a record that sits in `private` (an
 *    undone create takes its topic out of the fold, so the topic alone
 *    cannot tell; the undo of that undo still names the private topic),
 *  - or the store's own backstop (a `<private>` region in a body) says so.
 *
 * Topics have no legacy form, so the records go to the store whether or
 * not this machine has switched; a machine without a store refuses with
 * the store's reason and remedy. Every record is checked against the shape
 * the fold applies (`records.ts`) before anything is written, and every
 * topic a record names must exist or be created in the same call.
 */

import type { AppendResult } from "../store/appender.ts";
import { privateWithheld, withPrivateShown } from "../store/caller-reach.ts";
import { AUTHORITY_FIELD, type Authority } from "../store/constants.ts";
import type { DualWriteContext, DualWriteRecord } from "../store/dual-write.ts";
import { storeWrite } from "../store/store-write.ts";
import { newUlid } from "../store/ulid.ts";
import {
  TOPIC_CREATE_KIND,
  TOPIC_LINK_KIND,
  TOPIC_MERGE_KIND,
  TOPIC_MILESTONE_DONE_KIND,
  TOPIC_QUESTION_RESOLVED_KIND,
  TOPIC_PERSONAL_SCOPE,
  TOPIC_SPLIT_KIND,
  TOPIC_STREAM,
  TOPIC_UNDO_KIND,
  type TopicRecordKind,
} from "./constants.ts";
import { readTopics, type TopicRead } from "./read.ts";
import { canonicalTopicScope, isTopicItemKind, topicBodyRejection } from "./records.ts";

/** One topic record to write. */
export interface TopicEvent {
  readonly kind: TopicRecordKind;
  /** The topic id (the envelope `topic`). */
  readonly topic: string;
  readonly authority: Authority;
  /** The body without `authority`. */
  readonly body: Readonly<Record<string, unknown>>;
  /** The writing agent; defaults to the configured agent name. */
  readonly agent?: string;
}

export type TopicWriteFailure = "invalid" | "unknown-topic" | "unreadable";

/** A topic write refused before anything was written. */
export class TopicWriteError extends Error {
  readonly reason: TopicWriteFailure;
  constructor(reason: TopicWriteFailure, message: string) {
    super(message);
    this.name = "TopicWriteError";
    this.reason = reason;
  }
}

export interface WriteTopicOptions extends DualWriteContext {
  /** Force the partition: `true` private, `false` shared unless a named topic is private. */
  readonly private?: boolean;
}

/** A fresh topic id. */
export function newTopicId(nowMs: number = Date.now()): string {
  return newUlid(nowMs);
}

/** The `topic-create` event of a new topic, with a fresh id. */
export function createTopicEvent(input: {
  readonly title: string;
  readonly scope: string;
  readonly authority: Authority;
  readonly description?: string | null;
  readonly goal?: string | null;
  readonly agent?: string;
  readonly now?: number;
}): TopicEvent {
  return {
    kind: TOPIC_CREATE_KIND,
    topic: newTopicId(input.now),
    authority: input.authority,
    body: {
      title: input.title.trim(),
      scope: canonicalTopicScope(input.scope),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.goal !== undefined ? { goal: input.goal } : {}),
    },
    ...(input.agent !== undefined ? { agent: input.agent } : {}),
  };
}

/** Topic ids an event names besides its own topic. */
function namedTopics(event: TopicEvent): string[] {
  switch (event.kind) {
    case TOPIC_MERGE_KIND:
    case TOPIC_SPLIT_KIND:
      return [event.body["into"] as string];
    case TOPIC_LINK_KIND:
      return [event.body["to"] as string];
    default:
      return [];
  }
}

/**
 * Whether an undo names a record that sits in `private`: its topic may be
 * out of the fold (an undone create), and nothing that names a private
 * topic or a private record may land in `shared`.
 */
function undoesPrivate(read: TopicRead, event: TopicEvent): boolean {
  return read.privateRecords.has(event.body["record"] as string);
}

/** Whether an event changes an item that has a record in `private`. */
function touchesPrivateItem(read: TopicRead, event: TopicEvent): boolean {
  const body = event.body;
  const id = isTopicItemKind(event.kind)
    ? body["item"]
    : event.kind === TOPIC_MILESTONE_DONE_KIND
      ? body["milestone"]
      : event.kind === TOPIC_QUESTION_RESOLVED_KIND
        ? body["question"]
        : undefined;
  if (typeof id !== "string") return false;
  const home = read.fold.canonical(event.topic);
  const topic = home === null ? undefined : read.fold.topics.get(home);
  return topic?.items.some((i) => i.id === id && i.owner === event.topic && i.private) === true;
}

/** The store record of one event, after its shape is checked. */
function recordOf(event: TopicEvent): DualWriteRecord {
  const body = { ...event.body, [AUTHORITY_FIELD]: event.authority };
  const reason = topicBodyRejection(event.kind, event.topic, body);
  if (reason !== null) {
    throw new TopicWriteError("invalid", `${event.kind} for topic ${event.topic}: ${reason}`);
  }
  return {
    stream: TOPIC_STREAM,
    kind: event.kind,
    topic: event.topic,
    ...(event.agent !== undefined ? { agent: event.agent } : {}),
    ...(event.kind === TOPIC_CREATE_KIND ? { scope: event.body["scope"] as string } : {}),
    body,
  };
}

/**
 * Append `events` as one store operation. Throws {@link TopicWriteError}
 * for an invalid event, a topic that does not exist, or a topic shard this
 * machine cannot read in full (the privacy of the topics named cannot be
 * judged then), and `StoreWriteError` when the store refuses the write.
 */
export function writeTopicEvents(
  events: ReadonlyArray<TopicEvent>,
  options: WriteTopicOptions = {},
): AppendResult[] {
  if (events.length === 0) return [];
  const records = events.map(recordOf);
  // The writer judges privacy from every partition this machine holds,
  // whatever the caller's reach: a remote caller's event for a private
  // topic still belongs in `private`.
  const read = withPrivateShown(() => readTopics(options.configPath));
  if (read.unreadable.length > 0) {
    // Below local reach the shards are not named: they may be private ones.
    const named = privateWithheld() ? "" : ` (${read.unreadable.join(", ")})`;
    throw new TopicWriteError(
      "unreadable",
      `the topics stream cannot be read in full${named}; run ` +
        "`o2b brain doctor` and retry once sync has delivered it",
    );
  }
  const created = new Map(
    events.filter((e) => e.kind === TOPIC_CREATE_KIND).map((e) => [e.topic, e] as const),
  );
  for (const event of events) {
    // An undo is checked by the record it names, whose topic may be gone.
    if (
      event.kind === TOPIC_UNDO_KIND &&
      read.recordTopics.get(event.body["record"] as string) === event.topic
    ) {
      continue;
    }
    for (const id of [event.topic, ...namedTopics(event)]) {
      if (!created.has(id) && !read.fold.topics.has(id)) {
        throw new TopicWriteError("unknown-topic", `${event.kind}: no topic with id ${id}`);
      }
    }
  }
  const personal = [...created.values()].some((e) => e.body["scope"] === TOPIC_PERSONAL_SCOPE);
  const named = events.flatMap((e) => [e.topic, ...namedTopics(e)]);
  const isPrivate =
    options.private === true ||
    (options.private === undefined && personal) ||
    named.some((id) => read.fold.topics.get(id)?.private === true) ||
    events.some((e) => e.kind === TOPIC_UNDO_KIND && undoesPrivate(read, e)) ||
    events.some((e) => touchesPrivateItem(read, e));
  return storeWrite(() => records.map((r) => (isPrivate ? { ...r, private: true } : r)), options);
}
