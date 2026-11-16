/**
 * `head_select` with a withheld head (design D20 item 2): the questions
 * are built for the masks actually in the state, and the recorded
 * probabilities line up with `topic_ids`, null where a head was not asked.
 * Under `enforce` a head the model did not judge (an invalid answer)
 * keeps its fallback place after the scored ones and is not counted as
 * dropped.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runHeadSelect } from "../../../src/core/agent-context/head-select.ts";
import { resolveDecisionModelConfig } from "../../../src/core/decision-model/config.ts";
import {
  decisionThresholdsPath,
  resetThresholdsStoreCache,
  writeThresholdEntry,
} from "../../../src/core/decision-model/thresholds.ts";
import { listDecisionModelCalls } from "../../../src/core/decision-model/record.ts";
import { TOPIC_DECISION_LIMITS } from "../../../src/core/decision-model/questions-topics.ts";
import { foldTopics, type TopicState } from "../../../src/core/topics/fold.ts";
import type { StoreRecord } from "../../../src/core/store/envelope.ts";
import { formatHlc } from "../../../src/core/store/hlc.ts";
import { FAKE_DECISION_KEY } from "../../helpers/fake-credentials.ts";
import { FakeDecisionProvider } from "../../helpers/fake-decision-provider.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function create(id: string, title: string, at: number): StoreRecord {
  return {
    v: 1,
    id: `rec-${id}`,
    hlc: formatHlc({ physical: at, counter: 0 }),
    device: "dev-a",
    agent: "seed",
    kind: "topic-create",
    scope: "project:o2b",
    topic: id,
    sum: "0".repeat(64),
    body: { authority: "agent", title, scope: "project:o2b" },
  } as unknown as StoreRecord;
}

describe("head_select masks", () => {
  test("a withheld head gets no question and a null probability beside its withheld id", async () => {
    const vault = mkdtempSync(join(tmpdir(), "osb-head-masks-"));
    mkdirSync(join(vault, "Brain"), { recursive: true });
    dirs.push(vault);
    const ids = [
      "01KA0000000000000000000001",
      "01KA0000000000000000000002",
      "01KA0000000000000000000003",
    ];
    const records = ids.map((id, i) => create(id, `Topic ${i}`, Date.UTC(2026, 11, 1) + i));
    // The first topic's create sits in `private`.
    const fold = foldTopics(records, { privateIds: new Set([records[0]!.id]) });
    const heads = ids.map((id) => fold.topics.get(id)!) as TopicState[];
    expect(heads[0]!.private).toBe(true);
    const cfg = resolveDecisionModelConfig({
      env: { O2B_TEST_HEADS_KEY: FAKE_DECISION_KEY } as NodeJS.ProcessEnv,
      config: {
        decision_model_enabled: "true",
        decision_model_provider: "compatible",
        decision_model_base_url: "https://decide.invalid/v1",
        decision_model_id: "head-model",
        decision_model_env_key: "O2B_TEST_HEADS_KEY",
        decision_model_uses: "head_select:shadow",
      },
      vault,
      thresholdsPath: null,
    });
    const provider = new FakeDecisionProvider({
      answer: (id) => (id === "relevant_0" ? 0.9 : 0.2),
    });
    await runHeadSelect({
      config: cfg,
      heads,
      request: { project: "o2b", branch: null },
      remainingMs: 5000,
      provider,
    });
    expect(provider.requests).toHaveLength(1);
    expect(Object.keys(provider.requests[0]!.questions).toSorted()).toEqual([
      "relevant_0",
      "relevant_1",
    ]);
    const call = listDecisionModelCalls(vault)[0]!.payload;
    expect(call["topic_ids"]).toEqual(["(withheld)", ids[1], ids[2]]);
    // relevant_0 asked about the first included head (Topic 1), not the withheld one.
    expect(call["probabilities"]).toEqual([null, 0.9, 0.2]);
  });

  test("under enforce a head with an invalid answer keeps its fallback place and is not dropped", async () => {
    const vault = mkdtempSync(join(tmpdir(), "osb-head-invalid-"));
    mkdirSync(join(vault, "Brain"), { recursive: true });
    dirs.push(vault);
    const ids = [
      "01KA0000000000000000000001",
      "01KA0000000000000000000002",
      "01KA0000000000000000000003",
    ];
    const records = ids.map((id, i) => create(id, `Topic ${i}`, Date.UTC(2026, 11, 1) + i));
    const fold = foldTopics(records, { privateIds: new Set() });
    const heads = ids.map((id) => fold.topics.get(id)!) as TopicState[];
    const thresholdsPath = decisionThresholdsPath(join(vault, "config.yaml"));
    writeThresholdEntry(thresholdsPath, "head-model", "head_select", {
      values: { drop_below: 0.3 },
      source: "set",
    });
    resetThresholdsStoreCache();
    const cfg = resolveDecisionModelConfig({
      env: { O2B_TEST_HEADS_KEY: FAKE_DECISION_KEY } as NodeJS.ProcessEnv,
      config: {
        decision_model_enabled: "true",
        decision_model_provider: "compatible",
        decision_model_base_url: "https://decide.invalid/v1",
        decision_model_id: "head-model",
        decision_model_env_key: "O2B_TEST_HEADS_KEY",
        decision_model_uses: "head_select:enforce",
      },
      vault,
      thresholdsPath,
    });
    // Topic 0 gets an invalid answer, Topic 1 is below the threshold,
    // Topic 2 is relevant.
    const provider = new FakeDecisionProvider({
      model: "head-model",
      answer: (id) => (id === "relevant_0" ? { invalid: true } : id === "relevant_1" ? 0.1 : 0.9),
    });
    const outcome = await runHeadSelect({
      config: cfg,
      heads,
      request: { project: "o2b", branch: null },
      remainingMs: 5000,
      provider,
    });
    resetThresholdsStoreCache();
    expect(outcome.applied).toBe(true);
    expect(outcome.heads.map((t) => t.id)).toEqual([ids[2]!, ids[0]!]);
    expect(outcome.droppedBelow).toBe(1);
  });

  test("withheld heads take no slot of the per-request cap", async () => {
    const vault = mkdtempSync(join(tmpdir(), "osb-head-cap-"));
    mkdirSync(join(vault, "Brain"), { recursive: true });
    dirs.push(vault);
    const cap = TOPIC_DECISION_LIMITS.headsPerRequest;
    // `cap` private heads first, the one shared head after them.
    const ids = Array.from({ length: cap + 1 }, (_, i) => `01KA${String(i).padStart(22, "0")}`);
    const records = ids.map((id, i) =>
      create(id, i === cap ? "SHARED-ONE head" : `Private head ${i}`, Date.UTC(2026, 11, 1) + i),
    );
    const fold = foldTopics(records, {
      privateIds: new Set(records.slice(0, cap).map((r) => r.id)),
    });
    const heads = ids.map((id) => fold.topics.get(id)!) as TopicState[];
    const cfg = resolveDecisionModelConfig({
      env: { O2B_TEST_HEADS_KEY: FAKE_DECISION_KEY } as NodeJS.ProcessEnv,
      config: {
        decision_model_enabled: "true",
        decision_model_provider: "compatible",
        decision_model_base_url: "https://decide.invalid/v1",
        decision_model_id: "head-model",
        decision_model_env_key: "O2B_TEST_HEADS_KEY",
        decision_model_uses: "head_select:shadow",
      },
      vault,
      thresholdsPath: null,
    });
    const provider = new FakeDecisionProvider({});
    await runHeadSelect({
      config: cfg,
      heads,
      request: { project: "o2b", branch: null },
      remainingMs: 5000,
      provider,
    });
    expect(provider.requests).toHaveLength(1);
    expect(JSON.stringify(provider.requests[0]!.state)).toContain("SHARED-ONE");
  });
});
