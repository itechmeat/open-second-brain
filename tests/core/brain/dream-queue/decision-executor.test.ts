/**
 * The decision model chain as an executor of the closed questions
 * (change `dream-closed-questions`, design D4; spec "The decision model
 * chain answers queue items", "Modes per use keep their meaning for
 * queue items", task 4.1). The provider is the injected fake: nothing
 * reaches a network.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { writeFileSync } from "node:fs";

import { runDecisionExecutor } from "../../../../src/core/brain/dream-queue/decision-executor.ts";
import * as dreamOperations from "../../../../src/core/brain/dream-queue/operations.ts";
import {
  emitDecisionModelCall,
  listDecisionModelCalls,
} from "../../../../src/core/decision-model/record.ts";
import {
  decisionThresholdsPath,
  resetThresholdsStoreCache,
  writeThresholdEntry,
} from "../../../../src/core/decision-model/thresholds.ts";
import { readTopicQuestionState } from "../../../../src/core/topics/decide-operations.ts";
import { produceTopicQuestions } from "../../../../src/core/topics/decide-produce.ts";
import { FakeDecisionProvider } from "../../../helpers/fake-decision-provider.ts";
import { startFakeSystemOne } from "../../../helpers/fake-decision-provider.ts";
import { closedFixture, type ClosedFixture } from "../../topics/fixtures/closed-fixture.ts";

let f: ClosedFixture;

beforeEach(() => {
  f = closedFixture();
});

afterEach(() => {
  f.cleanup();
});

function produce(): void {
  produceTopicQuestions(f.queue, readTopicQuestionState(f.a, f.still())!, {
    until: Number.POSITIVE_INFINITY,
    clock: f.still,
  });
}

/** Two unassigned records, each with one routing question about the shard topic. */
function twoRouteItems(options: { private?: boolean } = {}): string {
  const topic = f.seedTopic("Shard compaction keeps monthly shard files small");
  f.signal(
    "Shard compaction thresholds were tuned today",
    options.private === true ? { partition: "private" } : {},
  );
  f.signal("Shard compaction monthly files were checked");
  produce();
  return topic;
}

function routeAnswer(probability = 0.9, extra: Record<string, unknown> = {}) {
  return new FakeDecisionProvider({
    answer: (id) => (id.startsWith("route_") ? "T0" : undefined),
    probability,
    model: "enforce-model-3",
    ...extra,
  });
}

function run(provider: FakeDecisionProvider, uses: string, extraEnv: Record<string, string> = {}) {
  return runDecisionExecutor(f.queue, {
    until: Number.POSITIVE_INFINITY,
    clock: f.still,
    configPath: f.configPath,
    provider,
    env: { ...f.env(uses), ...extraEnv },
  });
}

