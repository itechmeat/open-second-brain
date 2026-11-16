/**
 * Every per-pass cap of the decide pass counts only what the egress rule
 * lets leave the machine (design D20): a private subject a hosted
 * provider may not see is skipped before the cap, so a queue of newer
 * private records, topics or groups never keeps a shareable one from
 * being asked. One test per cap, each with more private subjects than
 * the cap ahead of one shareable subject. Fake provider, no HTTP, a
 * clock that does not advance on read.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { TOPIC_DECISION_LIMITS } from "../../../src/core/decision-model/questions-topics.ts";
import { appendRecord } from "../../../src/core/store/appender.ts";
import type { StoreHandle } from "../../../src/core/store/store-open.ts";
import { newUlid } from "../../../src/core/store/ulid.ts";
import {
  TOPIC_ASSIGN_KIND,
  TOPIC_CREATE_KIND,
  TOPIC_MILESTONE_KIND,
  TOPIC_QUESTION_KIND,
} from "../../../src/core/topics/constants.ts";
import { decideTopicPlan } from "../../../src/core/topics/decide.ts";
import { claimSettled, claimViewWriter, readViewWriter } from "../../../src/core/view/writer.ts";
import { FAKE_DECISION_KEY } from "../../helpers/fake-credentials.ts";
import { FakeDecisionProvider } from "../../helpers/fake-decision-provider.ts";
import { makeMachines, type Machines } from "../view/fixtures/machines.ts";

type Partition = "shared" | "private";

const T0 = Date.UTC(2026, 11, 1, 9, 0, 0);
let clock = T0;
const tick = (): number => (clock += 1000);
const still = (): number => clock;

let m: Machines;
let a: StoreHandle;
let configPath: string;
let seq = 0;

beforeEach(() => {
  clock = T0;
  m = makeMachines(["dev-a"], "o2b-decide-cap-");
  a = m.open("dev-a");
  claimViewWriter(a, { agent: "dream", now: tick });
  claimSettled(a, readViewWriter(a, tick));
  const tmp = mkdtempSync(join(m.parent, "cfg-"));
  const vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  process.env["VAULT_DIR"] = vault;
  configPath = join(tmp, "config.yaml");
  writeFileSync(configPath, "");
});

afterEach(() => {
  delete process.env["VAULT_DIR"];
  m.cleanup();
});

function topicRecord(
  kind: string,
  topic: string,
  body: Record<string, unknown>,
  partition: Partition = "shared",
): void {
  appendRecord(
    a,
    {
      partition,
      stream: "topics",
      kind,
      agent: "seed",
      topic,
      body: { authority: "agent", ...body },
    },
    { now: tick },
  );
}

function seedTopic(title: string, partition: Partition = "shared"): string {
  const topic = newUlid(tick());
  topicRecord(TOPIC_CREATE_KIND, topic, { title, scope: "project:o2b" }, partition);
  return topic;
}

function signal(text: string, partition: Partition, project = "o2b", session = "s1"): string {
  seq += 1;
  return appendRecord(
    a,
    {
      partition,
      stream: "events",
      kind: "signal",
      agent: "agent-1",
      body: {
        id: `sig-2026-12-01-c${seq}`,
        path: `Brain/inbox/c${seq}.md`,
        staged: false,
        frontmatter: { principle: text, project, session },
        raw: null,
        raw_shape: "bare",
      },
    },
    { now: tick },
  ).record.id;
}

function held(topic: string, text: string, partition: Partition): void {
  topicRecord(TOPIC_ASSIGN_KIND, topic, { record: signal(text, partition) }, partition);
}

/** A hosted provider: private records of the use may not go there. */
function envFor(use: string): Record<string, string | undefined> {
  return {
    OPEN_SECOND_BRAIN_DECISION_MODEL_ENABLED: "true",
    OPEN_SECOND_BRAIN_DECISION_MODEL_PROVIDER: "compatible",
    OPEN_SECOND_BRAIN_DECISION_MODEL_BASE_URL: "https://decide.invalid/v1",
    OPEN_SECOND_BRAIN_DECISION_MODEL_ID: "decide-model",
    OPEN_SECOND_BRAIN_DECISION_MODEL_ENV_KEY: "O2B_TEST_DECIDE_KEY",
    OPEN_SECOND_BRAIN_DECISION_MODEL_USES: `${use}:shadow`,
    O2B_TEST_DECIDE_KEY: FAKE_DECISION_KEY,
    OPEN_SECOND_BRAIN_CONFIG: configPath,
  };
}

async function sentFor(use: string): Promise<string> {
  const fake = new FakeDecisionProvider({});
  await decideTopicPlan(a, { provider: fake, env: envFor(use), now: still });
  return JSON.stringify(fake.requests);
}

