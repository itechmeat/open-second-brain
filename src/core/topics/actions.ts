/**
 * The topic actions behind the `brain_topic` MCP tool and the `o2b topic`
 * verbs (design D9; spec `topics` "Topics on request"; task 3.5): one
 * implementation, so the tool and the CLI cannot disagree.
 *
 * Reads (`list`, `show`, `review`) answer at the caller's reach: below
 * local reach only shared topics exist (`read.ts`), and a write that names
 * a topic the caller cannot see is refused exactly as one that names no
 * topic, so neither a private topic's content nor its existence crosses.
 *
 * Writes are topic records (`write.ts`). The requested actions (create,
 * rename, status, goal, assign, unassign, merge, split, link, archive,
 * undo) carry `human` authority when the user runs them (`o2b topic`) and
 * `agent` authority through `brain_topic` (design D9, D18). `record` adds
 * an agent's own decision, open question, log entry, milestone,
 * resolution or completion, with `agent` authority by default. Every
 * default can be named instead with `authority` (`human` is refused
 * below local reach).
 */

import type { AppendResult } from "../store/appender.ts";
import type { Authority } from "../store/constants.ts";
import { SETTING_VIEW_LANGUAGE } from "../store/constants.ts";
import { sharedSetting } from "./settings.ts";
import { DELIVERY_TREATMENT, shapeStoredTextForDelivery } from "../brain/delivery-shaping.ts";
import { viewStrings } from "../view/i18n.ts";
import { topicPages } from "../view/topic-pages.ts";
import {
  TOPIC_ASSIGN_KIND,
  TOPIC_GOAL_KIND,
  TOPIC_LINK_KIND,
  TOPIC_MERGE_KIND,
  TOPIC_PERSONAL_SCOPE,
  TOPIC_RENAME_KIND,
  TOPIC_SPLIT_KIND,
  TOPIC_STATUS_KIND,
  TOPIC_UNASSIGN_KIND,
  TOPIC_UNDO_KIND,
  type TopicRecordKind,
} from "./constants.ts";
import type { TopicFold, TopicState } from "./fold.ts";
import { reviewTopics } from "./plan.ts";
import { readTopics, type TopicRead } from "./read.ts";
import { canonicalTopicScope } from "./records.ts";
import {
  HELD_WITHHELD_MESSAGE,
  type HeldWithheldReason,
  heldRecordIds,
  holdRefusal,
  readHeldRecords,
} from "./held-records.ts";
import { readDecisionEvents, withHeldDecisions } from "./held-decisions.ts";
import { configuredStore } from "../store/read/store-entities.ts";
import { createTopicEvent, writeTopicEvents, type TopicEvent } from "./write.ts";
import { privateWithheld } from "../store/caller-reach.ts";
import { SESSION_FIELD } from "../agent-context/session-identity.ts";
import { SETTING_TOPIC_QUIET_DAYS } from "../store/constants.ts";

export const TOPIC_ACTIONS = Object.freeze([
  "list",
  "show",
  "review",
  "create",
  "rename",
  "status",
  "goal",
  "assign",
  "unassign",
  "merge",
  "split",
  "link",
  "archive",
  "undo",
  "record",
] as const);
export type TopicAction = (typeof TOPIC_ACTIONS)[number];

/** The kinds `record` writes. */
export const TOPIC_RECORD_ACTION_KINDS = Object.freeze([
  "decision",
  "open-question",
  "log-entry",
  "milestone",
  "question-resolved",
  "milestone-done",
] as const);

/** A topic action refused before anything was read or written. */
export class TopicActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TopicActionError";
  }
}

export interface TopicActionInput {
  readonly action: string;
  readonly topic?: string;
  readonly title?: string;
  readonly description?: string | null;
  readonly goal?: string | null;
  readonly scope?: string;
  readonly status?: string;
  readonly resolved?: string;
  readonly record?: string;
  readonly into?: string;
  readonly to?: string;
  readonly items?: ReadonlyArray<string>;
  readonly records?: ReadonlyArray<string>;
  readonly removed?: boolean;
  readonly private?: boolean;
  readonly authority?: string;
  /** `record`: the kind and its fields. */
  readonly kind?: string;
  /** `record`: the topic that owns the named item, when merged topics share its id. */
  readonly owner?: string;
  readonly fields?: Readonly<Record<string, unknown>>;
  /** `list`: the scope to list (default: every topic). */
  readonly listScope?: string;
  /** `show`: also list the records the topic holds (`held-records.ts`). */
  readonly held?: boolean;
}

