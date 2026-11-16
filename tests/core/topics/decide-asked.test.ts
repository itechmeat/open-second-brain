/**
 * The decide pass's device-local "asked" set (design D20): an answer that
 * writes nothing (here a routine `event_kind`) is remembered by use,
 * record, question version, answering model and mode, so the next pass
 * asks the records not yet asked instead of the same newest ones; and a
 * record dated in the future does not take the place of the present ones.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { appendRecord } from "../../../src/core/store/appender.ts";
import {
  decisionThresholdsPath,
  resetThresholdsStoreCache,
  writeThresholdEntry,
} from "../../../src/core/decision-model/thresholds.ts";
import { newUlid } from "../../../src/core/store/ulid.ts";
import type { StoreHandle } from "../../../src/core/store/store-open.ts";
import { TOPIC_ASSIGN_KIND, TOPIC_CREATE_KIND } from "../../../src/core/topics/constants.ts";
import { decideTopicPlan } from "../../../src/core/topics/decide.ts";
import { claimSettled, claimViewWriter, readViewWriter } from "../../../src/core/view/writer.ts";
import { makeMachines, type Machines } from "../view/fixtures/machines.ts";
import { FAKE_DECISION_KEY } from "../../helpers/fake-credentials.ts";
import { FakeDecisionProvider } from "../../helpers/fake-decision-provider.ts";

const T0 = Date.UTC(2026, 11, 1, 9, 0, 0);
let clock = T0;
const now = () => (clock += 1000);
/** The test clock moves a second per read: a pass budget that never ends here. */
const LONG = 10_000_000;

let m: Machines;
let a: StoreHandle;
let tmp: string;
let configPath: string;

beforeEach(() => {
  clock = T0;
  m = makeMachines(["dev-a"], "o2b-decide-asked-");
  a = m.open("dev-a");
  claimViewWriter(a, { agent: "dream", now });
  claimSettled(a, readViewWriter(a, now));
  tmp = mkdtempSync(join(m.parent, "cfg-"));
  const vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  process.env["VAULT_DIR"] = vault;
  configPath = join(tmp, "config.yaml");
  writeFileSync(configPath, "");
  resetThresholdsStoreCache();
});

afterEach(() => {
  delete process.env["VAULT_DIR"];
  resetThresholdsStoreCache();
  m.cleanup();
});

let seq = 0;
function signal(text: string): string {
  clock += 1000;
  seq += 1;
  return appendRecord(
    a,
    {
      partition: "shared",
      stream: "events",
      kind: "signal",
      agent: "agent-1",
      body: {
        id: `sig-2026-12-01-q${seq}`,
        path: `Brain/inbox/q${seq}.md`,
        staged: false,
        frontmatter: { principle: text, project: "o2b", session: "s1" },
        raw: null,
        raw_shape: "bare",
      },
    },
    { now },
  ).record.id;
}

function seedTopic(title: string): string {
  clock += 1000;
  const topic = newUlid(clock);
  appendRecord(
    a,
    {
      partition: "shared",
      stream: "topics",
      kind: TOPIC_CREATE_KIND,
      agent: "seed",
      topic,
      body: { authority: "agent", title, scope: "project:o2b" },
    },
    { now },
  );
  return topic;
}

function holdRecord(topic: string, record: string): void {
  appendRecord(
    a,
    {
      partition: "shared",
      stream: "topics",
      kind: TOPIC_ASSIGN_KIND,
      agent: "seed",
      topic,
      body: { authority: "agent", record },
    },
    { now },
  );
}

function envFor(mode: string): Record<string, string | undefined> {
  return {
    OPEN_SECOND_BRAIN_DECISION_MODEL_ENABLED: "true",
    OPEN_SECOND_BRAIN_DECISION_MODEL_PROVIDER: "compatible",
    OPEN_SECOND_BRAIN_DECISION_MODEL_BASE_URL: "https://decide.invalid/v1",
    OPEN_SECOND_BRAIN_DECISION_MODEL_ID: "decide-model",
    OPEN_SECOND_BRAIN_DECISION_MODEL_ENV_KEY: "O2B_TEST_DECIDE_KEY",
    OPEN_SECOND_BRAIN_DECISION_MODEL_USES: `event_kind:${mode}`,
    O2B_TEST_DECIDE_KEY: FAKE_DECISION_KEY,
    OPEN_SECOND_BRAIN_CONFIG: configPath,
  };
}

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

