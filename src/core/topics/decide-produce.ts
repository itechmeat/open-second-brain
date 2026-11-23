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
 */

import {
  dreamWorkItemBody,
  DreamQueueIncompleteSnapshotError,
  produceWorkBatch,
  readDreamWork,
  type DreamQueue,
  type ProduceSpec,
} from "../brain/dream-queue/queue.ts";
import { wordingProduceSpec } from "./wording-operation.ts";
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
  /** Items written by this run, per operation. */
  readonly asked: Readonly<Record<ClosedOperation, number>>;
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
  const wordings = new Map(wordingGroups(state).map((g) => [g.group.key, wordingProduceSpec(g)]));
  const questions = closedQuestions(state).toSorted(byOccurrence);
  const snapshot = readDreamWork(queue.store);
  if (snapshot.unreadable.length > 0) {
    throw new DreamQueueIncompleteSnapshotError(snapshot.unreadable);
  }
  const queued = snapshot.items;
  const pending = questions.filter(
    (question) => !queued.has(dreamWorkItemBody(closedProduceSpec(question)).id),
  );
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
  return { produced, existing, left: pending.length - done, asked };
}
