/**
 * The minimum request time in the hook uses (design D20): `head_select`
 * and `neighbour_relevant` start no request when less than
 * `MIN_REQUEST_MS` of the hook budget is left, and keep the
 * deterministic fallback.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runHeadSelect } from "../../../src/core/agent-context/head-select.ts";
import { runNeighbourRelevant } from "../../../src/core/agent-context/neighbour-relevant.ts";
import { resolveDecisionModelConfig } from "../../../src/core/decision-model/config.ts";
import { MIN_REQUEST_MS } from "../../../src/core/decision-model/request-floor.ts";
import { foldTopics, type TopicState } from "../../../src/core/topics/fold.ts";
import type { StoreRecord } from "../../../src/core/store/envelope.ts";
import { formatHlc } from "../../../src/core/store/hlc.ts";
import { FAKE_DECISION_KEY } from "../../helpers/fake-credentials.ts";
import { FakeDecisionProvider } from "../../helpers/fake-decision-provider.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const TOPIC = "01KA0000000000000000000001";

function config(uses: string, hookBudgetMs?: number) {
  const vault = mkdtempSync(join(tmpdir(), "osb-floor-hooks-"));
  mkdirSync(join(vault, "Brain"), { recursive: true });
  dirs.push(vault);
  return resolveDecisionModelConfig({
    env: { O2B_TEST_FLOOR_KEY: FAKE_DECISION_KEY } as NodeJS.ProcessEnv,
    config: {
      decision_model_enabled: "true",
      decision_model_provider: "compatible",
      decision_model_base_url: "https://decide.invalid/v1",
      decision_model_id: "floor-model",
      decision_model_env_key: "O2B_TEST_FLOOR_KEY",
      decision_model_uses: uses,
      ...(hookBudgetMs !== undefined
        ? { decision_model_hook_budget_ms: String(hookBudgetMs) }
        : {}),
    },
    vault,
    thresholdsPath: null,
  });
}

function head(): TopicState {
  const record = {
    v: 1,
    id: "rec-1",
    hlc: formatHlc({ physical: Date.UTC(2026, 11, 1), counter: 0 }),
    device: "dev-a",
    agent: "seed",
    kind: "topic-create",
    scope: "project:o2b",
    topic: TOPIC,
    sum: "0".repeat(64),
    body: { authority: "agent", title: "Shard writer", scope: "project:o2b" },
  } as unknown as StoreRecord;
  return foldTopics([record]).topics.get(TOPIC)!;
}

describe("the minimum request time in the hook uses", () => {
  test("head_select starts a request with the minimum left and none with less", async () => {
    const cfg = config("head_select:shadow");
    const enough = new FakeDecisionProvider({});
    await runHeadSelect({
      config: cfg,
      heads: [head()],
      request: { project: "o2b", branch: null },
      remainingMs: MIN_REQUEST_MS,
      provider: enough,
    });
    expect(enough.requests).toHaveLength(1);
    const short = new FakeDecisionProvider({});
    const out = await runHeadSelect({
      config: cfg,
      heads: [head()],
      request: { project: "o2b", branch: null },
      remainingMs: MIN_REQUEST_MS - 1,
      provider: short,
    });
    expect(short.requests).toEqual([]);
    expect(out.applied).toBe(false);
  });

  test("neighbour_relevant starts no request with less than the minimum left", async () => {
    const cfg = config("neighbour_relevant:shadow");
    const candidate = {
      record: "rec-2",
      kind: "log-entry",
      topic: TOPIC,
      topicTitle: "Shard writer",
      text: "The shard writer refactor landed",
      seq: 1,
      device: "dev-a",
      agent: "seed",
      private: false,
      titlePrivate: false,
    };
    const enough = new FakeDecisionProvider({});
    await runNeighbourRelevant({
      config: cfg,
      candidates: [candidate],
      prompt: "what changed in the shard writer",
      remainingMs: MIN_REQUEST_MS,
      provider: enough,
    });
    expect(enough.requests).toHaveLength(1);
    const short = new FakeDecisionProvider({});
    const out = await runNeighbourRelevant({
      config: cfg,
      candidates: [candidate],
      prompt: "what changed in the shard writer",
      remainingMs: MIN_REQUEST_MS - 1,
      provider: short,
    });
    expect(short.requests).toEqual([]);
    expect(out.applied).toBe(false);
  });

  test("a hook budget below the minimum starts no request, however much hook time is left", async () => {
    const heads = new FakeDecisionProvider({});
    const selected = await runHeadSelect({
      config: config("head_select:shadow", MIN_REQUEST_MS - 1),
      heads: [head()],
      request: { project: "o2b", branch: null },
      remainingMs: 10_000,
      provider: heads,
    });
    expect(heads.requests).toEqual([]);
    expect(selected.applied).toBe(false);
    const neighbours = new FakeDecisionProvider({});
    await runNeighbourRelevant({
      config: config("neighbour_relevant:shadow", MIN_REQUEST_MS - 1),
      candidates: [
        {
          record: "rec-2",
          kind: "log-entry",
          topic: TOPIC,
          topicTitle: "Shard writer",
          text: "The shard writer refactor landed",
          seq: 1,
          device: "dev-a",
          agent: "seed",
          private: false,
          titlePrivate: false,
        },
      ],
      prompt: "what changed in the shard writer",
      remainingMs: 10_000,
      provider: neighbours,
    });
    expect(neighbours.requests).toEqual([]);
  });
});
