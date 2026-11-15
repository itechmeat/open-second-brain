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
import { appendRecord } from "../store/appender.ts";
import {
  SETTING_TOPIC_MIN_RECORDS,
  SETTING_TOPIC_MIN_SESSIONS,
  SETTING_TOPIC_QUIET_DAYS,
  type StorePartition,
} from "../store/constants.ts";
import { foldSettings, settingValue } from "../store/fold-settings.ts";
import { withLocalLock } from "../store/local-lock.ts";
import { inspectStore, openStore, type StoreHandle } from "../store/store-open.ts";
import { resolveConfiguredStoreRoot } from "../store/store-paths.ts";
import { newUlid } from "../store/ulid.ts";
import { catchUp, catchUpSettings, partitionRecords } from "../view/catch-up.ts";
import { VIEW_STATE_DIR } from "../view/constants.ts";
import { foldViewWriter } from "../view/writer-fold.ts";
import { claimSeen, releaseIfRequested } from "../view/writer.ts";
import { resolveLockWaitBudgetMs } from "../brain/sync-lockfile.ts";
import { readStreamRecords } from "../store/read/stream-read.ts";
import { TOPIC_ASSIGN_KIND, TOPIC_CREATE_KIND, TOPIC_STREAM } from "./constants.ts";
import { topicCandidates } from "./candidates.ts";
import { topicBodyRejection } from "./records.ts";
import { foldTopics } from "./fold.ts";
import { planTopics, type MergeProposal, type QuietPrompt, type SplitProposal } from "./plan.ts";

/** The command that undoes one automatic topic record. */
export const TOPIC_UNDO_COMMAND = "o2b topic undo";

/** Device-local lock target of the planning step. */
const PLAN_LOCK = "topic-plan";

export interface CreatedTopic {
  readonly topic: string;
  readonly title: string;
  readonly record: string;
  readonly members: number;
  readonly undo: string;
}

export interface RoutedRecord {
  readonly record: string;
  readonly topic: string;
  readonly assign: string;
  readonly undo: string;
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
      readonly created: ReadonlyArray<CreatedTopic>;
      readonly routed: ReadonlyArray<RoutedRecord>;
      readonly merges: ReadonlyArray<MergeProposal>;
      readonly splits: ReadonlyArray<SplitProposal>;
      readonly quiet: ReadonlyArray<QuietPrompt>;
      /** Planned records skipped: private ones on a machine without `private`. */
      readonly skipped: number;
      /** Planned topics not created because their record would not be valid. */
      readonly invalid: number;
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
}

export interface TopicPlanningOptions {
  readonly agent: string;
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

/** A word for a POSIX shell, single-quoted unless it needs no quoting. */
function shellWord(value: string): string {
  return /^[A-Za-z0-9_./:=@%+,-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

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
 */
function writerGate(store: StoreHandle, options: TopicPlanningOptions): WriterGate {
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
  const read = catchUp(store, options.now);
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
  const plan = planTopics(
    fold,
    topicCandidates(records, privateIds),
    {
      minRecords: settingValue(shared, SETTING_TOPIC_MIN_RECORDS) as number,
      minSessions: settingValue(shared, SETTING_TOPIC_MIN_SESSIONS) as number,
      quietDays: settingValue(shared, SETTING_TOPIC_QUIET_DAYS) as number,
    },
    clock(),
  );
  // A lock taken over from a holder that looked stale (a paused process)
  // lets two passes plan at once: a pass whose topic records changed since
  // it read them writes nothing, and the next pass plans again.
  if (topicRecordIds(store) !== fence) return { status: "raced" };
  if (options.mayPlan !== undefined && !options.mayPlan()) return { status: "deferred" };
  let skipped = 0;
  let invalid = 0;
  const append = (
    isPrivate: boolean,
    kind: string,
    topic: string,
    body: Record<string, unknown>,
    scope: string | null = null,
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
        stream: TOPIC_STREAM,
        kind,
        agent: options.agent,
        scope,
        topic,
        body: { authority: "agent", ...body },
      },
      options.now !== undefined ? { now: options.now } : {},
    ).record.id;
  };
  const created: Array<Mutable<CreatedTopic>> = [];
  const routed: RoutedRecord[] = [];
  try {
    writePlan();
  } catch (err) {
    // What landed before the failure stays listed, with its undo command.
    return { status: "error", error: errorText(err), created, routed };
  }
  return {
    status: "planned",
    created,
    routed,
    merges: plan.merges,
    splits: plan.splits,
    quiet: plan.quiet,
    skipped,
    invalid,
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
      if (topicBodyRejection(TOPIC_CREATE_KIND, topic, { authority: "agent", ...body }) !== null) {
        invalid += 1;
        continue;
      }
      const record = append(
        plannedTopic.private,
        TOPIC_CREATE_KIND,
        topic,
        body,
        plannedTopic.scope,
      );
      if (record === null) continue;
      // Listed as soon as it lands; `members` counts the assigns written.
      const entry = {
        topic,
        title: plannedTopic.title,
        record,
        members: 0,
        undo: undoOf(record, options.configPath),
      };
      created.push(entry);
      for (const member of plannedTopic.members) {
        if (append(plannedTopic.private, TOPIC_ASSIGN_KIND, topic, { record: member }) !== null) {
          entry.members += 1;
        }
      }
    }
    for (const route of plan.routes) {
      const assign = append(route.private, TOPIC_ASSIGN_KIND, route.topic, {
        record: route.record,
      });
      if (assign !== null)
        routed.push({ ...route, assign, undo: undoOf(assign, options.configPath) });
    }
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
    return runTopicPlanning(store, {
      agent: resolveAgentName(options.configPath),
      ...(options.now !== undefined ? { now: options.now } : {}),
      ...(options.configPath !== undefined ? { configPath: options.configPath } : {}),
      ...(options.mayPlan !== undefined ? { mayPlan: options.mayPlan } : {}),
    });
  } catch (err) {
    return { status: "error", error: errorText(err), created: [], routed: [] };
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
    case "error": {
      const done = report.created.length + report.routed.length;
      const landed =
        done > 0
          ? ` (${report.created.length} topic(s) created and ${report.routed.length} record(s) routed before it)`
          : "";
      return `topics could not be planned: ${report.error}${landed}`;
    }
    case "planned":
      return (
        `${report.created.length} topic(s) created, ${report.routed.length} record(s) routed, ` +
        `${report.merges.length} merge and ${report.splits.length} split proposal(s), ` +
        `${report.quiet.length} quiet topic(s)`
      );
  }
}
