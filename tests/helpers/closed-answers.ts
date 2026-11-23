/**
 * Test helper of the closed questions on the queue (change
 * `dream-closed-questions`): the answers a model would give, written
 * straight through the queue's entry points, for tests whose subject is
 * what planning does with a topic and not how the model was asked.
 *
 *  - {@link bindTestDreamOwner}: the store's device takes the dream owner
 *    role (planning and the queue run only there).
 *  - {@link answerClosedQuestions}: produce every closed question of the
 *    store and answer each item `decide` returns a value for; the default
 *    approves every qualifying group and routes every record to the
 *    best-ranked topic, which is what the fixed rule did before.
 */
import {
  claimDreamOwner,
  claimSettled,
  readDreamOwner,
} from "../../src/core/brain/dream-owner/owner.ts";
import {
  answerWork,
  dreamQueueOn,
  releaseWork,
  takeWork,
  type TakenItem,
} from "../../src/core/brain/dream-queue/queue.ts";
import { dream } from "../../src/core/brain/dream.ts";
import type { StoreHandle } from "../../src/core/store/store-open.ts";
import { readTopicQuestionState } from "../../src/core/topics/decide-operations.ts";
import { produceTopicQuestions } from "../../src/core/topics/decide-produce.ts";

/** The store's device holds the dream owner role, settled. */
export function bindTestDreamOwner(store: StoreHandle, now?: () => number): void {
  if (readDreamOwner(store, now).owner?.device === store.device) return;
  claimDreamOwner(store, "claude", {
    writer: "o2b",
    authority: "human",
    ...(now !== undefined ? { now } : {}),
  });
  claimSettled(store, readDreamOwner(store, now));
}

/** Approve every group and route every record to its first (best) option. */
export function approveTopics(item: TakenItem): Record<string, unknown> | null {
  if (item.operation === "topic-new") return { p: 1 };
  if (item.operation === "topic-route") {
    const options = item.answer_schema["options"] as string[];
    return { choice: options[0], confidence: 1 };
  }
  return null;
}

/**
 * Produce the closed questions of `store` and answer them with `decide`
 * (a value, or `null` to leave the item waiting). Returns how many items
 * were answered. Binds the dream owner first.
 */
export function answerClosedQuestions(
  store: StoreHandle,
  decide: (item: TakenItem) => Record<string, unknown> | null = approveTopics,
  options: { readonly now?: () => number } = {},
): number {
  bindTestDreamOwner(store, options.now);
  const now = options.now ?? Date.now;
  const queue = dreamQueueOn(store, { vault: null, writer: "test", now });
  const state = readTopicQuestionState(store, now());
  if (state === null) throw new Error("answerClosedQuestions: a shard could not be read");
  produceTopicQuestions(queue, state, { until: Number.POSITIVE_INFINITY, clock: now });
  let answered = 0;
  const skipped = new Set<string>();
  for (;;) {
    const taken = takeWork(queue, { run: "test", filter: (item) => !skipped.has(item.id) });
    if (taken.item === null) return answered;
    const lease = {
      item: taken.item.id,
      generation: taken.item.generation,
      lease_token: taken.item.lease_token,
    };
    const value = decide(taken.item);
    if (value === null) {
      releaseWork(queue, lease);
      skipped.add(taken.item.id);
      continue;
    }
    const result = answerWork(queue, {
      ...lease,
      value: { provider: "test", model: "test-model", ...value },
      agent: "test",
      model: "test-model",
    });
    if (result.status === "accepted") answered += 1;
  }
}

/**
 * A synchronous `dream` pass on `vault` whose closed questions were first
 * produced and answered with `decide` on `store` (the dream owner's
 * device), as a live pass's front door has them answered before the pass.
 */
export function dreamAnswered(
  vault: string,
  store: StoreHandle,
  decide: (item: TakenItem) => Record<string, unknown> | null = approveTopics,
): ReturnType<typeof dream> {
  answerClosedQuestions(store, decide);
  return dream(vault);
}
