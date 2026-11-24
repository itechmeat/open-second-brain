/**
 * The model budget of a pass (change `dream-closed-questions`, design
 * D4; was the decide pass's per-use shares, design D10): the executor
 * takes items in queue order, oldest first across every use, so a long
 * queue of one use never starves an older item of another; no request is
 * given more time than the budget has left; the executor stops starting
 * requests when the budget is spent, and what it did not reach waits for
 * the next pass.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  RELEASE_SHADOW,
  runDecisionExecutor,
} from "../../../src/core/brain/dream-queue/decision-executor.ts";
import { MIN_REQUEST_MS } from "../../../src/core/decision-model/request-floor.ts";
import { readTopicQuestionState } from "../../../src/core/topics/decide-operations.ts";
import { produceTopicQuestions } from "../../../src/core/topics/decide-produce.ts";
import { FakeDecisionProvider } from "../../helpers/fake-decision-provider.ts";
import { closedFixture, T0, type ClosedFixture } from "./fixtures/closed-fixture.ts";

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

/** Run the executor with `provider` until `until` on `clock`. */
async function execute(
  provider: FakeDecisionProvider,
  uses: string,
  until: number,
  clock: () => number,
  extraEnv: Record<string, string> = {},
) {
  return runDecisionExecutor(f.queue, {
    until,
    clock,
    configPath: f.configPath,
    provider,
    env: { ...f.env(uses), ...extraEnv },
  });
}

describe("the model budget of a pass", () => {
  test("a long routing queue on a slow provider never starves an older item of another use", async () => {
    // The note is older than every record: it comes first in the queue.
    f.note("Refactor of the shard writer landed cleanly", T0 - 2 * 24 * 60 * 60 * 1000);
    f.seedTopic("Shard compaction keeps monthly shard files small");
    for (let i = 0; i < 60; i++) {
      f.signal(`Shard compaction note ${i} about monthly shard files`, { session: `s${i}` });
    }
    produce();
    const fake = new FakeDecisionProvider({ latencyMs: 80 });
    await execute(fake, "topic_route:shadow,human_readable:shadow", Date.now() + 2800, Date.now);
    const uses = fake.requests.map((r) => r.use);
    expect(uses[0]).toBe("human_readable");
    expect(uses).toContain("topic_route");
  });

  test("no request is given more time than the budget has left", async () => {
    f.seedTopic("Shard compaction keeps monthly shard files small");
    // A near twin, so topic_same has a pair to ask about.
    f.seedTopic("Shard compaction keeps monthly shard files smaller");
    f.signal("Shard compaction note about monthly shard files");
    produce();
    const timeouts: Array<{ use: string; ms: number }> = [];
    class Recording extends FakeDecisionProvider {
      override async decide(
        req: Parameters<FakeDecisionProvider["decide"]>[0],
        opts: Parameters<FakeDecisionProvider["decide"]>[1],
      ) {
        timeouts.push({ use: req.use, ms: opts.timeoutMs });
        return super.decide(req, opts);
      }
    }
    const budgetMs = 2000;
    // A clock that does not advance on read: what is left is exact.
    await execute(
      new Recording({}),
      "topic_route:shadow,topic_same:shadow",
      f.still() + budgetMs,
      f.still,
      { OPEN_SECOND_BRAIN_DECISION_MODEL_TIMEOUT_MS: "20000" },
    );
    expect(timeouts.map((t) => t.use).toSorted()).toEqual(["topic_route", "topic_same"]);
    for (const { ms } of timeouts) {
      expect(ms).toBeGreaterThanOrEqual(MIN_REQUEST_MS);
      expect(ms).toBeLessThanOrEqual(budgetMs);
    }
  });

  test("the executor stops starting requests when the budget is spent, and the rest wait", async () => {
    for (let i = 0; i < 8; i++) {
      f.seedTopic(`Shard compaction keeps monthly shard files small, part ${i}`);
    }
    produce();
    const pairs = f.items("topic-same").length;
    expect(pairs).toBeGreaterThan(5);
    // Each answer takes 150 ms of a clock only the answers move: the
    // budget runs out at the same request on every run, however loaded
    // the machine is.
    let now = f.still();
    class Slow extends FakeDecisionProvider {
      override async decide(
        req: Parameters<FakeDecisionProvider["decide"]>[0],
        opts: Parameters<FakeDecisionProvider["decide"]>[1],
      ) {
        now += 150;
        return super.decide(req, opts);
      }
    }
    const fake = new Slow({});
    const result = await execute(fake, "topic_same:shadow", now + 600, () => now);
    expect(result.status === "ran" && result.stopped).toBe("deadline");
    const asked = fake.requests.length;
    expect(asked).toBeGreaterThan(0);
    expect(asked).toBeLessThan(pairs);
    // What was not reached is still ready for the next pass: never asked,
    // or taken and given back unasked at the deadline (a release that is
    // not a shadow answer leaves the item takeable).
    const waiting = f
      .items("topic-same")
      .filter((i) => i.attempts === 0 && i.last_release?.reason !== RELEASE_SHADOW);
    expect(waiting).toHaveLength(pairs - asked);
  });

  test("with less than the minimum request time left no request starts", async () => {
    f.note("Refactor of the shard writer landed cleanly", T0 - 2 * 24 * 60 * 60 * 1000);
    produce();
    const run = async (budgetMs: number): Promise<string[]> => {
      const fake = new FakeDecisionProvider({});
      await execute(fake, "human_readable:shadow", f.still() + budgetMs, f.still);
      return fake.requests.map((r) => r.use);
    };
    expect(await run(MIN_REQUEST_MS - 1)).toEqual([]);
    expect(await run(MIN_REQUEST_MS * 2)).toEqual(["human_readable"]);
  });
});
