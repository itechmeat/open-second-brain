/**
 * `topic_same` as queue items, one per pair (change
 * `dream-closed-questions`; was the decide pass, task 4.1, design D10):
 * the Jaccard proposals are proposals only and stand whatever the model
 * says; `off` and `shadow` add nothing and the items wait; an enforced
 * `same` at or above `same_min` adds the model-only pairs with their
 * verdict and a `different` lists the Jaccard proposal last with its
 * verdict, never removed; nothing is ever merged. Below the threshold the
 * item abstains, on a timeout it waits; the proposals stand either way.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { listDecisionModelCalls } from "../../../src/core/decision-model/record.ts";
import {
  resetThresholdsStoreCache,
  writeThresholdEntry,
  decisionThresholdsPath,
} from "../../../src/core/decision-model/thresholds.ts";
import { appendRecord } from "../../../src/core/store/appender.ts";
import { readPartition } from "../../../src/core/store/state-digest.ts";
import { TOPIC_MERGE_KIND } from "../../../src/core/topics/constants.ts";
import { foldTopics } from "../../../src/core/topics/fold.ts";
import { topicPairsForSame } from "../../../src/core/topics/plan.ts";
import {
  describeTopicPlanning,
  type TopicPlanningReport,
} from "../../../src/core/topics/planning.ts";
import { FakeDecisionProvider, startFakeSystemOne } from "../../helpers/fake-decision-provider.ts";
import { closedFixture, type ClosedFixture } from "./fixtures/closed-fixture.ts";
import { ask, plan } from "./fixtures/closed-run.ts";

let f: ClosedFixture;

beforeEach(() => {
  f = closedFixture();
});

afterEach(() => {
  f.cleanup();
});

/** Two topics the Jaccard rule already proposes, and one only the model may add. */
function seedPairAndBand(): { a: string; b: string; c: string } {
  const first = f.seedTopic("Deprecation windows for the public API");
  const second = f.seedTopic("Deprecation windows announced for the API");
  const third = f.seedTopic("Deprecation windows roadmap and kickoff");
  return { a: first, b: second, c: third };
}

function pair(choice: string, probability = 0.9, extra: { model?: string; fail?: "timeout" } = {}) {
  return new FakeDecisionProvider({
    answer: (id) => (id.startsWith("pair_") ? choice : undefined),
    probability,
    ...extra,
  });
}

function mergeRecords(): number {
  return readPartition(join(f.m.root("dev-a"), "shared"))
    .flatMap((s) => s.records)
    .filter((r) => r.kind === "merge").length;
}

function mergePairsOf(report: TopicPlanningReport): string[] {
  if (report.status !== "planned") return [];
  return report.merges.map((proposal) =>
    [proposal.topics[0], proposal.topics[1]].toSorted().join("|"),
  );
}

describe("topic_same on the queue", () => {
  test("off sends nothing and the report keeps the Jaccard proposals", async () => {
    const { a: ta, b: tb } = seedPairAndBand();
    const fake = pair("same");
    await ask(f, "topic_same:off", fake);
    expect(fake.requests).toEqual([]);
    expect(listDecisionModelCalls(f.vault)).toEqual([]);
    const report = plan(f);
    expect(mergePairsOf(report)).toEqual([[ta, tb].toSorted().join("|")]);
    expect(report.status === "planned" ? report.merges[0]!.verdict : null).toBeUndefined();
    expect(describeTopicPlanning(report as never)).not.toContain("decision model");
    expect(mergeRecords()).toBe(0);
  });

  test("shadow asks about each pair, records the calls, and the proposals stand", async () => {
    const { a: ta, b: tb } = seedPairAndBand();
    const fake = pair("same", 0.9, { model: "shadow-model-5" });
    await ask(f, "topic_same:shadow", fake);
    const asked = f.items("topic-same").length;
    expect(asked).toBeGreaterThan(0);
    expect(fake.requests).toHaveLength(asked);
    expect(fake.requests.every((r) => r.use === "topic_same")).toBe(true);
    const calls = listDecisionModelCalls(f.vault);
    expect(calls).toHaveLength(asked);
    expect(calls.every((c) => c.payload["mode"] === "shadow")).toBe(true);
    const report = plan(f);
    expect(mergePairsOf(report)).toEqual([[ta, tb].toSorted().join("|")]);
    expect(mergeRecords()).toBe(0);
  });

  test("enforce same adds the model-only pairs with their confidence", async () => {
    seedPairAndBand();
    f.tune("topic_same", { same_min: 0.7 });
    await ask(f, "topic_same:enforce", pair("same", 0.9, { model: "same-model-1" }));
    expect(f.items("topic-same")).toHaveLength(3);
    const report = plan(f);
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
  });

  test("a model-only pair whose topic was merged before planning is not proposed", async () => {
    const { b: tb, c: tc } = seedPairAndBand();
    f.tune("topic_same", { same_min: 0.7 });
    await ask(f, "topic_same:enforce", pair("same"));
    expect(f.items("topic-same")).toHaveLength(3);
    // Between the answers and planning, the third topic is merged away.
    appendRecord(
      f.a,
      {
        partition: "shared",
        stream: "topics",
        kind: TOPIC_MERGE_KIND,
        agent: "seed",
        topic: tc,
        body: { authority: "human", into: tb },
      },
      { now: f.now },
    );
    const report = plan(f);
    expect(report.status).toBe("planned");
    expect(mergePairsOf(report).some((p) => p.includes(tc))).toBe(false);
  });

  test("enforce different lists the Jaccard proposal last with the verdict, never removed", async () => {
    const { a: ta, b: tb } = seedPairAndBand();
    f.tune("topic_same", { same_min: 0.7 });
    await ask(f, "topic_same:enforce", pair("different", 0.9, { model: "diff-model-2" }));
    const report = plan(f);
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
    f.tune("topic_same", { same_min: 0.7 });
    await ask(f, "topic_same:enforce", pair("same", 0.9, { fail: "timeout" }));
    for (const item of f.items("topic-same")) expect(item.attempts).toBe(1);
    expect(mergePairsOf(plan(f))).toEqual([[ta, tb].toSorted().join("|")]);
    // After the retry time, answers below the threshold abstain.
    const retry = Math.max(...f.items("topic-same").map((i) => Date.parse(i.retry_at!)));
    f.setClock(retry + 1000);
    await ask(f, "topic_same:enforce", pair("same", 0.5));
    const report = plan(f);
    expect(report.status === "planned" && report.abstained).toBe(3);
    expect(mergePairsOf(report)).toEqual([[ta, tb].toSorted().join("|")]);
    expect(mergeRecords()).toBe(0);
  });
});

