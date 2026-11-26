/**
 * Producing the closed questions (change `dream-closed-questions`, design
 * D3): every eligible subject of every operation gets an item, oldest
 * first, with no lookback window and no per-pass cap. What bounds a run
 * is its deadline; the subjects it did not reach are counted, and the
 * next run continues, since an item already queued for the same input is
 * skipped by identity.
 *
 * Items are written in chunks through `produceWorkBatch` (one gate, one
 * lock, one read of the queue per chunk); the deadline is checked before
 * each chunk.
 *
 * A subject is asked once at a time: while an item of the same operation
 * about it is still open (waiting, out on a lease, or answered and not yet
 * applied), no second item is produced for a changed input. The take
 * rechecks the open item's input and replaces it then, once, with the
 * input of that moment. Without this every new topic or reworded topic
 * re-asked every waiting routing question (on a real brain, 20,518 route
 * items for 4,569 records in one night, each one a full copy of the
 * question).
 */

import {
  closeDuplicateWork,
  dreamWorkItemBody,
  DreamQueueIncompleteSnapshotError,
  produceWorkBatch,
  readDreamWork,
  type DreamQueue,
  type ProduceSpec,
} from "../brain/dream-queue/queue.ts";
import type { DreamWorkStateName } from "../brain/dream-queue/constants.ts";
import { RELEASE_EGRESS_REFUSED, RELEASE_SHADOW } from "../brain/dream-queue/decision-executor.ts";
import type { DreamWorkItem } from "../brain/dream-queue/fold.ts";
import { TOPIC_WORDING_OPERATION, wordingProduceSpec } from "./wording-operation.ts";
import {
  CLOSED_OPERATIONS,
  closedProduceSpec,
  closedQuestions,
  type ClosedOperation,
  type ClosedQuestion,
  type TopicQuestionState,
  wordingGroups,
} from "./decide-operations.ts";

/** Items written per batch: the deadline is checked between batches. */
export const PRODUCE_CHUNK = 100;

export interface ProduceTopicQuestionsResult {
  /** Items written by this run. */
  readonly produced: number;
  /** Subjects whose item was already queued for the same input. */
  readonly existing: number;
  /** Subjects the run did not reach before its deadline. */
  readonly left: number;
  /** Open items an older build had asked again, closed as superseded. */
  readonly duplicates: number;
  /** Items written by this run, per operation. */
  readonly asked: Readonly<Record<ClosedOperation, number>>;
}

/** States of an item that still stands for its subject: asked and not settled. */
const OPEN_STATES: ReadonlySet<DreamWorkStateName> = new Set([
  "waiting",
  "leased",
  "accepted",
  "awaiting-review",
]);

/** Releases after which no taker offers the item again for the same input. */
const SET_ASIDE: ReadonlySet<string> = new Set([RELEASE_SHADOW, RELEASE_EGRESS_REFUSED]);

/** Whether no taker offers `item` again for its own input. */
function setAside(item: DreamWorkItem): boolean {
  const release = item.last_release;
  return (
    release !== null && release.input_hash === item.body.input_hash && SET_ASIDE.has(release.reason)
  );
}

/** A question of one version about one subject. */
function subjectKey(spec: {
  readonly operation: string;
  readonly subject: string;
  readonly prompt_version: string;
  readonly schema_version: string;
}): string {
  return [spec.operation, spec.subject, spec.prompt_version, spec.schema_version].join("\u0000");
}

/**
 * The open item of each question (operation, subject, version): the first
 * in the fold that still waits to be asked or applied. An item set aside
 * for its own input (asked in shadow, refused by egress) does not stand:
 * no taker offers it again until its input changes, so a changed input
 * needs its own item.
 */
function openItemsBySubject(items: Iterable<DreamWorkItem>): Map<string, string> {
  const open = new Map<string, string>();
  for (const item of items) {
    if (!OPEN_STATES.has(item.state) || setAside(item)) continue;
    const key = subjectKey(item.body);
    if (!open.has(key)) open.set(key, item.id);
  }
  return open;
}

