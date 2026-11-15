/**
 * The topic fold (design D4, D8; task 3.1): every topic, its fields, its
 * list items, links, merges and record assignments, folded from topic
 * records in any delivery order.
 *
 * Pure: no I/O, no clock, no model call. The same set of records folds to
 * the same state on every machine (`prepareRecords` gives one canonical
 * order), whatever order the shards arrived in and however often a line
 * was delivered.
 *
 * Rules:
 *
 *  - **Identity.** A topic is its id, the envelope `topic` of its records.
 *    It exists once a `topic-create` for that id is folded; its scope and
 *    creation time are those of the first create in fold order and never
 *    change. It starts active: the create offers no status, so an agent's
 *    status change applies to a topic the user created. A rename changes only the title (and description): every
 *    record keeps naming the same id, so no reference moves.
 *  - **Registers.** The title, description, goal and status of a topic,
 *    each list item, an item's owner, a milestone's completion, a
 *    question's resolution, a merge, a link and a record's assignment are
 *    each one register, resolved by authority, then clock (`RegisterSet`).
 *    An item record with `removed: true`, an `unassign` and a link with
 *    `removed: true` are tombstones.
 *  - **Proposals.** A goal offer that loses to a stronger authority and
 *    comes later than the winner is kept as a proposal (spec "User
 *    rewrites the goal": the page shows it as an open question). A
 *    `milestone-done` counts only from the user, or from an agent that
 *    cites `evidence`; any other one (a decision model, an agent without
 *    evidence) only proposes completion. A `question-resolved` from a
 *    decision model only proposes the resolution.
 *  - **Undo.** An `undo` voids the record it names, provided its authority
 *    is at least that record's; an undo can itself be undone. A voided
 *    record is folded as if it had never been written. An undo of an
 *    `assign` and an `unassign`, by the user or an agent (not by a decision
 *    model), also block that route, so a later automatic pass does not
 *    route the record to that topic again.
 *  - **Merges.** A merged topic resolves to the topic it merged into
 *    ({@link TopicFold.canonical}); its items show on that topic. Merges
 *    apply in fold order of their winning records, and one that would
 *    close a cycle, or names a topic that does not exist, is ignored.
 *  - **Splits.** A split moves the items and the record assignments it
 *    lists to another topic (the item's owner register, the assignment
 *    register).
 *
 * A record of a topic kind whose body is malformed is not applied and is
 * reported in `rejected`.
 */

import { compareCodeUnits } from "../store/compare.ts";
import { compareRecords, type StoreRecord } from "../store/envelope.ts";
import {
  prepareRecords,
  recordAuthority,
  RegisterSet,
  TOMBSTONE,
  type RegisterEntry,
  type RejectedRecord,
} from "../store/fold.ts";
import type { Authority } from "../store/constants.ts";
import { parseHlc } from "../store/hlc.ts";
import {
  TOPIC_ASSIGN_KIND,
  TOPIC_CREATE_KIND,
  TOPIC_DEFAULT_STATUS,
  TOPIC_GOAL_KIND,
  TOPIC_LINK_KIND,
  TOPIC_MERGE_KIND,
  TOPIC_MILESTONE_DONE_KIND,
  TOPIC_QUESTION_RESOLVED_KIND,
  TOPIC_RENAME_KIND,
  TOPIC_SPLIT_KIND,
  TOPIC_STATUS_KIND,
  TOPIC_UNASSIGN_KIND,
  TOPIC_UNDO_KIND,
  type TopicItemKind,
  type TopicLogClass,
  type TopicStatus,
} from "./constants.ts";
import { isTopicItemKind, isTopicRecordKind, topicBodyRejection } from "./records.ts";
import { voidedRecords } from "./undo-fold.ts";

/** Who wrote a record, for attribution on the page. */
export interface TopicAuthor {
  readonly record: string;
  readonly agent: string;
  readonly authority: Authority;
  /** Physical clock of the record, in ms. */
  readonly at: number;
}

