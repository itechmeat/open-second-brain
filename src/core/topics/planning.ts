/**
 * The topic-planning step of dream (design D9; task 3.4): only one device
 * runs it, under a device-local exclusive lock, so neither two machines
 * nor two processes on one create the same topic twice. On a brain with a
 * dream owner that device is the owner's (change `dream-closed-questions`,
 * design D2): every planning write is a judged write, and planning is
 * where the answers of the closed questions take effect. On a brain with
 * no owner bound it is the view writer's, and with no answer to apply it
 * creates and routes nothing.
 *
 * A pass:
 *
 *  1. reads the dream owner (else the view writer) records; any other
 *     machine stops here and its report names the device that plans
 *     (spec "Two machines run dream at once");
 *  2. takes the planning lock, then reads every partition this machine
 *     holds (and stops when a shard could not be read in full: a plan
 *     over a partial read could make a topic that already exists, or
 *     when that read names another view writer, or the pass's deadline
 *     passed while it waited for the lock);
 *  3. reads the dream work queue's fold, builds the verdicts of the
 *     accepted answers whose subject still matches this read and of the
 *     standing ones (a veto, a `none` route, a merge hint), plans
 *     (`plan.ts`) and appends, as `agent` records of its own agent: a
 *     `topic-create` per approved group with an `assign` per record, and
 *     an `assign` per answered route, then the item and proposal records
 *     of the other answers. A record lands in `private` when its topic is
 *     private or the record it assigns is; a private one on a machine
 *     without that partition is skipped and reported;
 *  4. marks every answer it applied as applied, with the ids written (or
 *     `abstained`, or the standing mark), and closes the answers whose
 *     subject changed.
 *
 * Every create and route is listed in the report with the command that
 * undoes it, also when a later write of the pass fails; the undo is a human `undo` record every machine honours.
 * Merges, splits and quiet topics are only listed. Reading inside the lock
 * is what makes a second pass see the first one's topics and assign
 * nothing twice.
 */

import { TOPIC_WORDING_OPERATION, wordingInputHash } from "./wording-operation.ts";
import { join } from "node:path";

import { readDeviceId, resolveAgentName } from "../config.ts";
import { shellWord } from "../shell-quote.ts";
import {
  appendedBeforeFailure,
  appendRecord,
  appendRecords,
  type AppendInput,
  type AppendResult,
} from "../store/appender.ts";
import {
  SETTING_TOPIC_MIN_RECORDS,
  SETTING_TOPIC_MIN_SESSIONS,
  SETTING_TOPIC_QUIET_DAYS,
  type StorePartition,
  type StoreStream,
} from "../store/constants.ts";
import { foldSettings, settingValue } from "../store/fold-settings.ts";
import { withLocalLock } from "../store/local-lock.ts";
import { inspectStore, openStore, type StoreHandle } from "../store/store-open.ts";
import { resolveConfiguredStoreRoot } from "../store/store-paths.ts";
import { newUlid } from "../store/ulid.ts";
import { catchUpSettings, catchUpWhere, partitionRecords } from "../view/catch-up.ts";
import { VIEW_STATE_DIR } from "../view/constants.ts";
import { foldViewWriter } from "../view/writer-fold.ts";
import { claimSeen, releaseIfRequested } from "../view/writer.ts";
import { resolveLockWaitBudgetMs } from "../brain/sync-lockfile.ts";
import { readStreamRecords } from "../store/read/stream-read.ts";
import { TOPIC_ASSIGN_KIND, TOPIC_CREATE_KIND, TOPIC_STREAM } from "./constants.ts";
import { recordTopicPlanOutcome } from "./plan-outcome.ts";
import { isTopicPlanningInput, topicCandidates } from "./candidates.ts";
import { decisionTitlesOfCatchUp } from "./decision-titles.ts";
import { topicBodyRejection } from "./records.ts";
import { foldTopics } from "./fold.ts";
import {
  planTopics,
  type MergeProposal,
  type PlanSettings,
  type TopicShortfall,
  type QuietPrompt,
  type SplitProposal,
} from "./plan.ts";
import {
  emptyTopicVerdicts,
  legacyTopicGroupKey,
  topicGroupKey,
  type TopicVerdictBody,
  type TopicVerdicts,
} from "./verdicts.ts";
import {
  judgedHistoryNotes,
  writeVerdictRecords,
  type VerdictWriteCounts,
} from "./verdict-writes.ts";
import { readDreamOwner } from "../brain/dream-owner/owner.ts";
import type { DreamWorkState } from "../brain/dream-queue/fold.ts";
import {
  dreamQueueOn,
  markAppliedByPlanning,
  readDreamWork,
  recheckAccepted,
  type DreamQueue,
} from "../brain/dream-queue/queue.ts";
import { BUILTIN_USE_THRESHOLDS } from "../decision-model/questions.ts";
import {
  ABSTAINED,
  closedInputHash,
  closedQuestion,
  isClosedOperation,
  NO_STANDING,
  STANDING_MARK,
  wordingGroups,
  THRESHOLD_NAME,
  standingAsVerdicts,
  standingVerdicts,
  topicQuestionStateOf,
  useOfOperation,
  verdictOfAnswer,
  type TopicQuestionState,
} from "./decide-operations.ts";

/** The command that undoes one automatic topic record. */
export const TOPIC_UNDO_COMMAND = "o2b topic undo";

/** Records one batched topic write appends at most (one write and fsync per shard each). */
const TOPIC_WRITE_BATCH = 1024;

