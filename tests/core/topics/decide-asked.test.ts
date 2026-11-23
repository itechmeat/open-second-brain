/**
 * What the device-local "asked" set did, the queue now holds (change
 * `dream-closed-questions`, design D4, D5, D6): an answer that decides
 * nothing (here a routine `event_kind`) finishes its item as abstained,
 * so the next pass asks the records not yet asked; an answer accepted
 * before a run fails is kept; a shadow answer is not asked again in
 * shadow, and is asked again once the use is in enforce; a record dated
 * in the future does not take the place of a present one. The asked file
 * is neither read nor written.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";

import { runDecisionExecutor } from "../../../src/core/brain/dream-queue/decision-executor.ts";
import { readTopicQuestionState } from "../../../src/core/topics/decide-operations.ts";
import { produceTopicQuestions } from "../../../src/core/topics/decide-produce.ts";
import { FakeDecisionProvider } from "../../helpers/fake-decision-provider.ts";
import { closedFixture, type ClosedFixture } from "./fixtures/closed-fixture.ts";
import { ask, plan } from "./fixtures/closed-run.ts";

let f: ClosedFixture;

beforeEach(() => {
  f = closedFixture();
});

afterEach(() => {
  f.cleanup();
});

/** A provider that answers `routine` to every kind question. */
function routine(): FakeDecisionProvider {
  return new FakeDecisionProvider({
    model: "decide-model",
    answer: (id) => (id.startsWith("kind_") ? "routine" : undefined),
    probability: 0.9,
  });
}

/** The record texts every request of `fake` asked about. */
function askedTexts(fake: FakeDecisionProvider): string[] {
  return fake.requests.flatMap((r) =>
    Object.values((r.state as { records: Record<string, { text: string }> }).records).map(
      (rec) => rec.text,
    ),
  );
}

/** Every file under `dir`, recursively (an absent directory has none). */
function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => e.name);
}

describe("what the queue remembers", () => {
  test("two passes over more than 50 held records ask each record once", async () => {
    f.tune("event_kind", { kind_min: 0.7 });
    const topic = f.seedTopic("Shard compaction keeps monthly shard files small");
    for (let i = 0; i < 60; i++) f.holdRecord(topic, f.signal(`routine heartbeat number ${i}`));
    const first = routine();
    await ask(f, "event_kind:enforce", first);
    plan(f);
    const second = routine();
    await ask(f, "event_kind:enforce", second);
    const texts = [...askedTexts(first), ...askedTexts(second)];
    expect(texts).toHaveLength(60);
    expect(new Set(texts).size).toBe(60);
    // A third pass has nothing left to ask.
    const third = routine();
    await ask(f, "event_kind:enforce", third);
    expect(third.requests).toEqual([]);
    // No device-local asked file is written.
    expect(filesUnder(f.m.parent).filter((n) => n.includes("decide-asked"))).toEqual([]);
  }, 30_000);

  test("a run that fails after an answer arrived keeps the answer", async () => {
    f.tune("event_kind", { kind_min: 0.7 });
    const topic = f.seedTopic("Shard compaction keeps monthly shard files small");
    f.holdRecord(topic, f.signal("routine heartbeat"));
    produceTopicQuestions(f.queue, readTopicQuestionState(f.a, f.still())!, {
      until: Number.POSITIVE_INFINITY,
      clock: f.still,
    });
    const first = routine();
    // The run fails at its first clock read after the answer arrived.
    const failing = (): number => {
      if (first.requests.length > 0) throw new Error("the run failed");
      return f.still();
    };
    let failed = false;
    try {
      await runDecisionExecutor(f.queue, {
        until: Number.POSITIVE_INFINITY,
        clock: failing,
        configPath: f.configPath,
        provider: first,
        env: f.env("event_kind:enforce"),
      });
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
    expect(askedTexts(first)).toHaveLength(1);
    expect(f.items("event-kind")[0]!.state).toBe("accepted");
    const second = routine();
    await ask(f, "event_kind:enforce", second);
    expect(second.requests).toEqual([]);
  });

  test("an answer given in shadow is asked again once the use is in enforce", async () => {
    f.tune("event_kind", { kind_min: 0.7 });
    const topic = f.seedTopic("Shard compaction keeps monthly shard files small");
    f.holdRecord(topic, f.signal("routine heartbeat"));
    const shadow = routine();
    await ask(f, "event_kind:shadow", shadow);
    const shadowAgain = routine();
    await ask(f, "event_kind:shadow", shadowAgain);
    expect(askedTexts(shadow)).toHaveLength(1);
    expect(shadowAgain.requests).toEqual([]);
    expect(f.items("event-kind")[0]!.last_release?.reason).toBe("shadow");
    const enforce = routine();
    await ask(f, "event_kind:enforce", enforce);
    expect(askedTexts(enforce)).toHaveLength(1);
  });

  test("a record dated in the future does not take the place of a present one", async () => {
    const topic = f.seedTopic("Shard compaction keeps monthly shard files small");
    for (let i = 0; i < 50; i++) f.holdRecord(topic, f.signal(`present note number ${i}`));
    const runAt = f.still() + 1000;
    // A device with a fast clock: its record claims a month from now.
    f.setClock(f.still() + 30 * 24 * 60 * 60 * 1000);
    f.holdRecord(topic, f.signal("FUTURE-DATED note"));
    f.setClock(runAt);
    const fake = routine();
    await ask(f, "event_kind:shadow", fake);
    const texts = askedTexts(fake);
    // Oldest first, with no cap: every present record before the future-dated one.
    expect(texts).toHaveLength(51);
    expect(texts.slice(0, 50).some((t) => t.includes("FUTURE-DATED"))).toBe(false);
    expect(texts[50]).toBe("FUTURE-DATED note");
  }, 30_000);
});
