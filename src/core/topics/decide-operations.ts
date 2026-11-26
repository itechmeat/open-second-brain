/**
 * The closed questions of dream as dream work operations (change
 * `dream-closed-questions`, design D3): seven operations, one per use of
 * the former decide pass, one item per subject.
 *
 * Each operation knows its subjects, the input an answer is produced for
 * (hashed into the item), the payload an executor is shown and the shape
 * of a valid answer. None of them applies its answer through the queue:
 * topic planning applies them under its own lock (`appliedBy:
 * "planning"`, design D2) and marks the items applied.
 *
 * Payloads are built without the egress mask: an item holds the full text
 * in the partition of its most private source, and masking and refusal
 * belong to the executor at take time (`decision-executor.ts`).
 */

import type { DreamWorkItem } from "../brain/dream-queue/fold.ts";
import {
  registerDreamWorkOperation,
  type DreamWorkContext,
  type DreamWorkInput,
  type DreamWorkReads,
} from "../brain/dream-queue/operations.ts";
import {
  readDreamWork,
  readDreamWorkAt,
  readDreamWorkLater,
  type ProduceSpec,
} from "../brain/dream-queue/queue.ts";
import { dreamWorkInputHash } from "../brain/dream-queue/records.ts";
import type { DreamWorkState } from "../brain/dream-queue/fold.ts";
import {
  DREAM_TOPIC_USES,
  EVENT_KIND_OPTIONS,
  TOPIC_DECISION_LIMITS,
  TOPIC_SAME_QUESTIONS,
  TOPIC_USE_QUESTION_VERSION,
} from "../decision-model/questions-topics.ts";
import {
  LOG_EVENT_KIND,
  SETTING_TOPIC_MIN_RECORDS,
  SETTING_TOPIC_MIN_SESSIONS,
  SETTING_TOPIC_QUIET_DAYS,
  type StorePartition,
} from "../store/constants.ts";
import type { StoreRecord } from "../store/envelope.ts";
import { foldSettings, settingValue } from "../store/fold-settings.ts";
import { parseHlc } from "../store/hlc.ts";
import { textCarriesPrivateRegion, valueCarriesPrivateRegion } from "../store/private-region.ts";
import type { StoreHandle } from "../store/store-open.ts";
import {
  catchUpWhere,
  catchUpWhereKept,
  partitionRecords,
  type CatchUpTails,
  type ViewCatchUp,
} from "../view/catch-up.ts";
import { isTopicPlanningInput, topicCandidates, type TopicCandidate } from "./candidates.ts";
import { decisionTitlesOfCatchUp } from "./decision-titles.ts";
import { foldTopics, type TopicFold, type TopicState } from "./fold.ts";
import { planTopics, topicPairsForSame, type PlanSettings, type TopicPlan } from "./plan.ts";
import { judgedHistoryNotes } from "./verdict-writes.ts";
import {
  itemIdOf,
  TOPIC_WORDING_OPERATION,
  TOPIC_WORDING_PROMPT,
  wordingInput,
  wordingInputHash,
  wordingRejection,
  type WordingGroup,
} from "./wording-operation.ts";
import type { TopicVerdictBody, TopicVerdicts } from "./verdicts.ts";

// ----- Names -------------------------------------------------------------

/** The seven operations, named after their uses with hyphens. */
export const CLOSED_OPERATIONS = Object.freeze([
  "topic-route",
  "topic-new",
  "topic-same",
  "event-kind",
  "question-resolved",
  "milestone-done",
  "human-readable",
] as const);

export type ClosedOperation = (typeof CLOSED_OPERATIONS)[number];
export type ClosedUse = (typeof DREAM_TOPIC_USES)[number];

/** The operation of a use (`topic_route` -> `topic-route`). */
export function operationOfUse(use: ClosedUse): ClosedOperation {
  return use.replaceAll("_", "-") as ClosedOperation;
}

/** The use of an operation (`topic-route` -> `topic_route`), or `null` for another operation. */
export function useOfOperation(operation: string): ClosedUse | null {
  const use = operation.replaceAll("-", "_");
  return (DREAM_TOPIC_USES as ReadonlyArray<string>).includes(use) ? (use as ClosedUse) : null;
}

/** Whether `operation` is one of the closed questions. */
export function isClosedOperation(operation: string): operation is ClosedOperation {
  return (CLOSED_OPERATIONS as ReadonlyArray<string>).includes(operation);
}