export interface TopicActionContext {
  readonly configPath?: string;
  readonly agent?: string;
  readonly now?: () => number;
  /**
   * The user is the caller (the `o2b topic` CLI): the requested actions
   * default to `human` authority. Every other caller (an agent through
   * `brain_topic`) defaults to `agent` and must name `human` to claim it.
   */
  readonly humanRequest?: boolean;
  /**
   * The writing session's stamp (`agent-context/session-identity.ts`),
   * set on the body of every record the action writes. A caller cannot
   * name it: `fields` takes no `session`.
   */
  readonly session?: string;
}

/** An event with the writing session's stamp in its body, when there is one. */
function stampSession(event: TopicEvent, session: string | undefined): TopicEvent {
  return session === undefined
    ? event
    : { ...event, body: { ...event.body, [SESSION_FIELD]: session } };
}

function need(input: TopicActionInput, field: keyof TopicActionInput): string {
  const value = input[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new TopicActionError(`${input.action}: '${field}' is required`);
  }
  return value.trim();
}

function authorityOf(input: TopicActionInput, fallback: Authority): Authority {
  if (input.authority === undefined) return fallback;
  if (input.authority !== "human" && input.authority !== "agent") {
    throw new TopicActionError("authority must be human or agent");
  }
  // A caller below local reach (a remote MCP transport) is never taken to
  // speak for the user: its records would outweigh the user's own.
  if (input.authority === "human" && privateWithheld()) {
    throw new TopicActionError("human authority is refused below local reach");
  }
  return input.authority;
}

/** The fields `record` accepts for each kind; any other field is refused. */
const RECORD_FIELDS: Readonly<Record<string, ReadonlyArray<string>>> = Object.freeze({
  decision: ["item", "text", "serves", "removed"],
  "open-question": ["item", "text", "removed"],
  "log-entry": ["item", "text", "class", "reason", "removed"],
  milestone: ["item", "text", "removed"],
  "question-resolved": ["question", "answer"],
  "milestone-done": ["milestone", "evidence"],
});

/** The field of a completion that names its item, and the item's kind. */
const NAMED_ITEM: Readonly<Record<string, { field: string; kind: string }>> = Object.freeze({
  "question-resolved": { field: "question", kind: "open-question" },
  "milestone-done": { field: "milestone", kind: "milestone" },
});

/**
 * The topic a `record` event is written under, after its item reference
 * is checked against the caller's fold: an item named by a completion, or
 * by an edit, must be an item of that topic of the right kind (a merged
 * topic's item is written under the topic that owns it). Below local reach
 * a record may not pick a new item id: the item would collide with one of
 * a private record the caller cannot see. Every miss gives one message,
 * so a hidden item and an absent one answer alike.
 */