export interface TopicItem {
  readonly id: string;
  readonly kind: TopicItemKind;
  /** The topic that owns the item now (before merges resolve; see {@link TopicFold.canonical}). */
  readonly owner: string;
  readonly text: string;
  readonly logClass?: TopicLogClass;
  readonly reason?: string;
  readonly serves?: ReadonlyArray<string>;
  /** The record whose value is shown. */
  readonly author: TopicAuthor;
  /** When the item was first recorded, in ms. */
  readonly createdAt: number;
  /** A milestone marked done by the user, or by an agent that cited evidence. */
  readonly done?: TopicAuthor & { readonly evidence: string | null };
  /** A completion proposed without that standing (spec: "looks done, confirm"). */
  readonly doneProposed?: TopicAuthor;
  readonly resolved?: TopicAuthor & { readonly answer: string | null };
  readonly resolveProposed?: TopicAuthor;
  /** Whether any record of the item, its completions and resolutions included, sits in `private`. */
  readonly private: boolean;
}

export interface GoalProposal extends TopicAuthor {
  readonly goal: string;
}

export interface TopicState {
  readonly id: string;
  readonly title: string;
  readonly description: string | null;
  readonly goal: string | null;
  readonly goalProposals: ReadonlyArray<GoalProposal>;
  readonly status: TopicStatus;
  /** `YYYY-MM-DD` the topic was resolved, for `done` (the record's day when none was given). */
  readonly resolved: string | null;
  readonly scope: string;
  /** Physical clock of the first `topic-create`, in ms. */
  readonly createdAt: number;
  /** Physical clock of the latest record of the topic, in ms. */
  readonly updatedAt: number;
  /** The topic this one merged into, or `null`. */
  readonly mergedInto: string | null;
  /** Topics linked to this one, in id order. */
  readonly links: ReadonlyArray<string>;
  /** Items this topic owns, merged topics' items included, in fold order of their first record. */
  readonly items: ReadonlyArray<TopicItem>;
  /** Whether the topic's first `topic-create` sits in the `private` partition. */
  readonly private: boolean;
  /**
   * Per head field, whether the record whose value is shown sits in the
   * `private` partition: a shared topic can carry a private rename or goal.
   */
  readonly privateFields: Readonly<Record<TopicHeadField, boolean>>;
}

/** The head fields of a topic whose winning record can be private on its own. */
export type TopicHeadField = "title" | "description" | "goal";

export interface TopicFold {
  /** Every existing topic by id, merged ones included. */
  readonly topics: ReadonlyMap<string, TopicState>;
  /** The topic `id` resolves to after merges, or `null` when it does not exist. */
  canonical(id: string): string | null;
  /**
   * Explicit assignments: record id to the canonical topic it was assigned
   * to, or `null` when it was unassigned (or its topic no longer exists).
   */
  readonly assignments: ReadonlyMap<string, string | null>;
  /**
   * Routes the user took back: `<record id>\u0000<topic id>`, each also
   * under the topic its topic merged into.
   */
  readonly blockedRoutes: ReadonlySet<string>;
  /** Records an `undo` voided. */
  readonly voided: ReadonlySet<string>;
  /**
   * Whether `topic` first recorded an item `item` that a split has since
   * moved to another topic: the id still names that item there, so a new
   * item of `topic` must take another id. A removed item stays the
   * topic's, and its id can be recorded again.
   */
  movedAway(topic: string, item: string): boolean;
  /**
   * Records any `assign`, `unassign` or `split` named, voided ones
   * included: material a topic once held. Automatic planning routes such a
   * record but never builds a new topic from it, so a topic the user undid
   * is not created again from the same records.
   */
  readonly touched: ReadonlySet<string>;
  readonly rejected: ReadonlyArray<RejectedRecord>;
}

export interface FoldTopicsOptions {
  /** Ids of the records that sit in the `private` partition. */
  readonly privateIds?: ReadonlySet<string>;
}

