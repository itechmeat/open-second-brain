/**
 * `topic_same` in the decide pass (task 4.1, design D10): `off` sends
 * nothing; `shadow` records without effect; `enforce` `same` adds the
 * pair to the report's merge proposals with its confidence, `different`
 * moves a Jaccard proposal last with its verdict and never removes it;
 * nothing is ever merged; on a failure today's proposals stand.
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
import { listDecisionModelCalls } from "../../../src/core/decision-model/record.ts";
import { newUlid } from "../../../src/core/store/ulid.ts";
import { readPartition } from "../../../src/core/store/state-digest.ts";
import type { StoreHandle } from "../../../src/core/store/store-open.ts";
import { TOPIC_CREATE_KIND, TOPIC_MERGE_KIND } from "../../../src/core/topics/constants.ts";
import { decideTopicPlan } from "../../../src/core/topics/decide.ts";
import { foldTopics } from "../../../src/core/topics/fold.ts";
import { topicPairsForSame } from "../../../src/core/topics/plan.ts";
import { describeTopicPlanning, runTopicPlanning } from "../../../src/core/topics/planning.ts";
import { claimSettled, claimViewWriter, readViewWriter } from "../../../src/core/view/writer.ts";
import { makeMachines, type Machines } from "../view/fixtures/machines.ts";
import { FAKE_DECISION_KEY } from "../../helpers/fake-credentials.ts";
import { FakeDecisionProvider, startFakeSystemOne } from "../../helpers/fake-decision-provider.ts";

const T0 = Date.UTC(2026, 11, 1, 9, 0, 0);
let clock = T0;
const now = () => (clock += 1000);
/** Does not advance on read: the decide pass's budget clock. */
const still = (): number => clock;

let m: Machines;
let a: StoreHandle;
let tmp: string;
let vault: string;
let configPath: string;