function recordTopic(
  fold: TopicFold,
  topic: TopicState,
  kind: string,
  fields: Readonly<Record<string, unknown>>,
  owner: string | undefined,
): string {
  for (const key of Object.keys(fields)) {
    if (!(RECORD_FIELDS[kind] ?? []).includes(key)) {
      throw new TopicActionError(`record: ${kind} takes no field '${key}'`);
    }
  }
  const named = NAMED_ITEM[kind];
  const field = named?.field ?? "item";
  const want = named?.kind ?? kind;
  const id = fields[field];
  // `owner` names this topic or one merged into it; any other id (a typo,
  // an unrelated topic, one the caller cannot see) is refused alike, with
  // or without an item id.
  if (owner !== undefined && owner !== topic.id && fold.canonical(owner) !== topic.id) {
    throw new TopicActionError(
      `record: owner ${owner} is not this topic or a topic merged into it (${topic.id})`,
    );
  }
  if (id === undefined && named === undefined) return topic.id;
  if (typeof id !== "string") throw new TopicActionError(`record: ${kind} needs '${field}'`);
  // After a merge two owners can hold the same item id: `owner` says which.
  const matches = topic.items.filter(
    (i) => i.id === id && (owner === undefined || i.owner === owner),
  );
  if (matches.length > 1) {
    throw new TopicActionError(
      `record: item ${id} is on more than one merged topic; name its owner (${matches.map((i) => i.owner).join(", ")})`,
    );
  }
  const item = matches[0];
  if (item !== undefined && item.kind === want) return item.owner;
  // A new item is never picked with `owner`: an owner names an item that exists.
  if (item === undefined && named === undefined && owner === undefined && !privateWithheld()) {
    // An id the topic once held still names that item after a split moved it.
    if (fold.movedAway(topic.id, id)) {
      throw new TopicActionError(
        `record: item ${id} of topic ${topic.id} moved to another topic; pick another id`,
      );
    }
    return topic.id;
  }
  throw new TopicActionError(`record: no ${want} item ${id} on topic ${topic.id}`);
}

/**
 * The `split` records of a request. Each item listed must be one the
 * topic shows, and it moves by a split written under the topic that owns
 * it: an item of a topic merged into this one is that topic's own, which
 * a split of this topic would not find. An id two merged owners share
 * needs `owner`.
 */
function splitEvents(
  fold: TopicFold,
  topic: TopicState,
  input: TopicActionInput,
  into: string,
  event: (topic: string, body: Record<string, unknown>) => TopicEvent,
): TopicEvent[] {
  const owner = input.owner;
  if (owner !== undefined && owner !== topic.id && fold.canonical(owner) !== topic.id) {
    throw new TopicActionError(
      `split: owner ${owner} is not this topic or a topic merged into it (${topic.id})`,
    );
  }
  const byOwner = new Map<string, string[]>([[topic.id, []]]);
  for (const id of input.items ?? []) {
    const matches = topic.items.filter(
      (i) => i.id === id && (owner === undefined || i.owner === owner),
    );
    if (matches.length > 1) {
      throw new TopicActionError(
        `split: item ${id} is on more than one merged topic; name its owner (${matches.map((i) => i.owner).join(", ")})`,
      );
    }
    if (matches[0] === undefined) {
      throw new TopicActionError(`split: no item ${id} on topic ${topic.id}`);
    }
    byOwner.set(matches[0].owner, [...(byOwner.get(matches[0].owner) ?? []), id]);
  }
  const records = input.records !== undefined ? { records: input.records } : {};
  const own = byOwner.get(topic.id)!;
  // The named topic's split comes first and carries the records; a merged
  // owner's split carries only its items.
  return [
    ...(own.length > 0 || input.records !== undefined || byOwner.size === 1
      ? [
          event(topic.id, {
            into,
            // A merged owner's items go in its own split; an empty list is invalid.
            ...(own.length > 0 ? { items: own } : {}),
            ...records,
          }),
        ]
      : []),
    ...[...byOwner]
      .filter(([id]) => id !== topic.id)
      .map(([id, items]) => event(id, { into, items })),
  ];
}

/** The fence origin of topic text below local reach. */
const TOPIC_TEXT_ORIGIN = "stored text: agent-authored (topic records)";

/**
 * Topic text as the caller of the work running now may be handed it:
 * agent-written, so fenced below local reach as every other stored text an
 * agent wrote; as is for a local caller.
 */
function delivered<T extends string | null>(text: T): T {
  if (text === null || !privateWithheld()) return text;
  return shapeStoredTextForDelivery(text, {
    treatment: DELIVERY_TREATMENT.fenced,
    origin: TOPIC_TEXT_ORIGIN,
  }).text as T;
}