describe("the asked set", () => {
  test("two passes over more than 50 held records ask each record once", async () => {
    writeThresholdEntry(decisionThresholdsPath(configPath), "decide-model", "event_kind", {
      values: { kind_min: 0.7 },
      source: "set",
    });
    resetThresholdsStoreCache();
    const topic = seedTopic("Shard compaction keeps monthly shard files small");
    for (let i = 0; i < 60; i++) holdRecord(topic, signal(`routine heartbeat number ${i}`));
    const first = routine();
    await decideTopicPlan(a, { provider: first, env: envFor("enforce"), now, deadlineMs: LONG });
    const second = routine();
    await decideTopicPlan(a, { provider: second, env: envFor("enforce"), now, deadlineMs: LONG });
    const texts = [...askedTexts(first), ...askedTexts(second)];
    expect(texts).toHaveLength(60);
    expect(new Set(texts).size).toBe(60);
    // A third pass has nothing left to ask.
    const third = routine();
    await decideTopicPlan(a, { provider: third, env: envFor("enforce"), now, deadlineMs: LONG });
    expect(third.requests).toEqual([]);
  });

  test("a pass that fails after answers arrived keeps them asked", async () => {
    writeThresholdEntry(decisionThresholdsPath(configPath), "decide-model", "event_kind", {
      values: { kind_min: 0.7 },
      source: "set",
    });
    resetThresholdsStoreCache();
    const topic = seedTopic("Shard compaction keeps monthly shard files small");
    holdRecord(topic, signal("routine heartbeat"));
    const first = routine();
    // The pass fails at its first clock read after the answer arrived.
    const failing = (): number => {
      if (first.requests.length > 0) throw new Error("the pass failed");
      return now();
    };
    let failed = false;
    try {
      await decideTopicPlan(a, {
        provider: first,
        env: envFor("enforce"),
        now: failing,
        deadlineMs: LONG,
      });
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
    expect(askedTexts(first)).toHaveLength(1);
    const second = routine();
    await decideTopicPlan(a, { provider: second, env: envFor("enforce"), now, deadlineMs: LONG });
    expect(second.requests).toEqual([]);
  });

  test("an answer given in shadow is asked again once the use is in enforce", async () => {
    writeThresholdEntry(decisionThresholdsPath(configPath), "decide-model", "event_kind", {
      values: { kind_min: 0.7 },
      source: "set",
    });
    resetThresholdsStoreCache();
    const topic = seedTopic("Shard compaction keeps monthly shard files small");
    holdRecord(topic, signal("routine heartbeat"));
    const shadow = routine();
    await decideTopicPlan(a, { provider: shadow, env: envFor("shadow"), now, deadlineMs: LONG });
    const shadowAgain = routine();
    await decideTopicPlan(a, {
      provider: shadowAgain,
      env: envFor("shadow"),
      now,
      deadlineMs: LONG,
    });
    expect(askedTexts(shadow)).toHaveLength(1);
    expect(shadowAgain.requests).toEqual([]);
    const enforce = routine();
    await decideTopicPlan(a, { provider: enforce, env: envFor("enforce"), now, deadlineMs: LONG });
    expect(askedTexts(enforce)).toHaveLength(1);
  });

  test("a record dated in the future does not take the place of a present one", async () => {
    const topic = seedTopic("Shard compaction keeps monthly shard files small");
    for (let i = 0; i < 50; i++) holdRecord(topic, signal(`present note number ${i}`));
    const runAt = new Date(clock + 1000);
    // A device with a fast clock: its record claims a month from now.
    clock += 30 * 24 * 60 * 60 * 1000;
    holdRecord(topic, signal("FUTURE-DATED note"));
    const fake = routine();
    await decideTopicPlan(a, {
      provider: fake,
      env: envFor("shadow"),
      now,
      runAt,
      deadlineMs: LONG,
    });
    const texts = askedTexts(fake);
    expect(texts).toHaveLength(50);
    expect(texts.some((t) => t.includes("FUTURE-DATED"))).toBe(false);
  });
});
