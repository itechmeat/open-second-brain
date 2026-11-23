/**
 * Test helper of the closed questions: produce the questions of a
 * fixture store, let the decision model executor answer them with an
 * injected fake provider, and plan topics on the fixture device.
 */
import { answerWork, takeWork } from "../../../../src/core/brain/dream-queue/queue.ts";
import { runDecisionExecutor } from "../../../../src/core/brain/dream-queue/decision-executor.ts";
import { readTopicQuestionState } from "../../../../src/core/topics/decide-operations.ts";
import { produceTopicQuestions } from "../../../../src/core/topics/decide-produce.ts";
import {
  runTopicPlanning,
  type TopicPlanningReport,
} from "../../../../src/core/topics/planning.ts";
import type { FakeDecisionProvider } from "../../../helpers/fake-decision-provider.ts";
import type { ClosedFixture } from "./closed-fixture.ts";

/** Produce every closed question and answer what the executor may, with `provider`. */
export async function ask(
  f: ClosedFixture,
  uses: string,
  provider: FakeDecisionProvider | undefined,
  extraEnv: Record<string, string | undefined> = {},
) {
  produceTopicQuestions(f.queue, readTopicQuestionState(f.a, f.still())!, {
    until: Number.POSITIVE_INFINITY,
    clock: f.still,
  });
  return runDecisionExecutor(f.queue, {
    until: Number.POSITIVE_INFINITY,
    clock: f.still,
    configPath: f.configPath,
    ...(provider !== undefined ? { provider } : {}),
    env: { ...f.env(uses), ...extraEnv },
  });
}

/** One topic planning pass on the fixture device. */
export function plan(f: ClosedFixture): TopicPlanningReport {
  return runTopicPlanning(f.a, { agent: "dream", now: f.now, configPath: f.configPath });
}

/**
 * Answer every ready `topic-wording` item as the launched agent would
 * (change `dream-launched-agent`): the title and goal given, with the
 * agent and model named. Returns how many were answered.
 */
export function word(
  f: ClosedFixture,
  wording: { title: string; goal: string } = { title: "Worded topic", goal: "The worded goal." },
  author: { agent: string; model: string } = { agent: "claude", model: "agent-model-1" },
): number {
  let answered = 0;
  for (;;) {
    const taken = takeWork(f.queue, {
      run: "word",
      filter: (item) => item.body.operation === "topic-wording",
    });
    if (taken.item === null) return answered;
    const result = answerWork(f.queue, {
      item: taken.item.id,
      generation: taken.item.generation,
      lease_token: taken.item.lease_token,
      value: { ...wording },
      ...author,
    });
    if (result.status === "accepted") answered += 1;
  }
}

/** Plan, word the approved groups, and plan again: the two passes a new topic takes. */
export function planAndWord(
  f: ClosedFixture,
  wording?: { title: string; goal: string },
): TopicPlanningReport {
  const first = plan(f);
  if (word(f, wording) === 0) return first;
  return plan(f);
}
