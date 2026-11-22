/**
 * The topic-planning step of dream (design D9; task 3.4): only the view
 * writer runs it, under a device-local exclusive lock, so neither two
 * machines nor two processes on the writer create the same topic twice.
 *
 * A pass:
 *
 *  1. reads the view writer records; any other machine stops here and its
 *     report names the writer (spec "Two machines run dream at once");
 *  2. takes the planning lock, then reads every partition this machine
 *     holds (and stops when a shard could not be read in full: a plan
 *     over a partial read could make a topic that already exists, or
 *     when that read names another view writer, or the pass's deadline
 *     passed while it waited for the lock);
 *  3. plans (`plan.ts`) and appends, as `agent` records of its own agent:
 *     a `topic-create` per new topic with an `assign` per record, and an
 *     `assign` per route. A record lands in `private` when its topic is
 *     private or the record it assigns is; a private one on a machine
 *     without that partition is skipped and reported.
 *
 * Every create and route is listed in the report with the command that
 * undoes it, also when a later write of the pass fails; the undo is a human `undo` record every machine honours.
 * Merges, splits and quiet topics are only listed. Reading inside the lock
 * is what makes a second pass see the first one's topics and assign
 * nothing twice.
 */

import { join } from "node:path";

import { readDeviceId, resolveAgentName } from "../config.ts";
import { shellWord } from "../shell-quote.ts";
import { appendRecord, appendRecords, type AppendInput } from "../store/appender.ts";
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
  type ProjectShortfall,
  type QuietPrompt,
  type SplitProposal,
} from "./plan.ts";
import type { TopicVerdictBody, TopicVerdicts } from "./verdicts.ts";
import {
  judgedHistoryNotes,
  writeVerdictRecords,
  type VerdictWriteCounts,
} from "./verdict-writes.ts";

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

export type TopicPlanningReport =
  | { readonly status: "no-writer" }
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
       * decisions), and how many of them name no project: topics are made
       * only from the records of one project, so a history whose records
       * name none plans nothing, and the summary says why.
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
       * The projects whose records no topic holds that got no topic, and
       * why (`plan.ts`), with the thresholds the pass applied.
       */
      readonly shortfalls: ReadonlyArray<ProjectShortfall>;
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
}

export interface TopicPlanningOptions {
  readonly agent: string;
  /**
   * Model verdicts computed before the pass (design D10, D20): applied
   * only where their subject still matches the fold read under the
   * lock. Absent: the deterministic plan.
   */
  readonly topicVerdicts?: TopicVerdicts;
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

/** One planning pass on this machine. */
export function runTopicPlanning(
  store: StoreHandle,
  options: TopicPlanningOptions,
): TopicPlanningReport {
  const clock = options.now ?? Date.now;
  const before = writerGate(store, options);
  if (!before.ok) return before.report;
  const wait = Math.max(resolveLockWaitBudgetMs(), PLAN_LOCK_WAIT_MS);
  return withLocalLock(
    topicPlanLockTarget(store),
    () => {
      // Asked again under the lock: the role may have moved while this
      // pass waited, and no plan starts after a release.
      const under = writerGate(store, options);
      if (!under.ok) return under.report;
      return planUnderLock(store, options, clock);
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
): TopicPlanningReport {
  const fence = topicRecordIds(store);
  // Only what planning folds is kept (`isTopicPlanningInput`): a migrated
  // store's log is mostly events no topic is made of.
  const read = catchUpWhere(store, isTopicPlanningInput, options.now);
  if (read.unreadable.length > 0) {
    return { status: "incomplete-read", shards: read.unreadable.map((s) => s.path) };
  }
  // The writer as this read reports it: a move that arrived after the gate
  // above read the settings still stops the pass before it plans.
  const writer = foldViewWriter(partitionRecords(read, "shared")).writer;
  if (writer === null) return { status: "no-writer" };
  if (writer !== store.device) return { status: "not-writer", writer };
  const privateIds = new Set(partitionRecords(read, "private").map((r) => r.id));
  const records = [...read.records.values()].flat();
  const fold = foldTopics(records, { privateIds });
  const shared = foldSettings(partitionRecords(read, "shared"));
  // Decision page titles of this read: none when it missed a page version.
  const candidates = topicCandidates(records, privateIds, decisionTitlesOfCatchUp(read));
  const settings: PlanSettings = {
    minRecords: settingValue(shared, SETTING_TOPIC_MIN_RECORDS) as number,
    minSessions: settingValue(shared, SETTING_TOPIC_MIN_SESSIONS) as number,
    quietDays: settingValue(shared, SETTING_TOPIC_QUIET_DAYS) as number,
  };
  const plan = planTopics(fold, candidates, settings, clock(), options.topicVerdicts);
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
      const results = appendRecords(
        store,
        inputs.slice(start, start + TOPIC_WRITE_BATCH),
        options.now !== undefined ? { now: options.now } : {},
      );
      // Reported batch by batch, so a later batch that fails leaves the
      // records of the earlier ones in the report, with their undo.
      results.forEach((result, j) => landed(held[start + j]!, result.record.id));
    }
  };
  const created: Array<Mutable<CreatedTopic>> = [];
  let createdShared = 0;
  const routed: RoutedRecord[] = [];
  try {
    writePlan();
  } catch (err) {
    // What landed before the failure stays listed, with its undo command.
    return {
      status: "error",
      error: errorText(err),
      created,
      routed,
      ...verdictCounts,
    };
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
    shortfalls: plan.shortfalls,
    thresholds: { minRecords: settings.minRecords, minSessions: settings.minSessions },
    skipped,
    invalid,
    invalidCreates,
    ...verdictCounts,
  };

  function writePlan(): void {
    for (const plannedTopic of plan.creates) {
      const topic = newUlid(clock());
      const body = {
        title: plannedTopic.title,
        scope: plannedTopic.scope,
        goal: plannedTopic.goal,
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
      verdicts: options.topicVerdicts,
      counts: verdictCounts,
      judgedNotes: judgedHistoryNotes(partitionRecords(read, "shared")),
    });
  }
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
    /**
     * Model verdicts computed before the pass (design D10, D20);
     * `planTopics` applies them only where their subject still matches
     * the fold read under the lock. Absent: the deterministic plan.
     */
    readonly topicVerdicts?: TopicVerdicts;
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
      ...(options.topicVerdicts !== undefined ? { topicVerdicts: options.topicVerdicts } : {}),
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
        unscopedNote(report) +
        invalidNote(report) +
        shortfallNote(report)
      );
  }
}