beforeEach(() => {
  clock = T0;
  m = makeMachines(["dev-a"], "o2b-decide-same-");
  a = m.open("dev-a");
  claimViewWriter(a, { agent: "dream", now });
  claimSettled(a, readViewWriter(a, now));
  tmp = mkdtempSync(join(m.parent, "cfg-"));
  vault = join(tmp, "vault");
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

/** Two topics the Jaccard rule already proposes, and one only the model may add. */
function seedPairAndBand(): { a: string; b: string; c: string } {
  const first = seedTopic("Deprecation windows for the public API");
  const second = seedTopic("Deprecation windows announced for the API");
  const third = seedTopic("Deprecation windows roadmap and kickoff");
  return { a: first, b: second, c: third };
}

function envFor(mode: string): Record<string, string | undefined> {
  return {
    OPEN_SECOND_BRAIN_DECISION_MODEL_ENABLED: "true",
    OPEN_SECOND_BRAIN_DECISION_MODEL_PROVIDER: "compatible",
    OPEN_SECOND_BRAIN_DECISION_MODEL_BASE_URL: "https://decide.invalid/v1",
    OPEN_SECOND_BRAIN_DECISION_MODEL_ID: "decide-model",
    OPEN_SECOND_BRAIN_DECISION_MODEL_ENV_KEY: "O2B_TEST_DECIDE_KEY",
    OPEN_SECOND_BRAIN_DECISION_MODEL_USES: `topic_same:${mode}`,
    O2B_TEST_DECIDE_KEY: FAKE_DECISION_KEY,
    OPEN_SECOND_BRAIN_CONFIG: configPath,
  };
}

function tuneForEnforce(value = 0.7): void {
  writeThresholdEntry(decisionThresholdsPath(configPath), "decide-model", "topic_same", {
    values: { same_min: value },
    source: "set",
  });
  resetThresholdsStoreCache();
}

function mergeRecords(): number {
  return readPartition(join(m.root("dev-a"), "shared"))
    .flatMap((s) => s.records)
    .filter((r) => r.kind === "merge").length;
}

function mergePairsOf(report: ReturnType<typeof runTopicPlanning>): string[] {
  if (report.status !== "planned") return [];
  return report.merges.map((proposal) =>
    [proposal.topics[0], proposal.topics[1]].toSorted().join("|"),
  );
}

describe("topic_same in the decide pass", () => {
  test("off sends nothing and the report keeps the Jaccard proposals", async () => {
    const { a: ta, b: tb } = seedPairAndBand();
    const fake = new FakeDecisionProvider({
      answer: (id) => (id.startsWith("pair_") ? "same" : undefined),
      probability: 0.9,
    });
    const verdicts = await decideTopicPlan(a, { provider: fake, env: envFor("off"), now: still });
    expect(verdicts.sameTopics).toEqual([]);
    expect(fake.requests).toEqual([]);
    expect(listDecisionModelCalls(vault)).toEqual([]);
    const report = runTopicPlanning(a, { agent: "dream", now, topicVerdicts: verdicts });
    expect(mergePairsOf(report)).toEqual([[ta, tb].toSorted().join("|")]);
    expect(report.status === "planned" ? report.merges[0]!.verdict : null).toBeUndefined();
    expect(describeTopicPlanning(report as never)).not.toContain("decision model");
    expect(mergeRecords()).toBe(0);
  });

  test("shadow asks about the pairs, records the call, and the proposals stand", async () => {
    seedPairAndBand();
    const fake = new FakeDecisionProvider({
      answer: (id) => (id.startsWith("pair_") ? "same" : undefined),
      probability: 0.9,
      model: "shadow-model-5",
    });
    const verdicts = await decideTopicPlan(a, {
      provider: fake,
      env: envFor("shadow"),
      now: still,
    });
    expect(verdicts.sameTopics).toEqual([]);
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]!.use).toBe("topic_same");
    const calls = listDecisionModelCalls(vault);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.payload["mode"]).toBe("shadow");
    const report = runTopicPlanning(a, { agent: "dream", now, topicVerdicts: verdicts });
    expect(mergeRecords()).toBe(0);
    void report;
  });

  test("enforce same adds the model-only pairs with their confidence", async () => {
    const { a: ta, c: tc } = seedPairAndBand();
    tuneForEnforce();
    const fake = new FakeDecisionProvider({
      answer: (id) => (id.startsWith("pair_") ? "same" : undefined),
      probability: 0.9,
      model: "same-model-1",
    });
    const verdicts = await decideTopicPlan(a, {
      provider: fake,
      env: envFor("enforce"),
      now: still,
    });
    expect(verdicts.sameTopics).toHaveLength(3);
    const report = runTopicPlanning(a, { agent: "dream", now, topicVerdicts: verdicts });
    expect(report.status).toBe("planned");
    if (report.status !== "planned") return;
    // The Jaccard proposal keeps its place; the model-only pairs join with verdicts.
    expect(report.merges).toHaveLength(3);
    const annotated = report.merges.filter((merge) => merge.verdict !== undefined);
    expect(annotated).toHaveLength(3);
    expect(annotated.every((entry) => entry.verdict!.confidence === 0.9)).toBe(true);
    const line = describeTopicPlanning(report);
    expect(line).toContain("judged by a decision model");
    expect(line).toContain("0.90");
    // No record of this pass carries a verdict, so the record note is absent.
    expect(line).not.toContain("decided by a decision model");
    expect(mergeRecords()).toBe(0);
    void ta;
    void tc;
  });

  test("a model-only pair whose topic was merged before planning is not proposed", async () => {
    const { b: tb, c: tc } = seedPairAndBand();
    tuneForEnforce();
    const fake = new FakeDecisionProvider({
      answer: (id) => (id.startsWith("pair_") ? "same" : undefined),
      probability: 0.9,
    });
    const verdicts = await decideTopicPlan(a, {
      provider: fake,
      env: envFor("enforce"),
      now: still,
    });
    expect(verdicts.sameTopics).toHaveLength(3);
    // Between the decide pass and planning, the third topic is merged away.
    clock += 1000;
    appendRecord(
      a,
      {
        partition: "shared",
        stream: "topics",
        kind: TOPIC_MERGE_KIND,
        agent: "seed",
        topic: tc,
        body: { authority: "human", into: tb },
      },
      { now },
    );
    const report = runTopicPlanning(a, { agent: "dream", now, topicVerdicts: verdicts });
    expect(report.status).toBe("planned");
    expect(mergePairsOf(report).some((pair) => pair.includes(tc))).toBe(false);
  });

  test("enforce different lists the Jaccard proposal last with the verdict, never removed", async () => {
    const { a: ta, b: tb } = seedPairAndBand();
    tuneForEnforce();
    const fake = new FakeDecisionProvider({
      answer: (id) => (id.startsWith("pair_") ? "different" : undefined),
      probability: 0.9,
      model: "diff-model-2",
    });
    const verdicts = await decideTopicPlan(a, {
      provider: fake,
      env: envFor("enforce"),
      now: still,
    });
    const report = runTopicPlanning(a, { agent: "dream", now, topicVerdicts: verdicts });
    expect(report.status).toBe("planned");
    if (report.status !== "planned") return;
    const pairs = mergePairsOf(report);
    expect(pairs[pairs.length - 1]).toBe([ta, tb].toSorted().join("|"));
    const last = report.merges[report.merges.length - 1]!;
    expect(last.verdict).toMatchObject({
      use: "topic_same",
      model: "diff-model-2",
      mode: "enforce",
    });
    expect(mergeRecords()).toBe(0);
  });

  test("below the threshold and on a timeout today's proposals stand", async () => {
    const { a: ta, b: tb } = seedPairAndBand();
    tuneForEnforce();
    const low = await decideTopicPlan(a, {
      provider: new FakeDecisionProvider({
        answer: (id) => (id.startsWith("pair_") ? "same" : undefined),
        probability: 0.5,
      }),
      env: envFor("enforce"),
      now: still,
    });
    expect(low.sameTopics).toEqual([]);
    const timedOut = await decideTopicPlan(a, {
      provider: new FakeDecisionProvider({
        answer: (id) => (id.startsWith("pair_") ? "same" : undefined),
        probability: 0.9,
        fail: "timeout",
      }),
      env: envFor("enforce"),
      now: still,
    });
    expect(timedOut.sameTopics).toEqual([]);
    const report = runTopicPlanning(a, { agent: "dream", now, topicVerdicts: low });
    expect(mergePairsOf(report)).toEqual([[ta, tb].toSorted().join("|")]);
    expect(mergeRecords()).toBe(0);
  });
});