/** The threshold name an operation's answer is compared against. */
export const THRESHOLD_NAME: Readonly<Record<ClosedOperation, string>> = {
  "topic-route": "route_min",
  "topic-new": "veto_below",
  "topic-same": "same_min",
  "event-kind": "kind_min",
  "question-resolved": "resolved_min",
  "milestone-done": "done_min",
  "human-readable": "hide_below",
};

/** The effect marker of an answer that decided nothing (design D5). */
export const ABSTAINED = "abstained";
/** Effect markers of decisions that write no record of their own (design D2). */
export const STANDING_MARK = Object.freeze({
  veto: "veto",
  /** An approved group that waits for its wording (change `dream-launched-agent`). */
  approved: "approved",
  none: "none",
  same: "same",
  different: "different",
});

// ----- Answer values -------------------------------------------------------

/** The value of an answer to a choice question. */
export interface ChoiceAnswerValue {
  readonly choice: string;
  /** The probability of the chosen option; absent when the answerer gave none. */
  readonly confidence?: number;
  readonly provider: string;
  readonly model: string;
  /** The threshold the answerer's configuration applies to this model (absent: built-in). */
  readonly threshold?: number;
}

/** The value of an answer to a yes-or-no question: the probability of yes. */
export interface ProbabilityAnswerValue {
  readonly p: number;
  readonly provider: string;
  readonly model: string;
  readonly threshold?: number;
}

const CHOICE_OPERATIONS: ReadonlySet<string> = new Set([
  "topic-route",
  "topic-same",
  "event-kind",
  "question-resolved",
]);

/** Whether `operation` is answered with a choice (else with a probability). */
export function isChoiceOperation(operation: string): boolean {
  return CHOICE_OPERATIONS.has(operation);
}

function isUnit(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

/** Why `value` is not an answer to `item`, or `null`. */
export function closedAnswerRejection(value: unknown, item: DreamWorkItem): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "the answer must be an object";
  }
  const v = value as Record<string, unknown>;
  if (typeof v["provider"] !== "string" || v["provider"] === "") return "missing provider";
  if (typeof v["model"] !== "string" || v["model"] === "") return "missing model";
  if (v["threshold"] !== undefined && !isUnit(v["threshold"])) {
    return "threshold must be a probability";
  }
  if (isChoiceOperation(item.body.operation)) {
    const options = item.body.answer_schema["options"];
    if (typeof v["choice"] !== "string") return "missing choice";
    if (!Array.isArray(options) || !options.includes(v["choice"])) {
      return `the choice ${v["choice"]} is not one of the item's options`;
    }
    if (v["confidence"] !== undefined && !isUnit(v["confidence"])) {
      return "confidence must be a probability";
    }
    return null;
  }
  if (!isUnit(v["p"])) return "p must be a probability";
  return null;
}

// ----- The state questions are asked about ------------------------------------

/**
 * Verdicts that hold in every later pass with no record of their own
 * (design D2): read from finished items of the queue.
 */
export interface StandingVerdicts {
  /** Records a confident `none` route keeps free. */
  readonly none: ReadonlyMap<string, TopicVerdictBody>;
  /** Group keys a `topic-new` answer vetoed. */
  readonly vetoes: ReadonlyMap<string, TopicVerdictBody>;
  /** Group key to how many members the group had when it was vetoed. */
  readonly vetoSizes: ReadonlyMap<string, number>;
  /** Group keys a `topic-new` answer approved, whose topic waits for its wording. */
  readonly approvals: ReadonlyMap<string, TopicVerdictBody>;
  /** Pair hints from `topic-same` answers, the newest per pair. */
  readonly same: TopicVerdicts["sameTopics"];
}

export const NO_STANDING: StandingVerdicts = {
  none: new Map(),
  vetoes: new Map(),
  vetoSizes: new Map(),
  approvals: new Map(),
  same: [],
};

/** What every closed question is built from: one read of the store. */
export interface TopicQuestionState {
  readonly fold: TopicFold;
  readonly candidates: ReadonlyArray<TopicCandidate>;
  readonly byId: ReadonlyMap<string, TopicCandidate>;
  readonly settings: PlanSettings;
  /** Shared `note` log events no stored history verdict judges yet. */
  readonly notes: ReadonlyArray<{
    readonly id: string;
    readonly text: string;
    readonly at: number;
  }>;
  readonly standing: StandingVerdicts;
  /** The plan with the standing verdicts only: what still asks for an answer. */
  readonly plan: TopicPlan;
  /** The moment the state is read for: records dated after it are future-dated. */
  readonly nowMs: number;
}