/**
 * Why a pass that created nothing created nothing, when the reason is that
 * the records no topic holds name no project: planning makes a topic only
 * from the records of one project (a signal's or log event's `project`
 * field), and the notes and signals the tools write (and a migrated
 * history of them) carry none. Without this the summary read as if there
 * were nothing to plan. No decision model is involved: the deterministic
 * rule is the whole of it.
 */
function unscopedNote(report: Extract<TopicPlanningReport, { status: "planned" }>): string {
  if (report.created.length > 0 || report.unheldWithoutProject === 0) return "";
  const all = report.unheldWithoutProject === report.unheld;
  return (
    `; ${all ? "none" : `${report.unheld - report.unheldWithoutProject}`} of the ` +
    `${report.unheld} record(s) no topic holds name${all ? "s" : ""} a project, and a topic is ` +
    "made only from the records of one project (a personal topic only on request: o2b topic create)"
  );
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
function kindsText(kinds: ProjectShortfall["closest"]["kinds"]): string {
  const parts = [
    ...(kinds.note > 0 ? [plural(kinds.note, "note", "notes")] : []),
    ...(kinds.signal > 0 ? [plural(kinds.signal, "signal", "signals")] : []),
    ...(kinds.decision > 0 ? [plural(kinds.decision, "decision", "decisions")] : []),
  ];
  return parts.length <= 1
    ? parts.join("")
    : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

/** Why one project got no topic. */
function shortfallText(
  s: ProjectShortfall,
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
      `of its ${plural(s.free, "record", "records")} no topic holds, the group of related records closest to a topic ` +
        `has ${plural(records, "record", "records")} (${kindsText(kinds)}) from ` +
        `${plural(sessions, "session", "sessions")}` +
        (more.length > 0
          ? `, ${more.join(" and ")} short of a topic, which needs ${thresholds.minRecords} records ` +
            `from ${thresholds.minSessions} sessions (topics.new_min_records, topics.new_min_sessions)`
          : ""),
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
  return `project ${s.project}: ${reasons.join("; ")}`;
}

/**
 * Why a pass that created nothing made no topic of the projects whose
 * records no topic holds: per project (the most such records first), the
 * group of related records closest to a topic, with how many
 * more records or sessions a topic needs, the groups a decision model
 * vetoed, and the records held back because a topic held them once.
 */
function shortfallNote(report: Extract<TopicPlanningReport, { status: "planned" }>): string {
  if (report.created.length > 0 || report.shortfalls.length === 0) return "";
  const named = report.shortfalls.slice(0, SHORTFALLS_NAMED);
  const rest = report.shortfalls.length - named.length;
  return (
    `; no topic was made: ${named.map((s) => shortfallText(s, report.thresholds)).join("; ")}` +
    (rest > 0 ? `; and ${plural(rest, "more project", "more projects")}` : "")
  );
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
