/**
 * Test helper of the closed questions: produce the questions of a
 * fixture store, let the decision model executor answer them with an
 * injected fake provider, and plan topics on the fixture device.
 */
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