/** The key of a blocked route. */
export function routeKey(record: string, topic: string): string {
  return `${record}\u0000${topic}`;
}

function physical(record: StoreRecord): number {
  return parseHlc(record.hlc)!.physical;
}

function authorOf(record: StoreRecord): TopicAuthor {
  return {
    record: record.id,
    agent: record.agent,
    authority: recordAuthority(record)!,
    at: physical(record),
  };
}

function dayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

interface ItemValue {
  readonly kind: TopicItemKind;
  readonly text: string;
  readonly logClass?: TopicLogClass;
  readonly reason?: string;
  readonly serves?: ReadonlyArray<string>;
}

interface Registers {
  readonly title: RegisterSet<string>;
  readonly description: RegisterSet<string | null>;
  readonly goal: RegisterSet<string | null>;
  readonly status: RegisterSet<{ status: TopicStatus; resolved: string | null }>;
  readonly merge: RegisterSet<string>;
  readonly link: RegisterSet<true>;
  readonly item: RegisterSet<ItemValue>;
  readonly owner: RegisterSet<string>;
  readonly done: RegisterSet<string | null>;
  readonly resolved: RegisterSet<string | null>;
  readonly assign: RegisterSet<string>;
}

function newRegisters(): Registers {
  return {
    title: new RegisterSet(),
    description: new RegisterSet(),
    goal: new RegisterSet(),
    status: new RegisterSet(),
    merge: new RegisterSet(),
    link: new RegisterSet(),
    item: new RegisterSet(),
    owner: new RegisterSet(),
    done: new RegisterSet(),
    resolved: new RegisterSet(),
    assign: new RegisterSet(),
  };
}

function entry<V>(record: StoreRecord, value: V | typeof TOMBSTONE): RegisterEntry<V> {
  return { record, authority: recordAuthority(record)!, value };
}

function linkKey(a: string, b: string): string {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}

interface Scratch {
  readonly regs: Registers;
  readonly creates: Map<string, StoreRecord>;
  /** Item register key (`<first topic>\u0000<item id>`) to the item's first record. */
  readonly itemFirst: Map<string, StoreRecord>;
  /** Item id to its register keys, in the order they were first seen. */
  readonly itemKeys: Map<string, string[]>;
  readonly itemRecords: Map<string, string[]>;
  readonly doneProposals: Map<string, StoreRecord>;
  readonly resolveProposals: Map<string, StoreRecord>;
  readonly updated: Map<string, number>;
  readonly blocked: Set<string>;
  readonly rejected: RejectedRecord[];
}

/**
 * The register key of item `item` as topic `topic` names it: an item id
 * is a topic's own, never global, so two topics that pick the same token
 * hold two items. The key is the topic that first recorded the item and
 * the id; a topic the item was split into finds it by its current owner.
 * `null` when the topic holds no such item yet.
 */
function itemKeyFor(s: Scratch, topic: string, item: string): string | null {
  const own = `${topic}\u0000${item}`;
  if (s.itemFirst.has(own)) return own;
  return (s.itemKeys.get(item) ?? []).find((k) => s.regs.owner.get(k)?.value === topic) ?? null;
}