/** A topic head: what an agent gets for a topic without its body. */
export function topicHead(topic: TopicState): Record<string, unknown> {
  return {
    id: topic.id,
    title: delivered(topic.title),
    description: delivered(topic.description),
    status: topic.status,
    ...(topic.resolved !== null ? { resolved: topic.resolved } : {}),
    goal: delivered(topic.goal),
    scope: delivered(topic.scope),
    created_at: new Date(topic.createdAt).toISOString(),
    updated_at: new Date(topic.updatedAt).toISOString(),
  };
}

function topicDetail(topic: TopicState, held: number): Record<string, unknown> {
  return {
    ...topicHead(topic),
    held_records: held,
    links: topic.links,
    goal_proposals: topic.goalProposals.map((p) => ({
      agent: p.agent,
      goal: delivered(p.goal),
      record: p.record,
    })),
    items: topic.items.map((i) => ({
      id: i.id,
      owner: i.owner,
      kind: i.kind,
      text: delivered(i.text),
      ...(i.logClass !== undefined ? { class: i.logClass } : {}),
      ...(i.reason !== undefined ? { reason: delivered(i.reason) } : {}),
      ...(i.serves !== undefined ? { serves: i.serves } : {}),
      authority: i.author.authority,
      agent: i.author.agent,
      created_at: new Date(i.createdAt).toISOString(),
      ...(i.done !== undefined ? { done: new Date(i.done.at).toISOString() } : {}),
      ...(i.doneProposed !== undefined ? { looks_done: true } : {}),
      ...(i.resolved !== undefined ? { resolved: new Date(i.resolved.at).toISOString() } : {}),
    })),
  };
}

/** The records `topic` holds, read from the store (`show` with `held`). */
function heldListing(
  read: TopicRead,
  topic: TopicState,
  configPath: string | undefined,
): Record<string, unknown> {
  const store = configuredStore(configPath);
  const ids = heldRecordIds(read.fold, topic.id);
  if (store === null) return { records: [], records_missing: ids.length };
  const held = readHeldRecords(store, ids);
  return {
    records: held.records.map((r) => ({
      id: r.id,
      kind: r.kind,
      ...(r.text !== undefined ? { text: delivered(r.text) } : {}),
      at: r.at,
      project: r.project,
      ...(r.private ? { private: true } : {}),
      ...(r.withheld !== undefined ? { withheld: r.withheld } : {}),
    })),
    ...(held.missing > 0 ? { records_missing: held.missing } : {}),
    // Signals listed without their text: how many, and why.
    ...(Object.keys(held.withheld).length > 0
      ? {
          records_withheld: Object.entries(held.withheld).map(([reason, count]) => ({
            reason,
            count,
            message: HELD_WITHHELD_MESSAGE[reason as HeldWithheldReason],
          })),
        }
      : {}),
    // Below local reach the shards are not named, as every topic reader
    // withholds them (they may be private ones): only how many.
    ...(held.unreadable.length > 0
      ? privateWithheld()
        ? { records_unreadable_count: held.unreadable.length }
        : { records_unreadable: held.unreadable }
      : {}),
  };
}

/**
 * `read` with the decision items its topics' held decision events give
 * (`held-decisions.ts`), read at the caller's reach: the `log` stream of
 * the partitions the caller may read.
 */
function withHeldDecisionsOf(
  read: TopicRead,
  configPath: string | undefined,
): { readonly read: TopicRead; readonly incomplete: boolean } {
  const store = configuredStore(configPath);
  if (store === null) return { read, incomplete: false };
  const events = readDecisionEvents(store);
  return {
    read: { ...read, fold: withHeldDecisions(read.fold, events.records, events.privateIds) },
    // A `log` shard not read in full may hold a decision of the topic.
    incomplete: events.unreadable.length > 0,
  };
}

/** The topic `id` names after merges, if the caller can see it. */
function visibleTopic(read: TopicRead, id: string): TopicState {
  const canonical = read.fold.canonical(id);
  const topic = canonical === null ? undefined : read.fold.topics.get(canonical);
  if (topic === undefined) throw new TopicActionError(`no topic with id ${id}`);
  return topic;
}