describe("the pairs topic_same is asked about", () => {
  test("the best-scoring pairs go first when more pairs qualify than one pass asks", () => {
    f.seedTopic("Shard compaction garden watering beds");
    const b = f.seedTopic("Shard compaction window monthly ledger");
    const c = f.seedTopic("Shard compaction window monthly files");
    const records = readPartition(join(f.m.root("dev-a"), "shared")).flatMap((sh) => sh.records);
    const pairs = topicPairsForSame(foldTopics(records), 0.1, 1);
    expect(pairs.map((p) => [p.a, p.b])).toEqual([[b, c]]);
  });
});

describe("same_min from the thresholds store", () => {
  test("a stored same_min above the answer decides, not the built-in default", async () => {
    seedPairAndBand();
    f.tune("topic_same", { same_min: 0.95 });
    await ask(f, "topic_same:enforce", pair("same"));
    // The built-in 0.7 would accept 0.9; the stored 0.95 decides.
    const report = plan(f);
    expect(
      report.status === "planned" && report.merges.filter((m) => m.verdict !== undefined),
    ).toEqual([]);
  });
});

/** A dead first entry and a live fallback that answers `same` at 0.9. */
async function chainPass(tuneFallback: boolean) {
  seedPairAndBand();
  f.tune("topic_same", { same_min: 0.7 });
  if (tuneFallback) {
    writeThresholdEntry(decisionThresholdsPath(f.configPath), "fallback-model", "topic_same", {
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
    f.configPath,
    [
      `store_root: ${f.m.root("dev-a")}`,
      "device_id: dev-a",
      "decision_model_providers_typesafe_base_url: " + server.url,
      "decision_model_providers_typesafe_id: fallback-model",
      "decision_model_providers_typesafe_env_key: O2B_TEST_DECIDE_KEY",
      "",
    ].join("\n"),
  );
  try {
    await ask(f, "topic_same:enforce", undefined, {
      OPEN_SECOND_BRAIN_DECISION_MODEL_PROVIDER: undefined,
      OPEN_SECOND_BRAIN_DECISION_MODEL_PROVIDERS: "compatible,typesafe",
      OPEN_SECOND_BRAIN_DECISION_MODEL_BASE_URL: "http://127.0.0.1:1",
    });
    const report = plan(f);
    if (report.status !== "planned") throw new Error(report.status);
    return report.merges.filter((m) => m.verdict !== undefined);
  } finally {
    await server.close();
  }
}

describe("topic_same through a chain whose fallback answers", () => {
  test("a fallback without tuned thresholds answers as shadow, so nothing acts", async () => {
    expect(await chainPass(false)).toEqual([]);
  });

  test("a fallback in enforce acts and the verdict names it as the provider", async () => {
    const judged = await chainPass(true);
    expect(judged.length).toBeGreaterThan(0);
    expect(judged.every((m) => m.verdict!.provider === "typesafe")).toBe(true);
  });
});