/** The verdict body of an answer value. */
export function verdictOfAnswer(
  use: ClosedUse,
  value: { readonly provider: string; readonly model: string },
  confidence: number,
): TopicVerdictBody {
  return {
    use,
    model: value.model,
    provider: value.provider,
    version: TOPIC_USE_QUESTION_VERSION[use],
    mode: "enforce",
    confidence,
  };
}

/** The standing verdicts of the queue's finished closed items, in queue order. */
export function standingVerdicts(state: DreamWorkState): StandingVerdicts {
  const none = new Map<string, TopicVerdictBody>();
  const vetoes = new Map<string, TopicVerdictBody>();
  const vetoSizes = new Map<string, number>();
  const approvals = new Map<string, TopicVerdictBody>();
  const same = new Map<string, TopicVerdicts["sameTopics"][number]>();
  for (const id of state.order) {
    const item = state.items.get(id)!;
    if (item.state !== "finished" || item.answer === null || item.applied === null) continue;
    const mark = item.applied.effects[0];
    const value = item.answer.value as Record<string, unknown>;
    const op = item.body.operation;
    if (op === "topic-route") {
      // A later answer for the record replaces an earlier one.
      if (mark === STANDING_MARK.none) {
        none.set(item.body.subject, verdictOfAnswer("topic_route", value as never, conf(value)));
      } else if (mark !== ABSTAINED) none.delete(item.body.subject);
    } else if (op === "topic-new") {
      vetoes.delete(item.body.subject);
      approvals.delete(item.body.subject);
      const verdict = verdictOfAnswer("topic_new", value as never, conf(value));
      if (mark === STANDING_MARK.veto) {
        vetoes.set(item.body.subject, verdict);
        const members = item.body.payload["members"];
        if (Array.isArray(members)) vetoSizes.set(item.body.subject, members.length);
      } else if (mark === STANDING_MARK.approved) approvals.set(item.body.subject, verdict);
    } else if (op === "topic-same") {
      if (mark !== STANDING_MARK.same && mark !== STANDING_MARK.different) continue;
      const [a, b] = item.body.subject.split("..") as [string, string];
      same.set(item.body.subject, {
        a,
        b,
        option: mark,
        verdict: {
          ...verdictOfAnswer("topic_same", value as never, conf(value)),
          version: Number(item.body.prompt_version),
        },
      });
    }
  }
  return { none, vetoes, vetoSizes, approvals, same: [...same.values()] };
}

function conf(value: Record<string, unknown>): number {
  const c = value["confidence"] ?? value["p"];
  return typeof c === "number" ? c : 0;
}

/**
 * The merge hints of `topic-same` answers that stand, read from the queue
 * of the store at `root` over `partitions` without writing anything (the
 * topic review, from the brief and from the topic tool).
 */
export function standingMergeHints(
  root: string,
  partitions: ReadonlySet<StorePartition>,
): TopicVerdicts["sameTopics"] | null {
  try {
    const work = readDreamWorkAt(root, partitions);
    return work.unreadable.length > 0 ? null : standingVerdicts(work).same;
  } catch {
    return null;
  }
}

/** The standing verdicts as the planner reads them. */
export function standingAsVerdicts(standing: StandingVerdicts): TopicVerdicts {
  return {
    routes: new Map(
      [...standing.none].map(([record, verdict]) => [
        record,
        { topic: null, privateInput: false, verdict },
      ]),
    ),
    kinds: new Map(),
    vetoes: new Map<
      string,
      { readonly verdict: TopicVerdictBody; readonly veto: boolean; readonly members?: number }
    >([
      ...[...standing.approvals].map(([key, verdict]) => [key, { verdict, veto: false }] as const),
      ...[...standing.vetoes].map(([key, verdict]) => {
        const members = standing.vetoSizes.get(key);
        return [
          key,
          { verdict, veto: true, ...(members !== undefined ? { members } : {}) },
        ] as const;
      }),
    ]),
    wordings: new Map(),
    sameTopics: standing.same,
    resolutions: new Map(),
    completions: [],
    hidden: new Map(),
    kept: new Map(),
  };
}