function applyItem(s: Scratch, record: StoreRecord): void {
  const kind = record.kind as TopicItemKind;
  const id = typeof record.body["item"] === "string" ? record.body["item"] : record.id;
  const known = itemKeyFor(s, record.topic!, id);
  const item = known ?? `${record.topic!}\u0000${id}`;
  const first = s.itemFirst.get(item);
  if (first !== undefined && first.kind !== kind) {
    s.rejected.push({ id: record.id, kind, reason: `item ${id} is a ${first.kind}` });
    return;
  }
  if (first === undefined) {
    s.itemFirst.set(item, record);
    s.itemKeys.set(id, [...(s.itemKeys.get(id) ?? []), item]);
    s.regs.owner.offer(item, entry(record, record.topic!));
  }
  s.itemRecords.set(item, [...(s.itemRecords.get(item) ?? []), record.id]);
  if (record.body["removed"] === true) {
    s.regs.item.offer(item, entry<ItemValue>(record, TOMBSTONE));
    return;
  }
  const body = record.body;
  // A decision record that leaves `serves` out (a reworded page line)
  // keeps the links the item has; `"serves": []` clears them.
  const prior = s.regs.item.get(item);
  const serves = Array.isArray(body["serves"])
    ? (body["serves"] as string[])
    : prior !== undefined && !prior.removed
      ? prior.value!.serves
      : undefined;
  const value: ItemValue = {
    kind,
    text: body["text"] as string,
    ...(typeof body["class"] === "string" ? { logClass: body["class"] as TopicLogClass } : {}),
    ...(typeof body["reason"] === "string" ? { reason: body["reason"] } : {}),
    ...(serves !== undefined ? { serves } : {}),
  };
  s.regs.item.offer(item, entry(record, value));
}

function applyRecord(s: Scratch, record: StoreRecord): void {
  const topic = record.topic!;
  const body = record.body;
  const authority = recordAuthority(record)!;
  s.updated.set(topic, Math.max(s.updated.get(topic) ?? 0, physical(record)));
  if (isTopicItemKind(record.kind)) {
    applyItem(s, record);
    return;
  }
  switch (record.kind) {
    case TOPIC_CREATE_KIND:
      if (!s.creates.has(topic)) s.creates.set(topic, record);
      s.regs.title.offer(topic, entry(record, body["title"] as string));
      if (body["description"] !== undefined) {
        s.regs.description.offer(topic, entry(record, body["description"] as string | null));
      }
      if (body["goal"] !== undefined) {
        s.regs.goal.offer(topic, entry(record, body["goal"] as string | null));
      }
      return;
    case TOPIC_RENAME_KIND:
      if (body["title"] !== undefined)
        s.regs.title.offer(topic, entry(record, body["title"] as string));
      if (body["description"] !== undefined) {
        s.regs.description.offer(topic, entry(record, body["description"] as string | null));
      }
      return;
    case TOPIC_STATUS_KIND: {
      const status = body["status"] as TopicStatus;
      const resolved =
        status === "done"
          ? ((body["resolved"] as string | undefined) ?? dayOf(physical(record)))
          : null;
      s.regs.status.offer(topic, entry(record, { status, resolved }));
      return;
    }
    case TOPIC_GOAL_KIND:
      s.regs.goal.offer(topic, entry(record, body["goal"] as string | null));
      return;
    case TOPIC_MILESTONE_DONE_KIND: {
      const id = body["milestone"] as string;
      const milestone = itemKeyFor(s, topic, id) ?? `${topic}\u0000${id}`;
      const evidence = typeof body["evidence"] === "string" ? body["evidence"] : null;
      // A completion counts for the item's privacy: its evidence is its text.
      s.itemRecords.set(milestone, [...(s.itemRecords.get(milestone) ?? []), record.id]);
      if (authority === "human" || (authority === "agent" && evidence !== null)) {
        s.regs.done.offer(milestone, entry(record, evidence));
      } else {
        s.doneProposals.set(milestone, record);
      }
      return;
    }
    case TOPIC_QUESTION_RESOLVED_KIND: {
      const id = body["question"] as string;
      const question = itemKeyFor(s, topic, id) ?? `${topic}\u0000${id}`;
      const answer = typeof body["answer"] === "string" ? body["answer"] : null;
      // A resolution counts for the item's privacy: its answer is its text.
      s.itemRecords.set(question, [...(s.itemRecords.get(question) ?? []), record.id]);
      if (authority === "model") s.resolveProposals.set(question, record);
      else s.regs.resolved.offer(question, entry(record, answer));
      return;
    }
    case TOPIC_ASSIGN_KIND:
      s.regs.assign.offer(body["record"] as string, entry(record, topic));
      return;
    case TOPIC_UNASSIGN_KIND:
      s.regs.assign.offer(body["record"] as string, entry<string>(record, TOMBSTONE));
      // Taking a route back is the signal, whoever writes it: only a
      // decision model's unassign leaves the route open.
      if (authority !== "model") s.blocked.add(routeKey(body["record"] as string, topic));
      return;
    case TOPIC_MERGE_KIND:
      s.regs.merge.offer(topic, entry(record, body["into"] as string));
      return;
    case TOPIC_SPLIT_KIND:
      // The topic that receives items or records has news too.
      s.updated.set(
        body["into"] as string,
        Math.max(s.updated.get(body["into"] as string) ?? 0, physical(record)),
      );
      for (const id of (body["items"] as string[] | undefined) ?? []) {
        const item = itemKeyFor(s, topic, id);
        if (item !== null) s.regs.owner.offer(item, entry(record, body["into"] as string));
      }
      for (const id of (body["records"] as string[] | undefined) ?? []) {
        s.regs.assign.offer(id, entry(record, body["into"] as string));
      }
      return;
    case TOPIC_LINK_KIND:
      s.regs.link.offer(
        linkKey(topic, body["to"] as string),
        entry<true>(record, body["removed"] === true ? TOMBSTONE : true),
      );
      return;
  }
}