function shownMarkdown(read: TopicRead, topic: TopicState, configPath?: string): string {
  const lang = sharedSetting(SETTING_VIEW_LANGUAGE, configPath);
  const strings = viewStrings(typeof lang === "string" ? lang : null);
  // A local caller sees its private topics too; below local reach the
  // fold already holds none.
  const pages = topicPages(read.storeId ?? "", read.fold, strings, {
    includePrivate: !privateWithheld(),
  });
  const page = pages.find((p) => p.topic === topic.id && p.page.endsWith("/topic.md"));
  const text = page === undefined ? "" : `${page.lines.map((l) => l.text).join("\n")}\n`;
  // Topic text is written by agents: below local reach it is delivered
  // fenced, as every other stored text that agents wrote.
  if (!privateWithheld()) return text;
  return shapeStoredTextForDelivery(text, {
    treatment: DELIVERY_TREATMENT.fenced,
    origin: TOPIC_TEXT_ORIGIN,
  }).text;
}

function quietDays(configPath?: string): number {
  return sharedSetting(SETTING_TOPIC_QUIET_DAYS, configPath) as number;
}

function listJson(fold: TopicFold, scope: string | undefined): Record<string, unknown>[] {
  // The fold keys every scope (`canonicalTopicScope`); the filter is keyed
  // the same way, so `project:Café` lists the topics of `café`.
  const wanted = scope === undefined ? undefined : canonicalTopicScope(scope.trim());
  return [...fold.topics.values()]
    .filter((t) => t.mergedInto === null && (wanted === undefined || t.scope === wanted))
    .toSorted((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : 1))
    .map(topicHead);
}

/**
 * An assign names a record a topic can hold (`holdRefusal`). A store that
 * cannot be read here is refused too, although the topic read before
 * succeeded: the write would otherwise land unchecked, since the writer
 * checks that the topic exists, not the record.
 */
function refuseUnholdable(record: string, configPath: string | undefined): void {
  const store = configuredStore(configPath);
  if (store === null) {
    throw new TopicActionError(
      `assign: the brain store could not be read to check record ${record}; nothing was ` +
        "written, try again once it can be read",
    );
  }
  const refusal = holdRefusal(store, record);
  if (refusal !== null) throw new TopicActionError(`assign: ${refusal}`);
}

/** The events of a write action, against what the caller can see. */
function eventsOf(
  input: TopicActionInput,
  read: TopicRead,
  now: number,
  humanRequest: boolean,
): TopicEvent[] {
  const human = authorityOf(input, humanRequest ? "human" : "agent");
  const event = (
    kind: TopicRecordKind,
    topic: string,
    body: Record<string, unknown>,
  ): TopicEvent => ({
    kind,
    topic,
    authority: human,
    body,
  });
  const topicId = (): string => visibleTopic(read, need(input, "topic")).id;
  switch (input.action) {
    case "create":
      return [
        createTopicEvent({
          title: need(input, "title"),
          scope: input.scope ?? TOPIC_PERSONAL_SCOPE,
          authority: human,
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.goal !== undefined ? { goal: input.goal } : {}),
          now,
        }),
      ];
    case "rename":
      return [
        event(TOPIC_RENAME_KIND, topicId(), {
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
        }),
      ];
    case "status":
      return [
        event(TOPIC_STATUS_KIND, topicId(), {
          status: need(input, "status"),
          ...(input.resolved !== undefined ? { resolved: input.resolved } : {}),
        }),
      ];
    case "archive":
      return [event(TOPIC_STATUS_KIND, topicId(), { status: "closed" })];
    case "goal":
      return [event(TOPIC_GOAL_KIND, topicId(), { goal: input.goal ?? null })];
    case "assign":
      return [event(TOPIC_ASSIGN_KIND, topicId(), { record: need(input, "record") })];
    case "unassign":
      return [event(TOPIC_UNASSIGN_KIND, topicId(), { record: need(input, "record") })];
    case "merge": {
      const into = visibleTopic(read, need(input, "into")).id;
      return [event(TOPIC_MERGE_KIND, topicId(), { into })];
    }
    case "split": {
      const into = visibleTopic(read, need(input, "into")).id;
      const topic = visibleTopic(read, need(input, "topic"));
      return splitEvents(read.fold, topic, input, into, (t, body) =>
        event(TOPIC_SPLIT_KIND, t, body),
      );
    }
    case "link": {
      const to = visibleTopic(read, need(input, "to")).id;
      return [
        event(TOPIC_LINK_KIND, topicId(), {
          to,
          ...(input.removed === true ? { removed: true } : {}),
        }),
      ];
    }
    case "undo": {
      const record = need(input, "record");
      const topic = read.recordTopics.get(record);
      // An undo names a topic record the caller can see; any other id is
      // "no such record". Its topic may be gone (an undone create): undoing
      // that undo brings the topic back.
      if (topic === undefined) {
        throw new TopicActionError(`no topic record with id ${record}`);
      }
      return [event(TOPIC_UNDO_KIND, topic, { record })];
    }
    case "record": {
      const kind = need(input, "kind");
      if (!(TOPIC_RECORD_ACTION_KINDS as ReadonlyArray<string>).includes(kind)) {
        throw new TopicActionError(
          `record: kind must be one of ${TOPIC_RECORD_ACTION_KINDS.join(", ")}`,
        );
      }
      const fields = input.fields ?? {};
      return [
        {
          kind: kind as TopicRecordKind,
          topic: recordTopic(
            read.fold,
            visibleTopic(read, need(input, "topic")),
            kind,
            fields,
            input.owner,
          ),
          authority: authorityOf(input, "agent"),
          body: { ...fields },
        },
      ];
    }
    default:
      throw new TopicActionError(`unknown action: ${input.action}`);
  }
}

