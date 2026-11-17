/**
 * The decide pass shares its budget between the uses (design D10): a
 * slow provider and a long routing queue must not leave the later uses
 * (here `human_readable`, the last one) without a single request.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { appendRecord } from "../../../src/core/store/appender.ts";
import { newUlid } from "../../../src/core/store/ulid.ts";
import type { StoreHandle } from "../../../src/core/store/store-open.ts";
import { TOPIC_CREATE_KIND } from "../../../src/core/topics/constants.ts";
import { decideTopicPlan } from "../../../src/core/topics/decide.ts";
import { MIN_REQUEST_MS } from "../../../src/core/decision-model/request-floor.ts";
import { claimSettled, claimViewWriter, readViewWriter } from "../../../src/core/view/writer.ts";
import { makeMachines, type Machines } from "../view/fixtures/machines.ts";
import { FAKE_DECISION_KEY } from "../../helpers/fake-credentials.ts";
import { FakeDecisionProvider } from "../../helpers/fake-decision-provider.ts";

const T0 = Date.UTC(2026, 11, 1, 9, 0, 0);
let clock = T0;
const now = () => (clock += 1000);

let m: Machines;
let a: StoreHandle;
let tmp: string;

beforeEach(() => {
  clock = T0;
  m = makeMachines(["dev-a"], "o2b-decide-budget-");
  a = m.open("dev-a");
  claimViewWriter(a, { agent: "dream", now });
  claimSettled(a, readViewWriter(a, now));
  tmp = mkdtempSync(join(m.parent, "cfg-"));
  const vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  process.env["VAULT_DIR"] = vault;
  writeFileSync(join(tmp, "config.yaml"), "");
});

afterEach(() => {
  delete process.env["VAULT_DIR"];
  m.cleanup();
});

function signal(text: string, i: number): void {
  clock += 1000;
  appendRecord(
    a,
    {
      partition: "shared",
      stream: "events",
      kind: "signal",
      agent: "agent-1",
      body: {
        id: `sig-2026-12-01-b${i}`,
        path: `Brain/inbox/b${i}.md`,
        staged: false,
        frontmatter: { principle: text, project: "o2b", session: "s1" },
        raw: null,
        raw_shape: "bare",
      },
    },
    { now },
  );
}

describe("the decide pass budget", () => {
  test("a long routing queue on a slow provider leaves the last use its share", async () => {
    clock += 1000;
    appendRecord(
      a,
      {
        partition: "shared",
        stream: "topics",
        kind: TOPIC_CREATE_KIND,
        agent: "seed",
        topic: newUlid(clock),
        body: {
          authority: "agent",
          title: "Shard compaction keeps monthly shard files small",
          scope: "project:o2b",
        },
      },
      { now },
    );
    for (let i = 0; i < 60; i++) signal(`Shard compaction note ${i} about monthly shard files`, i);
    const ms = T0 - 2 * 24 * 60 * 60 * 1000;
    appendRecord(
      a,
      {
        partition: "shared",
        stream: "log",
        kind: "log-event",
        agent: "seed",
        body: {
          timestamp: new Date(ms).toISOString(),
          event_type: "note",
          body: { text: "Refactor of the shard writer landed cleanly" },
        },
      },
      { now: () => ms },
    );
    const fake = new FakeDecisionProvider({ latencyMs: 80 });
    await decideTopicPlan(a, {
      provider: fake,
      env: {
        OPEN_SECOND_BRAIN_DECISION_MODEL_ENABLED: "true",
        OPEN_SECOND_BRAIN_DECISION_MODEL_PROVIDER: "compatible",
        OPEN_SECOND_BRAIN_DECISION_MODEL_BASE_URL: "https://decide.invalid/v1",
        OPEN_SECOND_BRAIN_DECISION_MODEL_ID: "decide-model",
        OPEN_SECOND_BRAIN_DECISION_MODEL_ENV_KEY: "O2B_TEST_DECIDE_KEY",
        OPEN_SECOND_BRAIN_DECISION_MODEL_USES: "topic_route:shadow,human_readable:shadow",
        O2B_TEST_DECIDE_KEY: FAKE_DECISION_KEY,
        OPEN_SECOND_BRAIN_CONFIG: join(tmp, "config.yaml"),
      },
      // The budget runs on the wall clock; record ages follow the run date.
      runAt: new Date(T0),
      // Seven uses share it: the first gets 400 ms, above the minimum
      // request time.
      deadlineMs: 2800,
    });
    const uses = fake.requests.map((r) => r.use);
    expect(uses).toContain("topic_route");
    expect(uses).toContain("human_readable");
  });

  test("no request is given more time than its use has left", async () => {
    clock += 1000;
    appendRecord(
      a,
      {
        partition: "shared",
        stream: "topics",
        kind: TOPIC_CREATE_KIND,
        agent: "seed",
        topic: newUlid(clock),
        body: {
          authority: "agent",
          title: "Shard compaction keeps monthly shard files small",
          scope: "project:o2b",
        },
      },
      { now },
    );
    // A near twin, so topic_same has a pair to ask about.
    clock += 1000;
    appendRecord(
      a,
      {
        partition: "shared",
        stream: "topics",
        kind: TOPIC_CREATE_KIND,
        agent: "seed",
        topic: newUlid(clock),
        body: {
          authority: "agent",
          title: "Shard compaction keeps monthly shard files smaller",
          scope: "project:o2b",
        },
      },
      { now },
    );
    signal("Shard compaction note about monthly shard files", 0);
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
    // The first use's share (2000 / 7) stays above the minimum request time.
    const deadlineMs = 2000;
    await decideTopicPlan(a, {
      provider: new Recording({}),
      env: {
        OPEN_SECOND_BRAIN_DECISION_MODEL_ENABLED: "true",
        OPEN_SECOND_BRAIN_DECISION_MODEL_PROVIDER: "compatible",
        OPEN_SECOND_BRAIN_DECISION_MODEL_BASE_URL: "https://decide.invalid/v1",
        OPEN_SECOND_BRAIN_DECISION_MODEL_ID: "decide-model",
        OPEN_SECOND_BRAIN_DECISION_MODEL_ENV_KEY: "O2B_TEST_DECIDE_KEY",
        OPEN_SECOND_BRAIN_DECISION_MODEL_TIMEOUT_MS: "20000",
        OPEN_SECOND_BRAIN_DECISION_MODEL_USES: "topic_route:shadow,topic_same:shadow",
        O2B_TEST_DECIDE_KEY: FAKE_DECISION_KEY,
        OPEN_SECOND_BRAIN_CONFIG: join(tmp, "config.yaml"),
      },
      runAt: new Date(T0),
      deadlineMs,
      // Does not advance on read: each use's share is exact.
      now: () => clock,
    });
    // topic_route gets 2000 / 7 uses, rounded up; it spends nothing on
    // this clock, so topic_same gets 2000 / 6. The runner measures its
    // own budget on the wall clock from the call's start, so a request
    // may get a few milliseconds less than its share, never more, and
    // never less than the minimum request time.
    expect(timeouts.map((t) => t.use)).toEqual(["topic_route", "topic_same"]);
    const allowance = {
      topic_route: Math.ceil(deadlineMs / 7),
      topic_same: Math.ceil(deadlineMs / 6),
    };
    for (const { use, ms } of timeouts) {
      expect(ms).toBeGreaterThanOrEqual(MIN_REQUEST_MS);
      expect(ms).toBeLessThanOrEqual(allowance[use as keyof typeof allowance]);
    }
  });

  test("topic_same stops starting pair requests when its share is spent", async () => {
    for (let i = 0; i < 8; i++) {
      clock += 1000;
      appendRecord(
        a,
        {
          partition: "shared",
          stream: "topics",
          kind: TOPIC_CREATE_KIND,
          agent: "seed",
          topic: newUlid(clock),
          body: {
            authority: "agent",
            title: `Shard compaction keeps monthly shard files small, part ${i}`,
            description: `Notes on monthly shard compaction and shard file sizes, round ${i}.`,
            scope: "project:o2b",
          },
        },
        { now },
      );
    }
    const ms = T0 - 2 * 24 * 60 * 60 * 1000;
    appendRecord(
      a,
      {
        partition: "shared",
        stream: "log",
        kind: "log-event",
        agent: "seed",
        body: {
          timestamp: new Date(ms).toISOString(),
          event_type: "note",
          body: { text: "Refactor of the shard writer landed cleanly" },
        },
      },
      { now: () => ms },
    );
    const fake = new FakeDecisionProvider({ latencyMs: 150 });
    await decideTopicPlan(a, {
      provider: fake,
      env: {
        OPEN_SECOND_BRAIN_DECISION_MODEL_ENABLED: "true",
        OPEN_SECOND_BRAIN_DECISION_MODEL_PROVIDER: "compatible",
        OPEN_SECOND_BRAIN_DECISION_MODEL_BASE_URL: "https://decide.invalid/v1",
        OPEN_SECOND_BRAIN_DECISION_MODEL_ID: "decide-model",
        OPEN_SECOND_BRAIN_DECISION_MODEL_ENV_KEY: "O2B_TEST_DECIDE_KEY",
        OPEN_SECOND_BRAIN_DECISION_MODEL_USES: "topic_same:shadow,human_readable:shadow",
        // Small requests: the pairs need every one of the runner's requests.
        OPEN_SECOND_BRAIN_DECISION_MODEL_MAX_STATE_TOKENS: "400",
        O2B_TEST_DECIDE_KEY: FAKE_DECISION_KEY,
        OPEN_SECOND_BRAIN_CONFIG: join(tmp, "config.yaml"),
      },
      runAt: new Date(T0),
      // topic_same's share (about 580 ms) fits a few 150 ms requests, not five.
      deadlineMs: 3500,
    });
    const uses = fake.requests.map((r) => r.use);
    expect(uses).toContain("topic_same");
    expect(uses.filter((u) => u === "topic_same").length).toBeLessThan(5);
    expect(uses).toContain("human_readable");
  });

  test("a use with less than the minimum request time left starts no request", async () => {
    const ms = T0 - 2 * 24 * 60 * 60 * 1000;
    appendRecord(
      a,
      {
        partition: "shared",
        stream: "log",
        kind: "log-event",
        agent: "seed",
        body: {
          timestamp: new Date(ms).toISOString(),
          event_type: "note",
          body: { text: "Refactor of the shard writer landed cleanly" },
        },
      },
      { now: () => ms },
    );
    // A clock that does not advance on read: the only use asked has the
    // whole pass budget left when it starts.
    const still = (): number => T0;
    const pass = async (deadlineMs: number): Promise<string[]> => {
      const fake = new FakeDecisionProvider({});
      await decideTopicPlan(a, {
        provider: fake,
        env: {
          OPEN_SECOND_BRAIN_DECISION_MODEL_ENABLED: "true",
          OPEN_SECOND_BRAIN_DECISION_MODEL_PROVIDER: "compatible",
          OPEN_SECOND_BRAIN_DECISION_MODEL_BASE_URL: "https://decide.invalid/v1",
          OPEN_SECOND_BRAIN_DECISION_MODEL_ID: "decide-model",
          OPEN_SECOND_BRAIN_DECISION_MODEL_ENV_KEY: "O2B_TEST_DECIDE_KEY",
          OPEN_SECOND_BRAIN_DECISION_MODEL_USES: "human_readable:shadow",
          O2B_TEST_DECIDE_KEY: FAKE_DECISION_KEY,
          OPEN_SECOND_BRAIN_CONFIG: join(tmp, "config.yaml"),
        },
        now: still,
        deadlineMs,
      });
      return fake.requests.map((r) => r.use);
    };
    expect(await pass(MIN_REQUEST_MS - 1)).toEqual([]);
    // The runner counts its own wall time from the call's start (the
    // preparation counts), so a share of exactly the minimum may come out
    // a millisecond short; the exact boundary is `mayStartRequest`'s test.
    expect(await pass(MIN_REQUEST_MS * 2)).toEqual(["human_readable"]);
  });
});