function byOccurrence(x: ClosedQuestion, y: ClosedQuestion): number {
  if (x.occurrence !== y.occurrence) return x.occurrence < y.occurrence ? -1 : 1;
  if (x.operation !== y.operation) return x.operation < y.operation ? -1 : 1;
  return x.subject < y.subject ? -1 : x.subject > y.subject ? 1 : 0;
}

/**
 * Queue every closed question `state` asks, oldest first, until `until`
 * on `clock`.
 */
export function produceTopicQuestions(
  queue: DreamQueue,
  state: TopicQuestionState,
  options: { readonly until: number; readonly clock: () => number },
): ProduceTopicQuestionsResult {
  // Each qualifying group's wording item rides beside its `topic-new` item
  // (change `dream-launched-agent`, design D6): same occurrence, so both
  // land in one batch.
  // Questions an older build asked again are closed first, the newest of
  // each kept: the take rechecks that one.
  const duplicates = closeDuplicateWork(
    queue,
    new Set<string>([...CLOSED_OPERATIONS, TOPIC_WORDING_OPERATION]),
    setAside,
  );
  const snapshot = readDreamWork(queue.store);
  if (snapshot.unreadable.length > 0) {
    throw new DreamQueueIncompleteSnapshotError(snapshot.unreadable);
  }
  const queued = snapshot.items;
  const open = openItemsBySubject(snapshot.items.values());
  const wordings = new Map<string, ProduceSpec>();
  const questions = closedQuestions(state).toSorted(byOccurrence);
  const newQuestionOf = new Map(
    questions
      .filter((q) => q.operation === "topic-new")
      .map((q) => [q.subject, closedProduceSpec(q)]),
  );
  for (const entry of wordingGroups(state)) {
    const spec = wordingProduceSpec(entry);
    if (open.has(subjectKey(spec))) continue;
    // Its `topic-new` question is not asked again while an older one is
    // open: the wording comes after that one.
    const newQuestion = newQuestionOf.get(entry.group.key);
    const asked = newQuestion === undefined ? undefined : open.get(subjectKey(newQuestion));
    wordings.set(
      entry.group.key,
      entry.after !== null && asked !== undefined
        ? wordingProduceSpec({ ...entry, after: asked })
        : spec,
    );
  }
  const pending = questions.filter((question) => {
    const spec = closedProduceSpec(question);
    return !queued.has(dreamWorkItemBody(spec).id) && !open.has(subjectKey(spec));
  });
  const specsOf = (q: ClosedQuestion): ProduceSpec[] => {
    const spec = closedProduceSpec(q);
    if (q.operation !== "topic-new") return [spec];
    const wording = wordings.get(q.subject);
    wordings.delete(q.subject);
    return wording === undefined ? [spec] : [spec, wording];
  };
  const asked = Object.fromEntries(CLOSED_OPERATIONS.map((op) => [op, 0])) as Record<
    ClosedOperation,
    number
  >;
  let produced = 0;
  let existing = questions.length - pending.length;
  let done = 0;
  while (done < pending.length) {
    if (options.clock() >= options.until) break;
    const chunk = pending.slice(done, done + PRODUCE_CHUNK);
    const specs: Array<{ spec: ProduceSpec; operation: ClosedOperation | null }> = chunk.flatMap(
      (q) =>
        specsOf(q).map((spec) => ({
          spec,
          operation: spec.operation === q.operation ? q.operation : null,
        })),
    );
    // Approved groups whose wording waits (no `topic-new` question any more).
    if (done + chunk.length >= pending.length) {
      for (const spec of wordings.values()) specs.push({ spec, operation: null });
      wordings.clear();
    }
    const result = produceWorkBatch(
      queue,
      specs.map((s) => s.spec),
    );
    result.items.forEach((item, i) => {
      const operation = specs[i]!.operation;
      if (item.created) {
        produced += 1;
        if (operation !== null) asked[operation] += 1;
      } else existing += 1;
    });
    done += chunk.length;
  }
  if (pending.length === 0 && wordings.size > 0 && options.clock() < options.until) {
    const result = produceWorkBatch(queue, [...wordings.values()]);
    for (const item of result.items) {
      if (item.created) produced += 1;
      else existing += 1;
    }
  }
  return { produced, existing, left: pending.length - done, asked, duplicates };
}