/** Fold topic records (any order, duplicates allowed); records of other kinds are ignored. */
export function foldTopics(
  input: Iterable<StoreRecord>,
  options: FoldTopicsOptions = {},
): TopicFold {
  const privateIds = options.privateIds ?? new Set<string>();
  const { records } = prepareRecords(input);
  const s: Scratch = {
    regs: newRegisters(),
    creates: new Map(),
    itemFirst: new Map(),
    itemKeys: new Map(),
    itemRecords: new Map(),
    doneProposals: new Map(),
    resolveProposals: new Map(),
    updated: new Map(),
    blocked: new Set(),
    rejected: [],
  };
  const valid: StoreRecord[] = [];
  for (const record of records) {
    if (!isTopicRecordKind(record.kind)) continue;
    const reason = topicBodyRejection(record.kind, record.topic, record.body);
    if (reason === null) valid.push(record);
    else s.rejected.push({ id: record.id, kind: record.kind, reason });
  }
  const voided = voidedRecords(valid);
  const routeUndone = new Set(
    valid
      .filter(
        (u) => u.kind === TOPIC_UNDO_KIND && !voided.has(u.id) && u.body["authority"] !== "model",
      )
      .map((u) => u.body["record"] as string),
  );
  for (const record of valid) {
    if (voided.has(record.id)) {
      // A route taken back (by the user or an agent, never by a decision
      // model): no automatic pass routes it there again.
      if (record.kind === TOPIC_ASSIGN_KIND && routeUndone.has(record.id)) {
        s.blocked.add(routeKey(record.body["record"] as string, record.topic!));
      }
      continue;
    }
    if (record.kind !== TOPIC_UNDO_KIND) applyRecord(s, record);
  }
  const touched = new Set<string>();
  for (const record of valid) {
    if (record.kind === TOPIC_ASSIGN_KIND || record.kind === TOPIC_UNASSIGN_KIND) {
      touched.add(record.body["record"] as string);
    } else if (record.kind === TOPIC_SPLIT_KIND) {
      for (const id of (record.body["records"] as string[] | undefined) ?? []) touched.add(id);
    }
  }
  return { ...assemble(s, voided, privateIds), touched };
}

function canonicalResolver(s: Scratch): (id: string) => string | null {
  const edges = new Map<string, string>();
  const winners = s.regs.merge
    .keys()
    .map((source) => ({ source, state: s.regs.merge.get(source)! }))
    .filter(({ state }) => !state.removed)
    .toSorted((a, b) => compareRecords(a.state.winner.record, b.state.winner.record));
  const resolve = (id: string): string => {
    let at = id;
    const seen = new Set<string>();
    while (edges.has(at) && !seen.has(at)) {
      seen.add(at);
      at = edges.get(at)!;
    }
    return at;
  };
  for (const { source, state } of winners) {
    const into = state.value!;
    if (!s.creates.has(source) || !s.creates.has(into)) continue;
    if (resolve(into) === source) continue; // would close a cycle
    edges.set(source, into);
  }
  return (id) => (s.creates.has(id) ? resolve(id) : null);
}