/** Run one topic action and return its JSON answer. */
export function runTopicAction(
  input: TopicActionInput,
  context: TopicActionContext = {},
): Record<string, unknown> {
  if (!(TOPIC_ACTIONS as ReadonlyArray<string>).includes(input.action)) {
    throw new TopicActionError(`action must be one of ${TOPIC_ACTIONS.join(", ")}`);
  }
  const now = (context.now ?? Date.now)();
  const read = readTopics(context.configPath);
  switch (input.action) {
    case "list":
      return { action: "list", topics: listJson(read.fold, input.listScope) };
    case "show": {
      const topic = visibleTopic(read, need(input, "topic"));
      const held = heldRecordIds(read.fold, topic.id).length;
      const derived =
        held > 0 ? withHeldDecisionsOf(read, context.configPath) : { read, incomplete: false };
      const shown = derived.read;
      return {
        action: "show",
        ...(derived.incomplete ? { decisions_incomplete: true } : {}),
        topic: topicDetail(shown.fold.topics.get(topic.id) ?? topic, held),
        ...(input.held === true ? heldListing(read, topic, context.configPath) : {}),
        page: shownMarkdown(shown, topic, context.configPath),
      };
    }
    case "review": {
      // A fold over a partial read may miss topics: no proposal is made from it.
      if (read.unreadable.length > 0) {
        return {
          action: "review",
          incomplete: true,
          merges: [],
          quiet: [],
          ...(privateWithheld() ? {} : { unreadable: read.unreadable }),
        };
      }
      const review = reviewTopics(read.fold, now, quietDays(context.configPath));
      return {
        action: "review",
        merges: review.merges.map((m) => ({ topics: m.topics, score: m.score })),
        quiet: review.quiet,
      };
    }
  }
  if (input.action === "assign") refuseUnholdable(need(input, "record"), context.configPath);
  const events = eventsOf(input, read, now, context.humanRequest === true);
  const written: AppendResult[] = writeTopicEvents(
    events
      .map((e) => stampSession(e, context.session))
      .map((e) => (context.agent !== undefined ? { ...e, agent: context.agent } : e)),
    {
      ...(context.configPath !== undefined ? { configPath: context.configPath } : {}),
      ...(input.private !== undefined ? { private: input.private } : {}),
    },
  );
  return {
    action: input.action,
    // A split answers the topic it names, also when a merged owner's split comes first.
    topic:
      input.action === "split" ? visibleTopic(read, need(input, "topic")).id : events[0]!.topic,
    records: written.map((w) => w.record.id),
  };
}