/** Device-local lock target of the planning step. */
const PLAN_LOCK = "topic-plan";

export interface CreatedTopic {
  readonly topic: string;
  readonly title: string;
  readonly record: string;
  readonly members: number;
  readonly undo: string;
  /** Set when the model let the group through (`topic_new`, design D10). */
  readonly verdict?: TopicVerdictBody;
}

export interface RoutedRecord {
  readonly record: string;
  readonly topic: string;
  readonly assign: string;
  readonly undo: string;
  /** Set when a model verdict chose this route (`topic_route`, design D10). */
  readonly verdict?: TopicVerdictBody;
}

/** Where the closed questions are judged, as a pass reports it (design D2). */
export type TopicJudgment = "here" | "elsewhere" | "unbound";

export type TopicPlanningReport =
  | { readonly status: "no-writer" }
  /** A brain with a dream owner: only the owner's device plans topics. */
  | { readonly status: "not-owner"; readonly owner: string }
  | { readonly status: "not-writer"; readonly writer: string }
  | { readonly status: "released"; readonly to: string }
  | { readonly status: "waiting-for-claim" }
  | { readonly status: "raced" }
  | { readonly status: "incomplete-read"; readonly shards: ReadonlyArray<string> }
  /** The pass's deadline passed while it waited for the planning lock: nothing was written. */
  | { readonly status: "deferred" }
  | TopicPlanningError
  | {
      readonly status: "planned";
      /**
       * The records no topic holds that planning read (signals, notes,
       * decisions), and how many of them name no project (an attribute
       * only: such records group and route like any other).
       */
      readonly unheld: number;
      readonly unheldWithoutProject: number;
      /**
       * The same counts as a machine that holds only `shared` would read
       * them: the shared topics created, the shared records no topic holds
       * and how many of those name no project. A caller below local reach
       * is given these (`plan-outcome.ts`), never a count that includes a
       * private record.
       */
      readonly shared: {
        readonly created: number;
        readonly unheld: number;
        readonly unheldWithoutProject: number;
      };
      readonly created: ReadonlyArray<CreatedTopic>;
      readonly routed: ReadonlyArray<RoutedRecord>;
      readonly merges: ReadonlyArray<MergeProposal>;
      readonly splits: ReadonlyArray<SplitProposal>;
      readonly quiet: ReadonlyArray<QuietPrompt>;
      /**
       * Why the records no topic holds got no topic, when the pass made
       * none (`plan.ts`), with the thresholds the pass applied.
       */
      readonly shortfall: TopicShortfall | null;
      readonly thresholds: Pick<PlanSettings, "minRecords" | "minSessions">;
      /** Planned records skipped: private ones on a machine without `private`. */
      readonly skipped: number;
      /** Planned topics not created because their record would not be valid. */
      readonly invalid: number;
      /** Each of those: the scope it was planned for and why its record was refused. */
      readonly invalidCreates: ReadonlyArray<{ readonly scope: string; readonly reason: string }>;
      /** Item records derived from `event_kind` model verdicts (design D10). */
      readonly derived: number;
      /** `question-resolved` proposals from model verdicts. */
      readonly resolutions: number;
      /** `milestone-done` proposals from model verdicts. */
      readonly completions: number;
      /** `history-verdict` records that hide a note, from `human_readable` model verdicts. */
      readonly hidden: number;
      /** `history-verdict` records that keep a note, from `human_readable` model verdicts. */
      readonly kept: number;
      /** Accepted answers applied during this planning pass. */
      readonly applied: number;
      /** Answers applied that decided nothing (below their threshold). */
      readonly abstained: number;
      /** Answers not applied because their subject changed. */
      readonly stale: number;
      /** `here`: the owner's device judged; `unbound`: no owner, nothing decided. */
      readonly judgment: TopicJudgment;
    };

/**
 * A pass that failed. A write that failed after others landed keeps them
 * in `created` and `routed`, each with its undo command: they are in the
 * store, and the report must still name them.
 */
export interface TopicPlanningError {
  readonly status: "error";
  readonly error: string;
  readonly created: ReadonlyArray<CreatedTopic>;
  readonly routed: ReadonlyArray<RoutedRecord>;
  /** Item records derived from model verdicts before the failure. */
  readonly derived: number;
  /** `question-resolved` proposals written before the failure. */
  readonly resolutions: number;
  /** `milestone-done` proposals written before the failure. */
  readonly completions: number;
  /** `history-verdict` records that hide a note, written before the failure. */
  readonly hidden: number;
  /** `history-verdict` records that keep a note, written before the failure. */
  readonly kept: number;
  /** Accepted answers whose effects landed before this planning failure. */
  readonly applied: number;
}