function goalProposals(s: Scratch, topic: string): GoalProposal[] {
  const state = s.regs.goal.get(topic);
  if (state === undefined) return [];
  const winnerAt = state.history.indexOf(state.winner);
  const out: GoalProposal[] = [];
  for (const offer of state.history.slice(winnerAt + 1)) {
    const goal = offer.value;
    if (typeof goal !== "string" || goal === state.value) continue;
    if (out.some((p) => p.goal === goal)) continue;
    out.push({ ...authorOf(offer.record), goal });
  }
  return out;
}

function buildItem(
  s: Scratch,
  key: string,
  owner: string,
  privateIds: ReadonlySet<string>,
): TopicItem | null {
  const id = key.slice(key.indexOf("\u0000") + 1);
  const state = s.regs.item.get(key);
  if (state === undefined || state.removed) return null;
  const value = state.value!;
  const first = s.itemFirst.get(key)!;
  const done = s.regs.done.get(key);
  const resolved = s.regs.resolved.get(key);
  const proposedDone = s.doneProposals.get(key);
  const proposedResolve = s.resolveProposals.get(key);
  const isMilestone = value.kind === "milestone";
  const isQuestion = value.kind === "open-question";
  return {
    id,
    kind: value.kind,
    owner,
    text: value.text,
    ...(value.logClass !== undefined ? { logClass: value.logClass } : {}),
    ...(value.reason !== undefined ? { reason: value.reason } : {}),
    ...(value.serves !== undefined ? { serves: value.serves } : {}),
    author: authorOf(state.winner.record),
    createdAt: physical(first),
    ...(isMilestone && done !== undefined
      ? { done: { ...authorOf(done.winner.record), evidence: done.value } }
      : {}),
    ...(isMilestone && done === undefined && proposedDone !== undefined
      ? { doneProposed: authorOf(proposedDone) }
      : {}),
    ...(isQuestion && resolved !== undefined
      ? { resolved: { ...authorOf(resolved.winner.record), answer: resolved.value } }
      : {}),
    ...(isQuestion && resolved === undefined && proposedResolve !== undefined
      ? { resolveProposed: authorOf(proposedResolve) }
      : {}),
    private: (s.itemRecords.get(key) ?? []).some((r) => privateIds.has(r)),
  };
}

/**
 * The routes taken back, each also under the topic its topic resolves to
 * now: a route back from a topic later merged away still keeps the record
 * from the topic that shows the merged one's material.
 */
function blockedThroughMerges(
  blocked: ReadonlySet<string>,
  canonical: (id: string) => string | null,
): Set<string> {
  const out = new Set(blocked);
  for (const key of blocked) {
    const [record, topic] = key.split("\u0000") as [string, string];
    const home = canonical(topic);
    if (home !== null && home !== topic) out.add(routeKey(record, home));
  }
  return out;
}