describe("runDecisionExecutor", () => {
  test("enforce: one request per item, each accepted with the provider and the model", async () => {
    const topic = twoRouteItems();
    f.tune("topic_route", { route_min: 0.6 });
    const fake = routeAnswer();
    const result = await run(fake, "topic_route:enforce");
    expect(fake.requests).toHaveLength(2);
    for (const request of fake.requests) {
      expect(Object.keys(request.questions)).toEqual(["route_0"]);
    }
    expect(result.status).toBe("ran");
    if (result.status !== "ran") return;
    expect(result.answered).toBe(2);
    expect(result.asked["topic-route"]).toBe(2);
    for (const item of f.items("topic-route")) {
      expect(item.state).toBe("accepted");
      expect(item.answer?.agent).toBe("decision-model");
      expect(item.answer?.model).toBe("enforce-model-3");
      expect(item.answer?.value).toMatchObject({
        choice: topic,
        confidence: 0.9,
        provider: "compatible",
        model: "enforce-model-3",
        threshold: 0.6,
      });
    }
  });

  test("shadow: asked once, released with its reason, the item waits and is not asked again", async () => {
    twoRouteItems();
    const fake = routeAnswer();
    const first = await run(fake, "topic_route:shadow");
    expect(fake.requests).toHaveLength(2);
    expect(first.status === "ran" && first.shadow).toBe(2);
    for (const item of f.items("topic-route")) {
      expect(item.state).toBe("waiting");
      expect(item.attempts).toBe(0);
      expect(item.last_release?.reason).toBe("shadow");
    }
    expect(listDecisionModelCalls(f.vault).map((c) => c.payload["mode"])).toEqual([
      "shadow",
      "shadow",
    ]);
    const again = routeAnswer();
    await run(again, "topic_route:shadow");
    expect(again.requests).toEqual([]);
  });

  test("an untuned entry held to shadow behaves as shadow", async () => {
    twoRouteItems();
    const fake = routeAnswer();
    await run(fake, "topic_route:enforce");
    expect(fake.requests).toHaveLength(2);
    for (const item of f.items("topic-route")) {
      expect(item.state).toBe("waiting");
      expect(item.last_release?.reason).toBe("shadow");
    }
  });

  test("an untuned fallback under an enforce use fails with backoff", async () => {
    twoRouteItems();
    f.tune("topic_route", { route_min: 0.6 });
    const server = await startFakeSystemOne();
    server.setReply((req) => {
      const questions = req.body["questions"] as Record<string, { type: string }>;
      const answers: Record<string, unknown> = {};
      for (const id of Object.keys(questions)) {
        answers[id] = {
          type: "choice",
          choice: "T0",
          probabilities: { T0: 0.9, none: 0.1 },
        };
      }
      return {
        json: { model: "fallback-model", answers, usage: { input_tokens: 9, output_tokens: 1 } },
      };
    });
    writeFileSync(
      f.configPath,
      [
        `store_root: ${f.m.root("dev-a")}`,
        "device_id: dev-a",
        `decision_model_providers_typesafe_base_url: ${server.url}`,
        "decision_model_providers_typesafe_id: fallback-model",
        "decision_model_providers_typesafe_env_key: O2B_TEST_DECIDE_KEY",
        "",
      ].join("\n"),
    );
    try {
      const env = {
        ...f.env("topic_route:enforce"),
        OPEN_SECOND_BRAIN_DECISION_MODEL_PROVIDER: undefined,
        OPEN_SECOND_BRAIN_DECISION_MODEL_PROVIDERS: "compatible,typesafe",
        OPEN_SECOND_BRAIN_DECISION_MODEL_BASE_URL: "http://127.0.0.1:1",
      };
      const result = await runDecisionExecutor(f.queue, {
        until: Number.POSITIVE_INFINITY,
        clock: f.still,
        configPath: f.configPath,
        env,
      });
      expect(server.requests).toHaveLength(2);
      expect(result.status === "ran" && result.failed).toBe(2);
      expect(
        f.items("topic-route").every((item) => item.attempts === 1 && item.retry_at !== null),
      ).toBe(true);
      await runDecisionExecutor(f.queue, {
        until: Number.POSITIVE_INFINITY,
        clock: f.still,
        configPath: f.configPath,
        env,
      });
      expect(server.requests).toHaveLength(2);
    } finally {
      await server.close();
    }
  });

  test("off: the items are left untouched for another executor", async () => {
    twoRouteItems();
    const fake = routeAnswer();
    const result = await run(fake, "topic_route:off");
    expect(fake.requests).toEqual([]);
    expect(result.status === "ran" && result.answered).toBe(0);
    for (const item of f.items("topic-route")) {
      expect(item.state).toBe("waiting");
      expect(item.generation).toBe(0);
    }
  });

  test("not configured: nothing is taken", async () => {
    twoRouteItems();
    const fake = routeAnswer();
    const result = await runDecisionExecutor(f.queue, {
      until: Number.POSITIVE_INFINITY,
      clock: f.still,
      configPath: f.configPath,
      provider: fake,
      env: { OPEN_SECOND_BRAIN_CONFIG: f.configPath },
    });
    expect(result).toEqual({ status: "not-configured" });
    expect(fake.requests).toEqual([]);
    for (const item of f.items("topic-route")) expect(item.generation).toBe(0);
  });

  test("a private item and a hosted chain: released as egress-refused, no failed attempt, not taken again", async () => {
    twoRouteItems({ private: true });
    f.tune("topic_route", { route_min: 0.6 });
    const fake = routeAnswer();
    const result = await run(fake, "topic_route:enforce");
    // Only the shared item was sent.
    expect(fake.requests).toHaveLength(1);
    expect(result.status === "ran" && result.refused).toBe(1);
    const privateItem = f.items("topic-route").find((i) => i.partition === "private")!;
    expect(privateItem.state).toBe("waiting");
    expect(privateItem.attempts).toBe(0);
    expect(privateItem.generation).toBe(1);
    expect(privateItem.last_release?.reason).toBe("egress-refused");
    const again = routeAnswer();
    await run(again, "topic_route:enforce");
    expect(again.requests).toEqual([]);
  });

  test("a timeout is a failed attempt with a retry time", async () => {
    twoRouteItems();
    f.tune("topic_route", { route_min: 0.6 });
    const fake = routeAnswer(0.9, { fail: "timeout" });
    const result = await run(fake, "topic_route:enforce");
    expect(result.status === "ran" && result.failed).toBe(2);
    for (const item of f.items("topic-route")) {
      expect(item.state).toBe("waiting");
      expect(item.attempts).toBe(1);
      expect(item.last_reason).toBe("timeout");
      expect(item.retry_at).not.toBeNull();
    }
  });

  test("a temporary input read failure releases its lease and skips it for this run", async () => {
    twoRouteItems();
    f.tune("topic_route", { route_min: 0.6 });
    const target = f.items("topic-route")[0]!.id;
    const original = dreamOperations.dreamWorkOperation;
    let targetReads = 0;
    const spy = spyOn(dreamOperations, "dreamWorkOperation").mockImplementation((name) => {
      const operation = original(name);
      if (name !== "topic-route" || operation === undefined) return operation;
      return {
        ...operation,
        currentInput: (item, context) => {
          if (item.id === target && ++targetReads === 2) {
            return { unavailable: true, input_hash: item.body.input_hash };
          }
          return operation.currentInput(item, context);
        },
      };
    });
    try {
      const fake = routeAnswer();
      const result = await run(fake, "topic_route:enforce");
      expect(fake.requests).toHaveLength(2);
      expect(result.status === "ran" && result.answered).toBe(1);
      expect(f.items("topic-route").find((item) => item.id === target)).toMatchObject({
        state: "waiting",
        attempts: 0,
        last_release: { reason: "input_unavailable" },
      });
    } finally {
      spy.mockRestore();
    }
  });

  test("a state over the token limit is a failed attempt", async () => {
    twoRouteItems();
    f.tune("topic_route", { route_min: 0.6 });
    const fake = routeAnswer();
    const result = await run(fake, "topic_route:enforce", {
      OPEN_SECOND_BRAIN_DECISION_MODEL_MAX_STATE_TOKENS: "10",
    });
    expect(fake.requests).toEqual([]);
    expect(result.status === "ran" && result.asked["topic-route"]).toBe(0);
    for (const item of f.items("topic-route")) {
      expect(item.attempts).toBe(1);
      expect(item.last_reason).toBe("budget");
    }
  });

  test("the cost gate stops the loop", async () => {
    twoRouteItems();
    f.tune("topic_route", { route_min: 0.6 });
    emitDecisionModelCall(f.vault, {
      use: "topic_route",
      mode: "enforce",
      provider: "fake",
      model: "m",
      calibrated: true,
      questionCount: 1,
      candidateCount: 1,
      usage: { costUsd: 1 },
      inputPriceUsdPerMtok: null,
      latencyMs: 1,
      outcome: "ok",
    });
    const fake = routeAnswer();
    const result = await run(fake, "topic_route:enforce", {
      OPEN_SECOND_BRAIN_DECISION_MODEL_COST_GATE_USD: "0.5",
    });
    expect(fake.requests).toEqual([]);
    expect(result.status === "ran" && result.asked["topic-route"]).toBe(0);
    expect(result.status === "ran" && result.stopped).toBe("cost_gate");
    const taken = f.items("topic-route").filter((i) => i.generation > 0);
    expect(taken).toHaveLength(1);
    expect(taken[0]!.attempts).toBe(0);
  });

  test("decision thresholds resolve from the queue vault", async () => {
    const topic = twoRouteItems();
    f.tune("topic_route", { route_min: 0.6 });
    const queueVault = `${f.vault}-queue`;
    writeThresholdEntry(
      decisionThresholdsPath(f.configPath),
      "decide-model",
      "topic_route",
      { values: { route_min: 0.99 }, source: "set" },
      queueVault,
    );
    resetThresholdsStoreCache();
    const queue = { ...f.queue, vault: queueVault };
    const provider = routeAnswer(0.9, { model: "decide-model" });
    const result = await runDecisionExecutor(queue, {
      until: Number.POSITIVE_INFINITY,
      clock: f.still,
      configPath: f.configPath,
      provider,
      env: f.env("topic_route:enforce"),
    });
    expect(provider.requests).toHaveLength(2);
    expect(f.items("topic-route")[0]?.answer?.value).toMatchObject({ threshold: 0.99 });
    expect(result.status === "ran" && result.answered).toBe(2);
    expect(f.items("topic-route")[0]?.answer?.value).toMatchObject({
      choice: topic,
      threshold: 0.99,
    });
  });

  test("the deadline stops the loop with items still ready", async () => {
    twoRouteItems();
    f.tune("topic_route", { route_min: 0.6 });
    const fake = routeAnswer();
    const result = await runDecisionExecutor(f.queue, {
      until: 0,
      clock: f.still,
      configPath: f.configPath,
      provider: fake,
      env: f.env("topic_route:enforce"),
    });
    expect(fake.requests).toEqual([]);
    expect(result.status === "ran" && result.stopped).toBe("deadline");
    for (const item of f.items("topic-route")) {
      expect(item.state).toBe("waiting");
      expect(item.ready).toBe(true);
    }
  });
});
