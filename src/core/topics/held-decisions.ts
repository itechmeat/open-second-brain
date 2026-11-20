/**
 * Decision items a topic shows for the decisions it holds (design D10
 * `event_kind`, deterministic fallback "the kind the agent passed").
 *
 * `brain_decision` (and `o2b brain decision`) write `decision-record` and
 * `decision-resolved` log events: the agent named the kind, so a topic that
 * holds such an event shows it as a decision item without a decision
 * model. The item is derived when a page or `show` is read, from the
 * records the reader already holds; nothing is written for it. So:
 *
 *  - It exists exactly while the topic holds the event: an undo of the
 *    `assign` (or of the topic) takes it away, a topic made before this
 *    rule gains it at its next render, and a second pass writes nothing.
 *  - It follows its records' partition and reach: the view renders it from
 *    `shared` records without a `<private>` region only, a caller below
 *    local reach reads `shared` only, and its text has every `<private>`
 *    region removed, as planning reads it (`candidates.ts`).
 *  - One decision is one item: the events that name the same decision page
 *    (`decision`, the wikilink of the page; a resolve writes the minted
 *    page's `decision-record` and the `decision-resolved`) give one item,
 *    keyed by the smallest id among them, marked resolved when a
 *    `decision-resolved` is among them, and showing the newest
 *    `decision-outcome` written for the page.
 *  - A topic record for the same decision wins: when any topic record ever
 *    named one of those ids as an item of the topic (a decision model's
 *    `event_kind` item, whose id is the record id; the user's edit or
 *    deletion of the derived line, keyed by the item id), nothing is
 *    derived, so there is never a second item for one decision. The
 *    user's item of an edited line keeps the decision's time, so the line
 *    stays where it was on the page (a line that moved would meet the
 *    user's copy of it at its old place in the page merge).
 *
 * The derived item carries `derived`, which the page uses to keep it from
 * displacing a recorded item within the page budget. Pure, apart from
 * {@link readDecisionEvents}.
 */

import { compareRecords, type StoreRecord } from "../store/envelope.ts";
import { LOG_EVENT_KIND, type StorePartition } from "../store/constants.ts";
import { privateWithheld } from "../store/caller-reach.ts";
import { valueCarriesPrivateRegion } from "../store/private-region.ts";
import { readStreamRecords } from "../store/read/stream-read.ts";
import type { StoreInspection } from "../store/store-open.ts";
import { topicCandidates, withoutPrivateRegions } from "./candidates.ts";
import type { TopicFold, TopicItem, TopicState } from "./fold.ts";

const DECISION_RECORD = "decision-record";
const DECISION_RESOLVED = "decision-resolved";
const DECISION_OUTCOME = "decision-outcome";

/** The log event types a derived decision item is built from. */
const DECISION_EVENTS: ReadonlySet<unknown> = new Set([
  DECISION_RECORD,
  DECISION_RESOLVED,
  DECISION_OUTCOME,
]);

/** Whether `record` is a log event a derived decision item may be built from. */
export function isDecisionEvent(record: StoreRecord): boolean {
  return record.kind === LOG_EVENT_KIND && DECISION_EVENTS.has(record.body["event_type"]);
}