function assemble(
  s: Scratch,
  voided: Set<string>,
  privateIds: ReadonlySet<string>,
): Omit<TopicFold, "touched"> {
  const canonical = canonicalResolver(s);
  const items = new Map<string, TopicItem[]>();
  // A topic's activity includes that of the topics merged into it, whose
  // items it shows (an edit of such an item is written under its owner).
  const activity = new Map<string, number>();
  for (const [id, create] of s.creates) {
    const home = canonical(id)!;
    const at = s.updated.get(id) ?? physical(create);
    activity.set(home, Math.max(activity.get(home) ?? 0, at));
  }
  const ordered = [...s.itemFirst.entries()].toSorted(([, a], [, b]) => compareRecords(a, b));
  for (const [id] of ordered) {
    const owner = s.regs.owner.get(id)!.value!;
    const home = canonical(owner);
    if (home === null) continue;
    const item = buildItem(s, id, owner, privateIds);
    if (item !== null) items.set(home, [...(items.get(home) ?? []), item]);
  }
  const links = new Map<string, string[]>();
  for (const key of s.regs.link.keys()) {
    if (s.regs.link.get(key)!.removed) continue;
    const [a, b] = key.split("\u0000") as [string, string];
    if (!s.creates.has(a) || !s.creates.has(b)) continue;
    links.set(a, [...(links.get(a) ?? []), b]);
    links.set(b, [...(links.get(b) ?? []), a]);
  }
  const topics = new Map<string, TopicState>();
  const winnerPrivate = (reg: RegisterSet<unknown>, id: string): boolean => {
    const state = reg.get(id);
    return state !== undefined && privateIds.has(state.winner.record.id);
  };
  for (const [id, create] of s.creates) {
    // A topic starts active; the create does not claim the status, so the
    // first `topic-status` of any authority applies (a later human one wins).
    const status = s.regs.status.get(id)?.value ?? { status: TOPIC_DEFAULT_STATUS, resolved: null };
    const home = canonical(id)!;
    topics.set(id, {
      id,
      title: s.regs.title.get(id)!.value!,
      description: s.regs.description.get(id)?.value ?? null,
      goal: s.regs.goal.get(id)?.value ?? null,
      goalProposals: goalProposals(s, id),
      status: status.status,
      resolved: status.resolved,
      scope: create.body["scope"] as string,
      createdAt: physical(create),
      updatedAt: home === id ? activity.get(id)! : (s.updated.get(id) ?? physical(create)),
      mergedInto: home === id ? null : home,
      links: (links.get(id) ?? []).toSorted(),
      items: home === id ? (items.get(id) ?? []) : [],
      private: privateIds.has(create.id),
      privateFields: {
        title: winnerPrivate(s.regs.title, id),
        description: winnerPrivate(s.regs.description, id),
        goal: winnerPrivate(s.regs.goal, id),
      },
    });
  }
  const assignments = new Map<string, string | null>();
  for (const record of s.regs.assign.keys()) {
    const state = s.regs.assign.get(record)!;
    assignments.set(record, state.removed ? null : canonical(state.value!));
  }
  return {
    topics,
    canonical,
    assignments,
    blockedRoutes: blockedThroughMerges(s.blocked, canonical),
    voided,
    movedAway: (topic, item) => {
      const key = `${topic}\u0000${item}`;
      return s.itemFirst.has(key) && s.regs.owner.get(key)?.value !== topic;
    },
    rejected: s.rejected,
  };
}

/**
 * The canonical topic a record belongs to: its explicit assignment, else
 * the topic its envelope names; `null` when neither names an existing
 * topic. A topic record itself belongs to the topic it names.
 */
export function topicOfRecord(fold: TopicFold, record: StoreRecord): string | null {
  if (!isTopicRecordKind(record.kind)) {
    if (fold.assignments.has(record.id)) return fold.assignments.get(record.id)!;
  }
  return record.topic === null ? null : fold.canonical(record.topic);
}

/**
 * The resolved state of a topic fold as plain JSON, for the state digests
 * (design D6): two machines whose cuts hold the same topic records give
 * the same fingerprint.
 */
export function topicsFingerprint(fold: TopicFold): unknown {
  return {
    topics: [...fold.topics.values()].toSorted((a, b) => compareCodeUnits(a.id, b.id)),
    assignments: [...fold.assignments].toSorted(([a], [b]) => compareCodeUnits(a, b)),
    blocked: [...fold.blockedRoutes].toSorted(compareCodeUnits),
    voided: [...fold.voided].toSorted(compareCodeUnits),
    rejected: fold.rejected.map((r) => r.id),
  };
}