/** The shared notes the history question is asked about. */
function historyNotes(
  shared: ReadonlyArray<StoreRecord>,
): Array<{ id: string; text: string; at: number }> {
  const judged = judgedHistoryNotes(shared);
  const notes: Array<{ id: string; text: string; at: number }> = [];
  for (const record of shared) {
    if (record.kind !== LOG_EVENT_KIND) continue;
    if (record.body["event_type"] !== "note") continue;
    if (judged.has(record.id)) continue;
    const payload = record.body["body"];
    const text =
      typeof payload === "object" && payload !== null
        ? (payload as Record<string, unknown>)["text"]
        : undefined;
    if (typeof text !== "string" || text === "") continue;
    // A verdict could only be shared (the pages read `shared`): a note with
    // a `<private>` region is not asked about.
    if (valueCarriesPrivateRegion(record.body)) continue;
    const stamp = record.body["timestamp"];
    const at =
      typeof stamp === "string" && Number.isFinite(Date.parse(stamp))
        ? Date.parse(stamp)
        : (parseHlc(record.hlc)?.physical ?? 0);
    notes.push({ id: record.id, text, at });
  }
  return notes;
}

/** What a question state holds that depends only on the planning read. */
type TopicQuestionBase = Pick<
  TopicQuestionState,
  "fold" | "candidates" | "byId" | "settings" | "notes"
>;

function topicQuestionBaseOf(read: ViewCatchUp): TopicQuestionBase {
  const privateIds = new Set(partitionRecords(read, "private").map((r) => r.id));
  const records = [...read.records.values()].flat();
  const fold = foldTopics(records, { privateIds });
  const shared = partitionRecords(read, "shared");
  const settingsFold = foldSettings(shared);
  const candidates = topicCandidates(records, privateIds, decisionTitlesOfCatchUp(read));
  const settings: PlanSettings = {
    minRecords: settingValue(settingsFold, SETTING_TOPIC_MIN_RECORDS) as number,
    minSessions: settingValue(settingsFold, SETTING_TOPIC_MIN_SESSIONS) as number,
    quietDays: settingValue(settingsFold, SETTING_TOPIC_QUIET_DAYS) as number,
  };
  return {
    fold,
    candidates,
    byId: new Map(candidates.map((c) => [c.id, c])),
    settings,
    notes: historyNotes(shared),
  };
}

/**
 * The state of `base` at `nowMs` under `standing`. The plan is built on
 * first use: a question that does not read it (the history question)
 * never pays for it, and every reader sees the same plan.
 */
function topicQuestionStateFrom(
  base: TopicQuestionBase,
  nowMs: number,
  standingOf: () => StandingVerdicts,
  kept: { standing?: StandingVerdicts; plan?: TopicPlan } = {},
): TopicQuestionState {
  const standingNow = (): StandingVerdicts => (kept.standing ??= standingOf());
  return {
    ...base,
    nowMs,
    get standing(): StandingVerdicts {
      return standingNow();
    },
    get plan(): TopicPlan {
      kept.plan ??= planTopics(
        base.fold,
        base.candidates,
        base.settings,
        nowMs,
        standingAsVerdicts(standingNow()),
      );
      return kept.plan;
    },
  };
}

/**
 * How long a reader keeps a plan built while neither the planning inputs
 * nor what the queue finished changed. The plan's clock only decides
 * which topics went quiet (the review), which no question reads.
 */
export const TOPIC_PLAN_KEEP_MS = 60 * 60_000;

/** The question state of a planning read (`catchUpWhere(isTopicPlanningInput)`). */
export function topicQuestionStateOf(
  read: ViewCatchUp,
  nowMs: number,
  standing: StandingVerdicts,
): TopicQuestionState {
  return topicQuestionStateFrom(topicQuestionBaseOf(read), nowMs, () => standing);
}

/** Whether a planning read is complete: no unreadable shard, no pending body. */
function completeRead(read: ViewCatchUp): boolean {
  return (
    read.unreadable.length === 0 &&
    ![...(read.pendingKinds?.values() ?? [])].some((kinds) => [...kinds.values()].some(Boolean))
  );
}

/**
 * The question state of one store for a reader that asks again and again
 * (a dream session's server rechecks an item's input on every take and
 * answer): the planning inputs are read through kept tails
 * (`catchUpWhereKept`), so only what was appended since the last read is
 * parsed, and the part of the state built from them alone is kept while
 * nothing new was read. The standing verdicts and the plan are kept
 * while the queue's applied and owner records stay the same (and for at
 * most {@link TOPIC_PLAN_KEEP_MS}), so they are always current. It answers what
 * {@link readTopicQuestionState} answers for the same store.
 */