function payloadOf(record: StoreRecord): Record<string, unknown> {
  const body = record.body["body"];
  return typeof body === "object" && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

/** The decision page an event names (its `decision` wikilink, trimmed), or `null`. */
function decisionPageOf(record: StoreRecord): string | null {
  const link = payloadOf(record)["decision"];
  return typeof link === "string" && link.trim() !== "" ? link.trim() : null;
}

interface Group {
  /** The `decision-record` and `decision-resolved` events of one decision, in record order. */
  readonly events: StoreRecord[];
  outcome: StoreRecord | null;
}

/**
 * `fold` with the decision items its topics' held decision events give.
 * `records` are the log events the reader holds (others are ignored);
 * `privateIds` names those of the `private` partition.
 */
export function withHeldDecisions(
  fold: TopicFold,
  records: ReadonlyArray<StoreRecord>,
  privateIds: ReadonlySet<string> = new Set(),
): TopicFold {
  if (fold.assignments.size === 0) return fold;
  const events = records.filter(isDecisionEvent).toSorted(compareRecords);
  const candidates = new Map(
    topicCandidates(
      events.filter((r) => r.body["event_type"] !== DECISION_OUTCOME),
      privateIds,
    ).map((c) => [c.id, c]),
  );
  const groups = new Map<string, Group>();
  const groupOf = (key: string): Group => {
    let group = groups.get(key);
    if (group === undefined) {
      group = { events: [], outcome: null };
      groups.set(key, group);
    }
    return group;
  };
  for (const record of events) {
    const page = decisionPageOf(record);
    if (record.body["event_type"] === DECISION_OUTCOME) {
      if (page === null) continue;
      const text = payloadOf(record)["outcome"];
      if (typeof text === "string" && withoutPrivateRegions(text) !== "") {
        groupOf(`page:${page}`).outcome = record;
      }
      continue;
    }
    if (!candidates.has(record.id)) continue;
    groupOf(page === null ? `id:${record.id}` : `page:${page}`).events.push(record);
  }
  const added = new Map<string, TopicItem[]>();
  const redated = new Map<TopicItem, number>();
  for (const group of groups.values()) {
    if (group.events.length === 0) continue;
    const ids = group.events.map((r) => r.id);
    const holders = new Set<string>();
    for (const id of ids) {
      const topic = fold.assignments.get(id);
      if (topic !== undefined && topic !== null) holders.add(topic);
    }
    for (const topic of holders) {
      const state = fold.topics.get(topic);
      if (state === undefined || state.mergedInto !== null) continue;
      if (ids.some((id) => fold.itemRecorded(topic, id))) {
        // The user's edit of the derived line made it a recorded item:
        // it keeps the decision's time, so it stays where it was on the page.
        const at = Math.min(...group.events.map((r) => candidates.get(r.id)!.at));
        for (const item of state.items) {
          if (item.author.authority === "human" && ids.includes(item.id) && item.createdAt > at) {
            redated.set(item, at);
          }
        }
        continue;
      }
      added.set(topic, [
        ...(added.get(topic) ?? []),
        derivedItem(topic, group, candidates, privateIds),
      ]);
    }
  }
  if (added.size === 0 && redated.size === 0) return fold;
  const topics = new Map<string, TopicState>();
  for (const [id, state] of fold.topics) {
    const extra = added.get(id) ?? [];
    const own = state.items.map((item) => {
      const at = redated.get(item);
      return at === undefined ? item : { ...item, createdAt: at };
    });
    topics.set(
      id,
      extra.length === 0 && own.every((item, i) => item === state.items[i])
        ? state
        : { ...state, items: [...own, ...extra] },
    );
  }
  return { ...fold, topics };
}

interface CandidateFacts {
  readonly text: string;
  readonly at: number;
  readonly private: boolean;
}

function derivedItem(
  topic: string,
  group: Group,
  candidates: ReadonlyMap<string, CandidateFacts>,
  privateIds: ReadonlySet<string>,
): TopicItem {
  // The decision itself (the page's `decision-record`) speaks for the
  // item; a resolution alone does when the record is not readable here.
  const source =
    group.events.find((r) => r.body["event_type"] === DECISION_RECORD) ?? group.events[0]!;
  const facts = candidates.get(source.id)!;
  const outcome = group.outcome;
  const outcomeText =
    outcome === null ? null : withoutPrivateRegions(String(payloadOf(outcome)["outcome"]));
  const outcomePrivate =
    outcome !== null && (privateIds.has(outcome.id) || valueCarriesPrivateRegion(outcome.body));
  return {
    id: group.events.map((r) => r.id).toSorted()[0]!,
    kind: "decision",
    owner: topic,
    text: facts.text,
    author: { record: source.id, agent: source.agent, authority: "agent", at: facts.at },
    createdAt: Math.min(...group.events.map((r) => candidates.get(r.id)!.at)),
    private: group.events.some((r) => candidates.get(r.id)!.private) || outcomePrivate,
    derived: {
      resolved: group.events.some((r) => r.body["event_type"] === DECISION_RESOLVED),
      outcome: outcomeText,
    },
  };
}

/**
 * The decision events of `store` the caller of the work running now may
 * read: the `log` stream of every partition this machine holds, `shared`
 * alone below local reach (where a record with a `<private>` region is
 * left out too). Reads every `log` shard through the stream reader, so a
 * shard that cannot be read, or that vanished since this machine read it,
 * is named in `unreadable` (the same reader and rules the held listing's
 * log records go through, `held-records.ts`), keeping only decision
 * events, so it holds no more than those in memory.
 */
export function readDecisionEvents(store: StoreInspection): {
  readonly records: StoreRecord[];
  readonly privateIds: Set<string>;
  /** Partition-relative paths of `log` shards not read in full. */
  readonly unreadable: ReadonlyArray<string>;
} {
  const withhold = privateWithheld();
  const partitions = [...store.partitions].filter((p) => !withhold || p === "shared");
  const records: StoreRecord[] = [];
  const privateIds = new Set<string>();
  const unreadable: string[] = [];
  for (const partition of partitions as StorePartition[]) {
    const read = readStreamRecords(
      store.root,
      partition,
      { stream: "log" },
      { keep: isDecisionEvent },
    );
    unreadable.push(...read.unreadable.map((rel) => `${partition}/${rel}`));
    for (const record of read.records) {
      if (withhold && valueCarriesPrivateRegion(record.body)) continue;
      records.push(record);
      if (partition === "private") privateIds.add(record.id);
    }
  }
  return { records, privateIds, unreadable };
}