const PASS_CAP = TOPIC_DECISION_LIMITS.recordsPerPass;

/** Five near-identical signals of one project: one `topic_new` group. */
function signalGroup(project: string, partition: Partition, tag: string): void {
  for (let i = 0; i < 5; i++) {
    signal(`${tag} deprecation windows for the public API ${i}`, partition, project, `s${i % 2}`);
  }
}

describe("a per-pass cap counts only what may leave the machine", () => {
  test("event_kind: newer private records do not fill the cap ahead of a shared one", async () => {
    const topic = seedTopic("Shard compaction keeps monthly shard files small");
    held(topic, "SHARED-ONE shard compaction window decided", "shared");
    for (let i = 0; i < PASS_CAP; i++) held(topic, `Private compaction note ${i}`, "private");
    expect(await sentFor("event_kind")).toContain("SHARED-ONE");
  });

  test("topic_route: newer private records do not fill the cap ahead of a shared one", async () => {
    seedTopic("Shard compaction keeps monthly shard files small");
    signal("SHARED-ONE shard compaction thresholds were tuned", "shared");
    for (let i = 0; i < PASS_CAP; i++) {
      signal(`Private shard compaction thresholds note ${i}`, "private");
    }
    expect(await sentFor("topic_route")).toContain("SHARED-ONE");
  });

  test("topic_route: private topics do not fill the options ahead of a shared one", async () => {
    // The shared topic ranks last: the private ones share more words.
    seedTopic("Shard compaction notes");
    for (let i = 0; i < TOPIC_DECISION_LIMITS.topicOptionsPerQuestion; i++) {
      seedTopic(`Shard compaction thresholds tuned nightly ${i}`, "private");
    }
    signal("Shard compaction thresholds were tuned nightly", "shared");
    const sent = await sentFor("topic_route");
    expect(sent).toContain("Shard compaction notes");
  });

  test("question_resolved: newer private records do not fill the cap ahead of a shared one", async () => {
    const topic = seedTopic("Shard compaction keeps monthly shard files small");
    topicRecord(TOPIC_QUESTION_KIND, topic, {
      item: "q-window",
      text: "Which compaction window ships first",
    });
    held(topic, "SHARED-ONE compaction window answered: the nightly one", "shared");
    for (let i = 0; i < PASS_CAP; i++) held(topic, `Private compaction answer ${i}`, "private");
    expect(await sentFor("question_resolved")).toContain("SHARED-ONE");
  });

  test("milestone_done: newer private evidence does not fill the shown slots", async () => {
    const topic = seedTopic("Shard compaction keeps monthly shard files small");
    topicRecord(TOPIC_MILESTONE_KIND, topic, {
      item: "m-window",
      text: "Ship the first compaction window",
    });
    held(topic, "SHARED-ONE compaction window shipped", "shared");
    for (let i = 0; i < 5; i++) held(topic, `Private compaction evidence ${i}`, "private");
    expect(await sentFor("milestone_done")).toContain("SHARED-ONE");
  });

  test("topic_new: all-private groups do not fill the group cap ahead of a shared one", async () => {
    for (let g = 0; g < TOPIC_DECISION_LIMITS.groupsPerPass; g++) {
      signalGroup(`a${String(g).padStart(2, "0")}`, "private", "Private");
    }
    // Projects plan in name order: this group comes after every private one.
    signalGroup("zz", "shared", "SHARED-ONE");
    expect(await sentFor("topic_new")).toContain("SHARED-ONE");
  });

  test("topic_new: private members do not fill the shown slots ahead of shared ones", async () => {
    // Members are shown oldest first: the private ones come first here.
    for (let i = 0; i < TOPIC_DECISION_LIMITS.groupMembersShown; i++) {
      signal(`Private deprecation windows for the public API ${i}`, "private", "o2b", `s${i % 2}`);
    }
    for (let i = 0; i < 2; i++) {
      signal(`SHARED-ONE deprecation windows for the public API ${i}`, "shared", "o2b", `s${i}`);
    }
    expect(await sentFor("topic_new")).toContain("SHARED-ONE");
  });

  test("topic_same: private topic pairs do not fill the pair cap ahead of a shared one", async () => {
    for (let p = 0; p < TOPIC_DECISION_LIMITS.pairsPerPass; p++) {
      // Identical private titles: the best-scoring pairs.
      const title = `Workstream${p} rollout${p} planning${p}`;
      seedTopic(title, "private");
      seedTopic(title, "private");
    }
    seedTopic("SHARED-ONE shard compaction monthly files");
    seedTopic("SHARED-ONE shard compaction weekly files");
    expect(await sentFor("topic_same")).toContain("SHARED-ONE");
  });
});