describe("the pairs topic_same is asked about", () => {
  test("the best-scoring pairs go first when more pairs qualify than one pass asks", () => {
    seedTopic("Shard compaction garden watering beds");
    const b = seedTopic("Shard compaction window monthly ledger");
    const c = seedTopic("Shard compaction window monthly files");
    const records = readPartition(join(m.root("dev-a"), "shared")).flatMap((sh) => sh.records);
    const pairs = topicPairsForSame(foldTopics(records), 0.1, 1);
    expect(pairs.map((p) => [p.a, p.b])).toEqual([[b, c]]);
  });
});

describe("same_min from the thresholds store", () => {
  test("a stored same_min above the answer decides, not the built-in default", async () => {
    seedPairAndBand();
    tuneForEnforce(0.95);
    const fake = new FakeDecisionProvider({
      answer: (id) => (id.startsWith("pair_") ? "same" : undefined),
      probability: 0.9,
    });
    const verdicts = await decideTopicPlan(a, {
      provider: fake,
      env: envFor("enforce"),
      now: still,
    });
    // The built-in 0.7 would accept 0.9; the stored 0.95 decides.
    expect(verdicts.sameTopics).toEqual([]);
  });
});

/** A dead first entry and a live fallback that answers `same` at 0.9. */
async function chainPass(tuneFallback: boolean) {
  seedPairAndBand();
  tuneForEnforce();
  if (tuneFallback) {
    writeThresholdEntry(decisionThresholdsPath(configPath), "fallback-model", "topic_same", {
      values: { same_min: 0.7 },
      source: "set",
    });
    resetThresholdsStoreCache();
  }
  const server = await startFakeSystemOne();
  server.setReply((req) => {
    const questions = req.body["questions"] as Record<string, { type: string }>;
    const answers: Record<string, unknown> = {};
    for (const id of Object.keys(questions)) {
      answers[id] = {
        type: "choice",
        choice: "same",
        probabilities: { same: 0.9, different: 0.1 },
      };
    }
    return {
      json: { model: "fallback-model", answers, usage: { input_tokens: 9, output_tokens: 1 } },
    };
  });
  // The per-entry keys of a chain are machine-config keys.
  writeFileSync(
    configPath,
    [
      "decision_model_providers_typesafe_base_url: " + server.url,
      "decision_model_providers_typesafe_id: fallback-model",
      "decision_model_providers_typesafe_env_key: O2B_TEST_DECIDE_KEY",
      "",
    ].join("\n"),
  );
  try {
    return await decideTopicPlan(a, {
      env: {
        ...envFor("enforce"),
        OPEN_SECOND_BRAIN_DECISION_MODEL_PROVIDER: undefined,
        OPEN_SECOND_BRAIN_DECISION_MODEL_PROVIDERS: "compatible,typesafe",
        OPEN_SECOND_BRAIN_DECISION_MODEL_BASE_URL: "http://127.0.0.1:1",
      },
      configPath,
      // The pass budget runs on this clock and caps each request's real
      // timeout: the seeding clock jumps a second per read, which would
      // spend the share in reads and give the fallback a 1 ms timeout.
      now: () => clock,
    });
  } finally {
    await server.close();
  }
}

describe("topic_same through a chain whose fallback answers", () => {
  test("a fallback without tuned thresholds answers as shadow, so nothing acts", async () => {
    const verdicts = await chainPass(false);
    expect(verdicts.sameTopics).toEqual([]);
  });

  test("a fallback in enforce acts and the verdict names it as the provider", async () => {
    const verdicts = await chainPass(true);
    expect(verdicts.sameTopics.length).toBeGreaterThan(0);
    expect(verdicts.sameTopics.every((e) => e.verdict.provider === "typesafe")).toBe(true);
  });
});