export interface TopicPlanningOptions {
  readonly agent: string;
  /**
   * The dream work queue of a live pass that holds the pass lock on the
   * owner's device. Absent on the owner's device: the queue is opened
   * here, through the owner gate.
   */
  readonly queue?: DreamQueue;
  /** Wall clock (default `Date.now`). */
  readonly now?: () => number;
  /**
   * The config file the pass was run with, named in every undo command
   * it reports so the command acts on the same store.
   */
  readonly configPath?: string;
  /**
   * Asked under the planning lock, after the read and before the first
   * write: `false` writes nothing (`deferred`), so a pass whose deadline
   * passed while it waited for the lock leaves topics to the next one.
   */
  readonly mayPlan?: () => boolean;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

function undoOf(record: string, configPath: string | undefined): string {
  const config = configPath === undefined ? "" : ` --config ${shellWord(configPath)}`;
  return `${TOPIC_UNDO_COMMAND} ${record}${config}`;
}

/**
 * How long a pass waits for another pass's planning lock: longer than the
 * store's default, since the holder reads the whole store before it writes.
 */
const PLAN_LOCK_WAIT_MS = 30_000;

/** The device-local lock target of the planning step. */
export function topicPlanLockTarget(store: StoreHandle): string {
  return join(store.deviceStateDir, VIEW_STATE_DIR, PLAN_LOCK);
}

type WriterGate =
  | { readonly ok: true }
  | { readonly ok: false; readonly report: TopicPlanningReport };

/**
 * The render's writer protocol (design D7), for planning: only the view
 * writer plans; a writer whose role a request moves hands it over
 * instead; and a writer by its own fresh claim waits until the render
 * has settled the claim, so a rival claim with a lower clock has one
 * catch-up to arrive before this machine creates a topic.
 *
 * Exported for the decide pass (`decide.ts`), which refuses to decide
 * on anything but the view writer - the same gate, so one machine
 * decides and every machine folds the stored result (design D20).
 */
export function writerGate(store: StoreHandle, options: TopicPlanningOptions): WriterGate {
  const settings = catchUpSettings(store, options.now);
  if (settings === null) {
    return { ok: false, report: { status: "incomplete-read", shards: ["shared/settings"] } };
  }
  const state = foldViewWriter(settings);
  if (state.writer === null) return { ok: false, report: { status: "no-writer" } };
  if (state.writer !== store.device) {
    return { ok: false, report: { status: "not-writer", writer: state.writer } };
  }
  const to = releaseIfRequested(store, state, {
    agent: options.agent,
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
  if (to !== null) return { ok: false, report: { status: "released", to } };
  if (!claimSeen(store, state)) return { ok: false, report: { status: "waiting-for-claim" } };
  return { ok: true };
}

/**
 * The gate of a planning pass: on a brain with a dream owner only the
 * owner's device plans (with its queue); on a brain with none, the view
 * writer plans, with no queue (design D2).
 */
function planningGate(
  store: StoreHandle,
  options: TopicPlanningOptions,
):
  | { readonly ok: true; readonly queue: DreamQueue | null }
  | { readonly ok: false; readonly report: TopicPlanningReport } {
  const owner = readDreamOwner(store, options.now).owner;
  if (owner !== null) {
    if (owner.device !== store.device) {
      return { ok: false, report: { status: "not-owner", owner: owner.device } };
    }
    return {
      ok: true,
      queue:
        options.queue ??
        dreamQueueOn(store, {
          vault: null,
          writer: options.agent,
          ...(options.configPath !== undefined ? { configPath: options.configPath } : {}),
          ...(options.now !== undefined ? { now: options.now } : {}),
        }),
    };
  }
  const gate = writerGate(store, options);
  return gate.ok ? { ok: true, queue: null } : gate;
}

/** One planning pass on this machine. */
export function runTopicPlanning(
  store: StoreHandle,
  options: TopicPlanningOptions,
): TopicPlanningReport {
  const clock = options.now ?? Date.now;
  const before = planningGate(store, options);
  if (!before.ok) return before.report;
  const wait = Math.max(resolveLockWaitBudgetMs(), PLAN_LOCK_WAIT_MS);
  return withLocalLock(
    topicPlanLockTarget(store),
    () => {
      // Asked again under the lock: the role may have moved while this
      // pass waited, and no plan starts after a release.
      const under = planningGate(store, options);
      if (!under.ok) return under.report;
      return planUnderLock(store, options, clock, under.queue);
    },
    wait,
  );
}

/** The ids of every topic record this machine holds now: the fence a plan is written behind. */
function topicRecordIds(store: StoreHandle): string {
  const ids: string[] = [];
  for (const partition of store.partitions) {
    for (const record of readStreamRecords(store.root, partition, { stream: TOPIC_STREAM })
      .records) {
      ids.push(record.id);
    }
  }
  return ids.toSorted().join(",");
}

function planUnderLock(
  store: StoreHandle,
  options: TopicPlanningOptions,
  clock: () => number,
  queue: DreamQueue | null,
): TopicPlanningReport {
  const fence = topicRecordIds(store);
  // Only what planning folds is kept (`isTopicPlanningInput`): a migrated
  // store's log is mostly events no topic is made of.
  const read = catchUpWhere(store, isTopicPlanningInput, options.now);
  const pending = [...(read.pendingKinds?.entries() ?? [])].flatMap(([partition, kinds]) =>
    [...kinds].flatMap(([kind, count]) =>
      count > 0 ? [`pending ${partition}/${kind}:${count}`] : [],
    ),
  );
  if (read.unreadable.length > 0 || pending.length > 0) {
    return {
      status: "incomplete-read",
      shards: [...read.unreadable.map((s) => s.path), ...pending],
    };
  }
  if (queue === null) {
    // The writer as this read reports it: a move that arrived after the gate
    // above read the settings still stops the pass before it plans.
    const writer = foldViewWriter(partitionRecords(read, "shared")).writer;
    if (writer === null) return { status: "no-writer" };
    if (writer !== store.device) return { status: "not-writer", writer };
  }
  // The queue's fold, read under the planning lock: the answers to apply
  // and the verdicts that stand (design D2).
  const work = queue === null ? null : readDreamWork(store, { now: clock() });
  if (work !== null && work.unreadable.length > 0) {
    return { status: "incomplete-read", shards: work.unreadable };
  }
  const question = topicQuestionStateOf(
    read,
    clock(),
    work === null ? NO_STANDING : standingVerdicts(work),
  );
  const { fold, candidates, settings } = question;
  const answers = work === null ? null : acceptedAnswers(work, question);
  const verdicts = mergeVerdicts(standingAsVerdicts(question.standing), answers?.verdicts);
  const plan = planTopics(fold, candidates, settings, clock(), verdicts);
  /** Ids written per answered subject (`<operation>:<subject>`). */
  const written = new Map<string, string[]>();
  const wrote = (key: string, id: string): void => {
    const list = written.get(key) ?? [];
    list.push(id);
    written.set(key, list);
  };
  // A lock taken over from a holder that looked stale (a paused process)
  // lets two passes plan at once: a pass whose topic records changed since
  // it read them writes nothing, and the next pass plans again.
  if (topicRecordIds(store) !== fence) return { status: "raced" };
  if (options.mayPlan !== undefined && !options.mayPlan()) return { status: "deferred" };
  let skipped = 0;
  let invalid = 0;
  const invalidCreates: Array<{ scope: string; reason: string }> = [];
  // Grown as each verdict record lands, so a failed write still reports them.
  const verdictCounts: VerdictWriteCounts = {
    derived: 0,
    resolutions: 0,
    completions: 0,
    hidden: 0,
    kept: 0,
  };
  const append = (
    isPrivate: boolean,
    kind: string,
    topic: string | null,
    body: Record<string, unknown>,
    scope: string | null = null,
    stream: StoreStream = TOPIC_STREAM,
  ): string | null => {
    const partition: StorePartition = isPrivate ? "private" : "shared";
    if (!store.partitions.has(partition)) {
      skipped += 1;
      return null;
    }
    return appendRecord(
      store,
      {
        partition,
        stream,
        kind,
        agent: options.agent,
        scope,
        topic,
        body: { authority: "agent", ...body },
      },
      options.now !== undefined ? { now: options.now } : {},
    ).record.id;
  };
  /**
   * Several records of one kind in one batch (`appendRecords`): one clock
   * tick and one write and fsync per shard instead of one per record, so a
   * topic of thousands of members created from a migrated history does not
   * cost thousands of synced writes. A record whose partition this machine
   * does not hold is skipped and counted, as {@link append} skips it;
   * `landed` hears each record written (its entry's index and record id),
   * one batch at a time.
   */
  const appendMany = (
    entries: ReadonlyArray<{
      readonly isPrivate: boolean;
      readonly topic: string;
      readonly body: Record<string, unknown>;
    }>,
    kind: string,
    landed: (index: number, id: string) => void,
  ): void => {
    const held: number[] = [];
    const inputs: AppendInput[] = [];
    entries.forEach((entry, i) => {
      const partition: StorePartition = entry.isPrivate ? "private" : "shared";
      if (!store.partitions.has(partition)) {
        skipped += 1;
        return;
      }
      held.push(i);
      inputs.push({
        partition,
        stream: TOPIC_STREAM,
        kind,
        agent: options.agent,
        scope: null,
        topic: entry.topic,
        body: { authority: "agent", ...entry.body },
      });
    });
    for (let start = 0; start < inputs.length; start += TOPIC_WRITE_BATCH) {
      let results: ReadonlyArray<AppendResult | undefined>;
      let failure: { readonly error: unknown } | null = null;
      try {
        results = appendRecords(
          store,
          inputs.slice(start, start + TOPIC_WRITE_BATCH),
          options.now !== undefined ? { now: options.now } : {},
        );
      } catch (error) {
        results = appendedBeforeFailure(error) ?? [];
        failure = { error };
      }
      // Reported batch by batch, so a later batch that fails leaves the
      // records of the earlier ones in the report, with their undo, and
      // those its own failed append wrote before it threw.
      results.forEach((result, j) => {
        if (result !== undefined) landed(held[start + j]!, result.record.id);
      });
      if (failure !== null) throw failure.error;
    }
  };
  const created: Array<Mutable<CreatedTopic>> = [];
  let createdShared = 0;
  const routed: RoutedRecord[] = [];
  // The owner gate ran before the reads above; a forced takeover takes no
  // lock, so the role is read again here, right before the first write.
  if (queue !== null) {
    const owner = readDreamOwner(store, options.now).owner;
    if (owner === null || owner.device !== store.device) {
      return { status: "not-owner", owner: owner?.device ?? "none" };
    }
  }
  try {
    writePlan();
  } catch (err) {
    // What landed before the failure stays listed, with its undo command.
    return {
      status: "error",
      error: errorText(err),
      created,
      routed,
      applied: 0,
      ...verdictCounts,
    };
  }
  if (queue !== null && answers !== null) {
    // Every answer this pass applied is marked, in one queue entry: the
    // ids written for it, its standing mark, or `abstained` (design D5).
    const marks = [
      ...answers.decided.map((d) => ({
        item: d.item,
        generation: d.generation,
        lease_token: d.lease_token,
        receipt: d.receipt,
        effects:
          d.mark === STANDING_MARK.approved
            ? (written.get(d.key) ?? [d.mark])
            : d.mark !== undefined
              ? [d.mark]
              : (written.get(d.key) ?? []),
      })),
      // A wording is applied with the create of its topic, never before.
      ...answers.wordings
        .filter((w) => written.has(w.key))
        .map((w) => ({ ...w, effects: written.get(w.key)! })),
      ...answers.abstained.map((entry) => ({ ...entry, effects: [ABSTAINED] })),
    ];
    try {
      markAppliedByPlanning(queue, marks);
      recheckAccepted(queue, answers.stale);
    } catch (err) {
      return {
        status: "error",
        error: errorText(err),
        created,
        routed,
        applied: marks.length,
        ...verdictCounts,
      };
    }
  }
  const unheld = candidates.filter(
    (c) => !fold.assignments.has(c.id) && (c.topic === null || fold.canonical(c.topic) === null),
  );
  // The counts a machine that holds only `shared` would compute: its fold
  // has no private topic record, so a shared record a private record
  // assigns (or whose topic is private) is unheld there.
  const sharedFold = foldTopics(partitionRecords(read, "shared"));
  const unheldShared = candidates.filter(
    (c) =>
      !c.private &&
      !sharedFold.assignments.has(c.id) &&
      (c.topic === null || sharedFold.canonical(c.topic) === null),
  );
  return {
    status: "planned",
    unheld: unheld.length,
    unheldWithoutProject: unheld.filter((c) => c.project === null).length,
    shared: {
      created: createdShared,
      unheld: unheldShared.length,
      unheldWithoutProject: unheldShared.filter((c) => c.project === null).length,
    },
    created,
    routed,
    merges: plan.merges,
    splits: plan.splits,
    quiet: plan.quiet,
    shortfall: plan.shortfall,
    thresholds: { minRecords: settings.minRecords, minSessions: settings.minSessions },
    skipped,
    invalid,
    invalidCreates,
    ...verdictCounts,
    applied:
      (answers?.decided.length ?? 0) +
      (answers?.abstained.length ?? 0) +
      (answers?.wordings.filter((wording) => written.has(wording.key)).length ?? 0),
    abstained: answers?.abstained.length ?? 0,
    stale: answers?.stale.length ?? 0,
    judgment: queue === null ? "unbound" : "here",
  };

  function writePlan(): void {
    for (const plannedTopic of plan.creates) {
      const topic = newUlid(clock());
      const body = {
        title: plannedTopic.title,
        scope: plannedTopic.scope,
        goal: plannedTopic.goal,
        ...(plannedTopic.author !== undefined ? { written_by: { ...plannedTopic.author } } : {}),
      };
      // Checked as the fold checks it: a create the fold would reject (a
      // scope too long for a record) is never written, nor are its assigns,
      // so its records stay free for a later pass.
      const rejected = topicBodyRejection(TOPIC_CREATE_KIND, topic, {
        authority: "agent",
        ...body,
      });
      if (rejected !== null) {
        invalid += 1;
        invalidCreates.push({ scope: plannedTopic.scope, reason: rejected });
        continue;
      }
      const record = append(
        plannedTopic.private,
        TOPIC_CREATE_KIND,
        topic,
        plannedTopic.verdict !== undefined ? { ...body, verdict: plannedTopic.verdict } : body,
        plannedTopic.scope,
      );
      if (record === null) continue;
      // Listed as soon as it lands; `members` counts the assigns written.
      const entry: Mutable<CreatedTopic> = {
        topic,
        title: plannedTopic.title,
        record,
        members: 0,
        undo: undoOf(record, options.configPath),
        ...(plannedTopic.verdict !== undefined ? { verdict: plannedTopic.verdict } : {}),
      };
      created.push(entry);
      wrote(`topic-new:${topicGroupKey(plannedTopic.members)}`, record);
      wrote(`topic-new:${legacyTopicGroupKey(plannedTopic.members)}`, record);
      if (!plannedTopic.private) createdShared += 1;
      appendMany(
        plannedTopic.members.map((member) => ({
          isPrivate: plannedTopic.private,
          topic,
          body: { record: member },
        })),
        TOPIC_ASSIGN_KIND,
        () => {
          entry.members += 1;
        },
      );
    }
    appendMany(
      plan.routes.map((route) => ({
        isPrivate: route.private,
        topic: route.topic,
        body:
          route.verdict !== undefined
            ? { authority: "model", record: route.record, verdict: route.verdict }
            : { record: route.record },
      })),
      TOPIC_ASSIGN_KIND,
      (i, assign) => {
        routed.push({ ...plan.routes[i]!, assign, undo: undoOf(assign, options.configPath) });
        wrote(`topic-route:${plan.routes[i]!.record}`, assign);
      },
    );
    // The item and proposal records the model verdicts decide (design
    // D10): behind the same fence, in the partition the subject or its
    // topic dictates, skipped and counted without that partition.
    writeVerdictRecords({
      append,
      fold,
      plan,
      candidatesById: new Map(candidates.map((c) => [c.id, c])),
      verdicts,
      counts: verdictCounts,
      judgedNotes: judgedHistoryNotes(partitionRecords(read, "shared")),
      landed: (operation, subject, id) => wrote(`${operation}:${subject}`, id),
    });
  }
}

/** The verdicts of the accepted answers, and how each item ends. */
interface AcceptedAnswers {
  readonly verdicts: TopicVerdicts;
  /** Answered items whose answer decides: their key (`<operation>:<subject>`) and standing mark. */
  readonly decided: ReadonlyArray<{
    readonly item: string;
    readonly generation: number;
    readonly lease_token: string;
    readonly receipt: string;
    readonly key: string;
    readonly mark?: string;
  }>;
  readonly abstained: ReadonlyArray<{
    readonly item: string;
    readonly generation: number;
    readonly lease_token: string;
    readonly receipt: string;
  }>;
  /** Wording items: marked applied only with the create their topic got. */
  readonly wordings: ReadonlyArray<{
    readonly item: string;
    readonly generation: number;
    readonly lease_token: string;
    readonly receipt: string;
    readonly key: string;
  }>;
  readonly stale: ReadonlyArray<string>;
}

type MutableVerdicts = {
  -readonly [K in keyof TopicVerdicts]: TopicVerdicts[K] extends ReadonlyMap<infer A, infer B>
    ? Map<A, B>
    : TopicVerdicts[K] extends ReadonlyArray<infer E>
      ? E[]
      : never;
};

/**
 * The accepted answers of the closed questions as verdicts (design D2,
 * D5): an answer whose subject no longer asks the same question is stale;
 * one below its use's threshold abstains.
 */
function acceptedAnswers(work: DreamWorkState, question: TopicQuestionState): AcceptedAnswers {
  const v = emptyTopicVerdicts() as unknown as MutableVerdicts;
  const decided: Array<{
    item: string;
    generation: number;
    lease_token: string;
    receipt: string;
    key: string;
    mark?: string;
  }> = [];
  const abstained: Array<{
    item: string;
    generation: number;
    lease_token: string;
    receipt: string;
  }> = [];
  const wordings: Array<{
    item: string;
    generation: number;
    lease_token: string;
    receipt: string;
    key: string;
  }> = [];
  const stale: string[] = [];
  for (const id of work.order) {
    const item = work.items.get(id)!;
    const op = item.body.operation;
    if (op === TOPIC_WORDING_OPERATION && item.state === "accepted" && item.answer !== null) {
      // The launched agent's wording (change `dream-launched-agent`, design
      // D6): applied when planning creates the group's topic, and only then.
      const entry = wordingGroups(question).find((g) => g.group.key === item.body.subject);
      if (entry === undefined || wordingInputHash(entry.members) !== item.body.input_hash) {
        stale.push(id);
        continue;
      }
      const value = item.answer.value as Record<string, unknown>;
      const accepted = {
        item: id,
        generation: item.answer.generation,
        lease_token: item.answer.lease_token,
        receipt: item.answer.receipt,
      };
      v.wordings.set(item.body.subject, {
        title: String(value["title"]).trim(),
        goal: String(value["goal"]).trim(),
        agent: item.answer.agent,
        model: item.answer.model,
        item: id,
      });
      wordings.push({ ...accepted, key: `topic-new:${item.body.subject}` });
      continue;
    }
    if (item.state !== "accepted" || item.answer === null || !isClosedOperation(op)) continue;
    const current = closedQuestion(question, op, item.body.subject);
    // A `topic-new` answer is about the group its leader leads (its
    // subject): records joining or leaving the group do not end it.
    if (
      current === null ||
      (op !== "topic-new" && closedInputHash(current) !== item.body.input_hash)
    ) {
      stale.push(id);
      continue;
    }
    const use = useOfOperation(op)!;
    const value = item.answer.value as Record<string, unknown>;
    const author = { provider: String(value["provider"]), model: String(value["model"]) };
    const builtin = (BUILTIN_USE_THRESHOLDS[use] as Record<string, number>)[THRESHOLD_NAME[op]]!;
    const threshold = typeof value["threshold"] === "number" ? value["threshold"] : builtin;
    const choice = typeof value["choice"] === "string" ? value["choice"] : null;
    const confidence = typeof value["confidence"] === "number" ? value["confidence"] : null;
    const p = typeof value["p"] === "number" ? value["p"] : null;
    const confident = confidence !== null && confidence >= threshold;
    const subject = item.body.subject;
    const key = `${op}:${subject}`;
    const accepted = {
      item: id,
      generation: item.answer.generation,
      lease_token: item.answer.lease_token,
      receipt: item.answer.receipt,
    };
    const input = current.input as Record<string, unknown>;
    switch (op) {
      case "topic-route":
        if (!confident || choice === null) break;
        v.routes.set(subject, {
          topic: choice === "none" ? null : choice,
          privateInput: current.private,
          verdict: verdictOfAnswer(use, author, confidence),
        });
        decided.push({
          ...accepted,
          key,
          ...(choice === "none" ? { mark: STANDING_MARK.none } : {}),
        });
        continue;
      case "topic-new": {
        if (p === null) break;
        const veto = p < threshold;
        const members = item.body.payload["members"];
        v.vetoes.set(subject, {
          verdict: verdictOfAnswer(use, author, p),
          veto,
          ...(Array.isArray(members) ? { members: members.length } : {}),
        });
        // An approval whose topic is not created this pass (its wording
        // waits) stands as `approved`.
        decided.push({
          ...accepted,
          key,
          mark: veto ? STANDING_MARK.veto : STANDING_MARK.approved,
        });
        continue;
      }
      case "topic-same": {
        if (!confident || choice === null) break;
        const [a, b] = subject.split("..") as [string, string];
        v.sameTopics.push({
          a,
          b,
          option: choice,
          verdict: verdictOfAnswer(use, author, confidence),
        });
        decided.push({ ...accepted, key, mark: choice });
        continue;
      }
      case "event-kind":
        if (!confident || choice === null || choice === "routine") break;
        v.kinds.set(subject, {
          kind: choice,
          topic: String(input["topic"]),
          privateInput: current.private,
          verdict: verdictOfAnswer(use, author, confidence),
        });
        decided.push({ ...accepted, key });
        continue;
      case "question-resolved": {
        if (!confident || choice === null || choice === "none") break;
        const slash = choice.indexOf("/");
        v.resolutions.set(subject, {
          topic: String(input["topic"]),
          owner: choice.slice(0, slash),
          question: choice.slice(slash + 1),
          privateInput: current.private,
          verdict: verdictOfAnswer(use, author, confidence),
        });
        decided.push({ ...accepted, key });
        continue;
      }
      case "milestone-done": {
        if (p === null || p < threshold) break;
        const slash = subject.indexOf("/");
        v.completions.push({
          topic: String(input["topic"]),
          owner: subject.slice(0, slash),
          milestone: subject.slice(slash + 1),
          privateInput: current.private,
          verdict: verdictOfAnswer(use, author, p),
        });
        decided.push({ ...accepted, key });
        continue;
      }
      case "human-readable":
        if (p === null) break;
        if (p < threshold) v.hidden.set(subject, verdictOfAnswer(use, author, p));
        else v.kept.set(subject, verdictOfAnswer(use, author, p));
        decided.push({ ...accepted, key });
        continue;
    }
    abstained.push(accepted);
  }
  return { verdicts: v as unknown as TopicVerdicts, decided, wordings, abstained, stale };
}

/** The standing verdicts with the accepted ones over them. */
function mergeVerdicts(
  standing: TopicVerdicts,
  accepted: TopicVerdicts | undefined,
): TopicVerdicts {
  if (accepted === undefined) return standing;
  const pairKey = (e: { a: string; b: string }): string => `${e.a}..${e.b}`;
  const answered = new Set(accepted.sameTopics.map(pairKey));
  return {
    routes: new Map([...standing.routes, ...accepted.routes]),
    kinds: accepted.kinds,
    vetoes: new Map([...standing.vetoes, ...accepted.vetoes]),
    wordings: accepted.wordings,
    sameTopics: [
      ...standing.sameTopics.filter((e) => !answered.has(pairKey(e))),
      ...accepted.sameTopics,
    ],
    resolutions: accepted.resolutions,
    completions: accepted.completions,
    hidden: accepted.hidden,
    kept: accepted.kept,
  };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * {@link runTopicPlanning} for the store and device the machine config
 * names, as the dream pass runs it: `null` when this machine uses no
 * store or has no device id. Fail-open: an error is returned, never thrown.
 */
export function runAutoTopicPlanning(
  options: {
    readonly configPath?: string;
    readonly now?: () => number;
    /** The dream work queue of the live pass on the owner's device. */
    readonly queue?: DreamQueue;
    /**
     * Asked once the store is known to be in use, right before planning:
     * `false` plans nothing and answers `null` (a dream pass past its
     * deadline). Asked again under the planning lock, before the first
     * write (`deferred`).
     */
    readonly mayPlan?: () => boolean;
  } = {},
): TopicPlanningReport | null {
  try {
    const { root } = resolveConfiguredStoreRoot(options.configPath);
    if (inspectStore(root) === null) return null;
    const device = readDeviceId(options.configPath);
    if (device === null) return null;
    if (options.mayPlan !== undefined && !options.mayPlan()) return null;
    const store = openStore({ root, device });
    const report = runTopicPlanning(store, {
      agent: resolveAgentName(options.configPath),
      ...(options.queue !== undefined ? { queue: options.queue } : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
      ...(options.configPath !== undefined ? { configPath: options.configPath } : {}),
      ...(options.mayPlan !== undefined ? { mayPlan: options.mayPlan } : {}),
    });
    if (report.status === "planned") {
      recordTopicPlanOutcome(store.deviceStateDir, {
        at: new Date(options.now?.() ?? Date.now()).toISOString(),
        created: report.created.length,
        unassigned: report.unheld,
        withoutProject: report.unheldWithoutProject,
        shared: {
          created: report.shared.created,
          unassigned: report.shared.unheld,
          withoutProject: report.shared.unheldWithoutProject,
        },
      });
    }
    return report;
  } catch (err) {
    return {
      status: "error",
      error: errorText(err),
      created: [],
      routed: [],
      derived: 0,
      resolutions: 0,
      completions: 0,
      hidden: 0,
      kept: 0,
      applied: 0,
    };
  }
}

/** One line for the dream report. */
export function describeTopicPlanning(
  report: NonNullable<ReturnType<typeof runAutoTopicPlanning>>,
): string {
  switch (report.status) {
    case "no-writer":
      return "no machine plans topics yet (no view writer)";
    case "not-owner":
      return `this machine plans no topics; topic judgment runs on the dream owner's device ${report.owner}`;
    case "not-writer":
      return `this machine plans no topics; the view writer is ${report.writer}`;
    case "incomplete-read":
      return "topics were not planned: some shards could not be read";
    case "released":
      return `topics were not planned: the view writer role moved to ${report.to}`;
    case "waiting-for-claim":
      return "this machine just took the view writer role; it plans topics from its next pass";
    case "raced":
      return "topics were not planned: another pass wrote topic records meanwhile";
    case "deferred":
      return "topics were not planned: the pass ran out of time while it waited for the planning lock";
    case "error":
      return describeError(report);
    case "planned":
      return (
        `${report.created.length} topic(s) created, ${report.routed.length} record(s) routed, ` +
        `${report.merges.length} merge and ${report.splits.length} split proposal(s)` +
        `${modelMergeNote(report.merges)}, ${report.quiet.length} quiet topic(s)` +
        decidedNote(report) +
        invalidNote(report) +
        shortfallNote(report)
      );
  }
}

/**
 * The topics the pass planned but did not create because the fold would
 * refuse their record (a project name too long for a topic scope): their
 * records stay free, so without this a pass that made nothing for that
 * reason would name no cause.
 */
function invalidNote(report: Extract<TopicPlanningReport, { status: "planned" }>): string {
  if (report.invalidCreates.length === 0) return "";
  const named = report.invalidCreates
    .slice(0, SHORTFALLS_NAMED)
    .map((c) => `${c.scope.slice(0, 80)}${c.scope.length > 80 ? "..." : ""} (${c.reason})`);
  const rest = report.invalidCreates.length - named.length;
  return (
    `; ${plural(report.invalidCreates.length, "planned topic was", "planned topics were")} not ` +
    `created because the topic record would be refused: ${named.join("; ")}` +
    (rest > 0 ? `; and ${rest} more` : "")
  );
}

/** Projects a pass that created nothing names, at most. */
const SHORTFALLS_NAMED = 3;

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "2 notes, 1 signal and 1 decision": the kinds a group holds. */
function kindsText(kinds: TopicShortfall["closest"]["kinds"]): string {
  const parts = [
    ...(kinds.note > 0 ? [plural(kinds.note, "note", "notes")] : []),
    ...(kinds.signal > 0 ? [plural(kinds.signal, "signal", "signals")] : []),
    ...(kinds.decision > 0 ? [plural(kinds.decision, "decision", "decisions")] : []),
  ];
  return parts.length <= 1
    ? parts.join("")
    : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

/** Why the records no topic holds got no topic. */
function shortfallText(
  s: TopicShortfall,
  thresholds: Pick<PlanSettings, "minRecords" | "minSessions">,
): string {
  const reasons: string[] = [];
  if (s.free > 0) {
    const { records, sessions, kinds } = s.closest;
    const more = [
      ...(records < thresholds.minRecords
        ? [plural(thresholds.minRecords - records, "more record", "more records")]
        : []),
      ...(sessions < thresholds.minSessions
        ? [plural(thresholds.minSessions - sessions, "more session", "more sessions")]
        : []),
    ];
    reasons.push(
      `of the ${plural(s.free, "record", "records")} no topic holds, the group of related records closest to a topic ` +
        `has ${plural(records, "record", "records")} (${kindsText(kinds)}) from ` +
        `${plural(sessions, "session", "sessions")}` +
        (more.length > 0
          ? `, ${more.join(" and ")} short of a topic, which needs ${thresholds.minRecords} records ` +
            `from ${thresholds.minSessions} sessions (topics.new_min_records, topics.new_min_sessions)`
          : ""),
    );
  }
  if (s.asked > 0) {
    reasons.push(
      `${plural(s.asked, "group that qualified waits", "groups that qualified wait")} for the ` +
        "dream agent's approval and wording",
    );
  }
  if (s.vetoed > 0) {
    reasons.push(
      `a decision model vetoed ${plural(s.vetoed, "group", "groups")} that qualified, for this pass`,
    );
  }
  if (s.heldBack > 0) {
    reasons.push(
      `${plural(s.heldBack, "record", "records")} a topic once held (an undone topic or assignment) ` +
        "are routed to a fitting topic but never grouped again",
    );
  }
  return reasons.join("; ");
}

/**
 * Why a pass that created nothing made no topic of the records no topic
 * holds: the group of related records closest to a topic, with how many
 * more records or sessions a topic needs, the groups a decision model
 * vetoed, and the records held back because a topic held them once.
 */
function shortfallNote(report: Extract<TopicPlanningReport, { status: "planned" }>): string {
  if (report.created.length > 0 || report.shortfall === null) return "";
  const text = shortfallText(report.shortfall, report.thresholds);
  return text === "" ? "" : `; no topic was made: ${text}`;
}

/** ", N decided by a decision model" when records of the pass carry a verdict (design D10). */
function decidedNote(
  report: Extract<TopicPlanningReport, { status: "planned" } | { status: "error" }>,
): string {
  const decided =
    report.routed.filter((r) => r.verdict !== undefined).length +
    report.created.filter((c) => c.verdict !== undefined).length +
    report.derived +
    report.resolutions +
    report.completions +
    report.hidden +
    report.kept;
  return decided > 0 ? `, ${decided} decided by a decision model` : "";
}

/** A failed pass: its error, and what landed before it. */
function describeError(report: Extract<TopicPlanningReport, { status: "error" }>): string {
  const done = report.created.length + report.routed.length;
  const landed =
    done > 0
      ? ` (${report.created.length} topic(s) created and ${report.routed.length} record(s) routed before it)`
      : "";
  return `topics could not be planned: ${report.error}${landed}${decidedNote(report)}`;
}

/** The model-judged merge proposals, with their confidence (design D10). */
function modelMergeNote(merges: ReadonlyArray<MergeProposal>): string {
  const judged = merges.filter((m) => m.verdict !== undefined);
  if (judged.length === 0) return "";
  return (
    ` (of which ${judged.length} judged by a decision model, confidence ` +
    judged.map((m) => m.verdict!.confidence.toFixed(2)).join(", ") +
    ")"
  );
}