export class TopicQuestionReader {
  readonly #store: StoreHandle;
  readonly #reads: DreamWorkReads | undefined;
  readonly #tails: CatchUpTails = new Map();
  #base: TopicQuestionBase | null = null;
  #read: ViewCatchUp | undefined;
  /**
   * The standing verdicts and the plan built over `base` while the
   * queue's finished items read as `key`: a session rechecks the input of
   * every item it takes and answers, and building the plan of a large
   * brain takes seconds, so it is built once until something it is built
   * from changes.
   */
  #kept: {
    readonly base: TopicQuestionBase;
    readonly key: string;
    standing?: StandingVerdicts;
    plan?: TopicPlan;
  } | null = null;

  /** `reads`: the caller's, so the queue fold of each read reads incrementally too. */
  constructor(store: StoreHandle, reads?: DreamWorkReads) {
    this.#store = store;
    this.#reads = reads;
  }

  read(nowMs: number): TopicQuestionState | null {
    const { read, fresh } = catchUpWhereKept(
      this.#store,
      isTopicPlanningInput,
      this.#tails,
      () => nowMs,
      this.#base === null ? undefined : this.#read,
    );
    this.#read = read;
    if (!completeRead(read)) {
      this.#base = null;
      return null;
    }
    // The queue is read now (an incomplete read leaves the state
    // unavailable, as a fresh read does) and folded only when a question
    // reads the standing verdicts: the history question never does.
    const queue = readDreamWorkLater(this.#store, { now: nowMs, reads: this.#reads });
    if (queue.unreadable.length > 0) {
      // The planning read is kept, but the base is not built from it: the
      // next read starts afresh, as after an incomplete planning read, so
      // the base never stays one read behind what was read.
      this.#base = null;
      return null;
    }
    if (fresh || this.#base === null) this.#base = topicQuestionBaseOf(read);
    const key = `${queue.finishedKey}/${Math.floor(nowMs / TOPIC_PLAN_KEEP_MS)}`;
    if (this.#kept?.base !== this.#base || this.#kept.key !== key) {
      this.#kept = { base: this.#base, key };
    }
    return topicQuestionStateFrom(
      this.#base,
      nowMs,
      () => standingVerdicts(queue.fold()),
      this.#kept,
    );
  }
}

/** The memo key of a store's {@link TopicQuestionReader} in a queue's reads. */
function questionReaderKey(store: StoreHandle): string {
  return `topic-questions:${store.root}:${store.device}`;
}

/**
 * The question state of `store` as this device holds it now, or `null`
 * when a shard could not be read in full (a question over a partial read
 * could be asked about a subject that is settled). With `reads` (what a
 * long-lived caller keeps between calls), through that caller's
 * {@link TopicQuestionReader}.
 */
export function readTopicQuestionState(
  store: StoreHandle,
  nowMs: number,
  reads?: DreamWorkReads,
): TopicQuestionState | null {
  if (reads !== undefined) {
    return reads
      .memo(questionReaderKey(store), () => new TopicQuestionReader(store, reads))
      .read(nowMs);
  }
  const read = catchUpWhere(store, isTopicPlanningInput, () => nowMs);
  if (!completeRead(read)) return null;
  const queue = readDreamWork(store, { now: nowMs });
  if (queue.unreadable.length > 0) return null;
  return topicQuestionStateOf(read, nowMs, standingVerdicts(queue));
}

// ----- Building the questions -----------------------------------------------------

/** A question about one subject: what its item is made of. */
export interface ClosedQuestion {
  readonly operation: ClosedOperation;
  readonly subject: string;
  /** Sorts the queue: the UTC day and id of the subject's own record. */
  readonly occurrence: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly options?: ReadonlyArray<string>;
  readonly private: boolean;
  readonly resources: ReadonlyArray<string>;
  readonly evidence: ReadonlyArray<string>;
}

function occurrenceOf(at: number, id: string): string {
  const day = Number.isFinite(at) ? new Date(at).toISOString().slice(0, 10) : "0000-00-00";
  return `${day}/${id}`;
}

interface Head {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly goal: string;
}

function headOf(topic: TopicState): Head {
  return {
    id: topic.id,
    title: topic.title,
    description: topic.description ?? "",
    goal: topic.goal ?? "",
  };
}

/** Whether a topic's head brings a private input into a question. */
function headIsPrivate(topic: TopicState): boolean {
  return (
    topic.private ||
    topic.privateFields.title ||
    topic.privateFields.description ||
    topic.privateFields.goal ||
    textCarriesPrivateRegion(topic.title) ||
    textCarriesPrivateRegion(topic.description ?? "") ||
    textCarriesPrivateRegion(topic.goal ?? "")
  );
}

/** The canonical topic that holds `candidate`, or `null`. */
function holderOf(fold: TopicFold, candidate: TopicCandidate): string | null {
  const assigned = fold.assignments.get(candidate.id);
  if (assigned !== undefined) return assigned;
  return candidate.topic === null ? null : (fold.canonical(candidate.topic) ?? null);
}

function routeQuestions(state: TopicQuestionState): ClosedQuestion[] {
  const out: ClosedQuestion[] = [];
  for (const ask of state.plan.asks.routes) {
    const candidate = state.byId.get(ask.record);
    if (candidate === undefined) continue;
    const topics = ask.topics
      .slice(0, TOPIC_DECISION_LIMITS.topicOptionsPerQuestion)
      .map((id) => state.fold.topics.get(id)!)
      .filter((t) => t !== undefined);
    if (topics.length === 0) continue;
    out.push({
      operation: "topic-route",
      subject: candidate.id,
      occurrence: occurrenceOf(candidate.at, candidate.id),
      input: { text: candidate.text, topics: topics.map(headOf) },
      options: [...topics.map((t) => t.id), "none"],
      private: candidate.private || topics.some(headIsPrivate),
      resources: [`record:${candidate.id}`],
      evidence: [candidate.id],
    });
  }
  return out;
}

function newQuestions(state: TopicQuestionState): ClosedQuestion[] {
  return state.plan.asks.groups.map((group) => {
    const members = group.members.map((id) => state.byId.get(id)!).filter((m) => m !== undefined);
    const oldest = members.reduce((x, y) => (y.at < x.at ? y : x), members[0]!);
    return {
      operation: "topic-new" as const,
      subject: group.key,
      occurrence: occurrenceOf(oldest.at, oldest.id),
      input: { title: group.title, members: members.map((m) => ({ id: m.id, text: m.text })) },
      private: group.private,
      resources: [],
      evidence: members.map((m) => m.id).slice(0, TOPIC_DECISION_LIMITS.groupMembersShown),
    };
  });
}

function sameQuestions(state: TopicQuestionState): ClosedQuestion[] {
  const pairs = topicPairsForSame(
    state.fold,
    TOPIC_SAME_QUESTIONS.pairJaccard,
    Number.POSITIVE_INFINITY,
  );
  return pairs.map((pair) => {
    const a = state.fold.topics.get(pair.a)!;
    const b = state.fold.topics.get(pair.b)!;
    const younger = a.createdAt > b.createdAt ? a : b;
    return {
      operation: "topic-same" as const,
      subject: `${pair.a}..${pair.b}`,
      occurrence: occurrenceOf(younger.createdAt, younger.id),
      input: { a: headOf(a), b: headOf(b) },
      options: [...TOPIC_SAME_QUESTIONS.options],
      private: headIsPrivate(a) || headIsPrivate(b),
      resources: [],
      evidence: [pair.a, pair.b],
    };
  });
}

/** Whether the topic carries (or carried until a split) the derived item of `recordId`. */
function hasDerivedItem(fold: TopicFold, topicId: string, recordId: string): boolean {
  return (
    (fold.topics.get(topicId)?.items.some((item) => item.id === recordId) ?? false) ||
    fold.movedAway(topicId, recordId)
  );
}

function kindQuestions(state: TopicQuestionState): ClosedQuestion[] {
  const out: ClosedQuestion[] = [];
  for (const candidate of state.candidates) {
    const topicId = holderOf(state.fold, candidate);
    if (topicId === null) continue;
    const topic = state.fold.topics.get(topicId);
    if (topic === undefined || topic.mergedInto !== null) continue;
    if (hasDerivedItem(state.fold, topicId, candidate.id)) continue;
    out.push({
      operation: "event-kind",
      subject: candidate.id,
      occurrence: occurrenceOf(candidate.at, candidate.id),
      input: { text: candidate.text, topic: topicId, title: topic.title },
      options: [...EVENT_KIND_OPTIONS],
      private:
        candidate.private ||
        topic.private ||
        topic.privateFields.title ||
        textCarriesPrivateRegion(topic.title),
      resources: [`record:${candidate.id}`],
      evidence: [candidate.id],
    });
  }
  return out;
}

/** An item of a topic by owner and id (a merged topic can show two items with one id). */
export function ownedItemKey(item: { readonly owner: string; readonly id: string }): string {
  return `${item.owner}/${item.id}`;
}

function resolvedQuestions(state: TopicQuestionState): ClosedQuestion[] {
  const out: ClosedQuestion[] = [];
  for (const candidate of state.candidates) {
    const topicId = holderOf(state.fold, candidate);
    if (topicId === null) continue;
    const topic = state.fold.topics.get(topicId);
    if (topic === undefined || topic.mergedInto !== null) continue;
    const questions = topic.items
      .filter(
        (item) =>
          item.kind === "open-question" &&
          item.resolved === undefined &&
          item.resolveProposed === undefined &&
          item.createdAt < candidate.at,
      )
      .toSorted((x, y) => x.createdAt - y.createdAt)
      .slice(0, TOPIC_DECISION_LIMITS.topicOptionsPerQuestion);
    if (questions.length === 0) continue;
    out.push({
      operation: "question-resolved",
      subject: candidate.id,
      occurrence: occurrenceOf(candidate.at, candidate.id),
      input: {
        text: candidate.text,
        topic: topicId,
        title: topic.title,
        questions: questions.map((q) => ({ key: ownedItemKey(q), text: q.text })),
      },
      options: [...questions.map(ownedItemKey), "none"],
      private:
        candidate.private ||
        topic.private ||
        topic.privateFields.title ||
        textCarriesPrivateRegion(topic.title) ||
        questions.some((q) => q.private || textCarriesPrivateRegion(q.text)),
      resources: [],
      evidence: [candidate.id],
    });
  }
  return out;
}

/** Held records shown beside a milestone, newest first. */
const MILESTONE_RECORDS_SHOWN = 5;

function milestoneQuestions(state: TopicQuestionState): ClosedQuestion[] {
  const out: ClosedQuestion[] = [];
  for (const topicId of [...state.fold.topics.keys()].toSorted()) {
    const topic = state.fold.topics.get(topicId)!;
    if (topic.mergedInto !== null) continue;
    const milestones = topic.items.filter(
      (item) =>
        item.kind === "milestone" && item.done === undefined && item.doneProposed === undefined,
    );
    if (milestones.length === 0) continue;
    // Newest first, records dated after the read behind every present one.
    const future = (c: TopicCandidate): number => (c.at > state.nowMs ? 1 : 0);
    const members = state.candidates
      .filter((c) => holderOf(state.fold, c) === topicId)
      .toSorted((x, y) => future(x) - future(y) || y.at - x.at || (x.id < y.id ? 1 : -1));
    for (const milestone of milestones) {
      const shown = members
        .filter((c) => c.at > milestone.createdAt)
        .slice(0, MILESTONE_RECORDS_SHOWN);
      if (shown.length === 0) continue;
      out.push({
        operation: "milestone-done",
        subject: ownedItemKey(milestone),
        occurrence: occurrenceOf(milestone.createdAt, ownedItemKey(milestone)),
        input: {
          topic: topicId,
          milestone: milestone.text,
          records: shown.map((c) => ({ id: c.id, text: c.text })),
        },
        private:
          topic.private ||
          milestone.private ||
          textCarriesPrivateRegion(milestone.text) ||
          shown.some((c) => c.private),
        resources: [],
        evidence: shown.map((c) => c.id),
      });
    }
  }
  return out;
}

function historyQuestions(state: TopicQuestionState): ClosedQuestion[] {
  return state.notes.map((note) => ({
    operation: "human-readable" as const,
    subject: note.id,
    occurrence: occurrenceOf(note.at, note.id),
    input: { text: note.text },
    private: false,
    resources: [],
    evidence: [note.id],
  }));
}

const BUILDERS: Readonly<Record<ClosedOperation, (state: TopicQuestionState) => ClosedQuestion[]>> =
  {
    "topic-route": routeQuestions,
    "topic-new": newQuestions,
    "topic-same": sameQuestions,
    "event-kind": kindQuestions,
    "question-resolved": resolvedQuestions,
    "milestone-done": milestoneQuestions,
    "human-readable": historyQuestions,
  };

/** Every closed question the state asks, in no particular order. */
export function closedQuestions(state: TopicQuestionState): ClosedQuestion[] {
  return CLOSED_OPERATIONS.flatMap((op) => BUILDERS[op](state));
}

/** The question about `subject` the state asks for `operation`, or `null` when none. */
export function closedQuestion(
  state: TopicQuestionState,
  operation: ClosedOperation,
  subject: string,
): ClosedQuestion | null {
  return BUILDERS[operation](state).find((q) => q.subject === subject) ?? null;
}

/** The hash of a question's input: an item's `input_hash`. */
export function closedInputHash(question: ClosedQuestion): string {
  return dreamWorkInputHash(question.input);
}

/** The produce spec of a question. */
export function closedProduceSpec(question: ClosedQuestion): ProduceSpec {
  const use = useOfOperation(question.operation)!;
  const sources: StorePartition[] = question.private ? ["private"] : ["shared"];
  return {
    operation: question.operation,
    subject: question.subject,
    occurrence: question.occurrence,
    input: question.input,
    prompt_version: String(TOPIC_USE_QUESTION_VERSION[use]),
    schema_version: "1",
    answer_schema:
      question.options !== undefined
        ? { type: "choice", options: [...question.options] }
        : { type: "probability" },
    after: [],
    resources: question.resources,
    evidence: question.evidence,
    payload: question.input,
    sources,
  };
}

// ----- Registration ------------------------------------------------------------------

/**
 * One question state per store and moment, so that a take that rereads
 * one item's input does not read the whole store twice in a row. Keyed by
 * the store root and the queue's own snapshot size is not enough to know
 * the store did not change, so the cache lives only for one call stack.
 */
function currentInput(operation: ClosedOperation) {
  return (item: DreamWorkItem, context: DreamWorkContext): DreamWorkInput | null => {
    const state = readTopicQuestionState(context.store, context.now, context.reads);
    if (state === null) return { unavailable: true, input_hash: item.body.input_hash };
    const question = closedQuestion(state, operation, item.body.subject);
    if (question === null) return null;
    return {
      input_hash: closedInputHash(question),
      partition: question.private ? "private" : "shared",
      payload: question.input,
      evidence: question.evidence,
    };
  };
}

// ----- The wording of a new topic ---------------------------------------------------

/**
 * The wording items the state asks for (change `dream-launched-agent`,
 * design D6): one per qualifying group, those that still wait for an
 * approval (after their `topic-new` item) and those approved and waiting
 * for their wording.
 */
export function wordingGroups(state: TopicQuestionState): WordingGroup[] {
  const asked = new Map(newQuestions(state).map((q) => [q.subject, q]));
  return [...state.plan.asks.groups, ...state.plan.asks.wordings].map((group) => {
    const members = group.members.map((id) => state.byId.get(id)!).filter((m) => m !== undefined);
    const oldest = members.reduce((x, y) => (y.at < x.at ? y : x), members[0]!);
    const question = asked.get(group.key);
    return {
      group,
      members: members.map((m) => ({ id: m.id, text: m.text })),
      occurrence: occurrenceOf(oldest.at, oldest.id),
      after: question === undefined ? null : itemIdOf(closedProduceSpec(question)),
    };
  });
}

registerDreamWorkOperation({
  name: TOPIC_WORDING_OPERATION,
  closedPredecessor: "release",
  appliedBy: "planning",
  text: true,
  validate: (answer) => wordingRejection(answer.value),
  currentInput(item: DreamWorkItem, context: DreamWorkContext): DreamWorkInput | null {
    const state = readTopicQuestionState(context.store, context.now, context.reads);
    if (state === null) return { input_hash: item.body.input_hash, partition: "private" };
    const entry = wordingGroups(state).find((g) => g.group.key === item.body.subject);
    if (entry === undefined) return null;
    return {
      input_hash: wordingInputHash(entry.members),
      partition: entry.group.private ? "private" : "shared",
      payload: { ...wordingInput(entry.members), prompt: TOPIC_WORDING_PROMPT },
      evidence: entry.members.map((m) => m.id).slice(0, 200),
    };
  },
  apply: () => {
    throw new Error(`${TOPIC_WORDING_OPERATION}: topic planning applies this answer`);
  },
});

for (const name of CLOSED_OPERATIONS) {
  registerDreamWorkOperation({
    name,
    closedPredecessor: "release",
    appliedBy: "planning",
    validate: (answer, item) => closedAnswerRejection(answer.value, item),
    currentInput: currentInput(name),
    apply: () => {
      throw new Error(`${name}: topic planning applies this answer`);
    },
  });
}
