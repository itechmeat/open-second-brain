/**
 * The neighbour-updates hook (task 4.3): before a turn, the records
 * other devices wrote on topics this session works on or in its project
 * scope, gated deterministically (topic this session works on and kind
 * `decision`), refined by `neighbour_relevant`; own records never
 * return; the first prompt stores the watermark and injects nothing; at
 * most five lines and 800 characters with the cut line; off with the
 * flag and without a store.
 */

import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";

import { CLI_SPAWN_BUDGET_MS } from "../helpers/cli-timeout.ts";
import {
  injected,
  LOCAL_DEVICE,
  NEIGHBOUR_AGENT,
  neighbourHarness,
  REMOTE_DEVICE,
} from "../helpers/neighbour-hook.ts";
import { appendRecord } from "../../src/core/store/appender.ts";
import { newUlid } from "../../src/core/store/ulid.ts";

setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

const h = neighbourHarness("osb-neighbour-");
const runHook = h.runHook;
const hookPayload = h.payload;
const reindex = h.reindex;
const now = h.now;
const seedTopicCreate = (topic: string): void => h.seedTopic(topic);
const decision = (device: string, topic: string | null, text: string, agent?: string): string =>
  h.decision(device, topic, text, agent === undefined ? {} : { agent });
const logEntry = h.logEntry;
const decisionEnv = h.decisionEnv;

describe("neighbour updates before a turn", () => {
  test("a neighbour's decision on this session's topic is injected once", async () => {
    const topic = newUlid(h.clock());
    decision(LOCAL_DEVICE, topic, "the session's own decision");
    await reindex();
    // First prompt: watermark stored, nothing injected.
    const first = await runHook(hookPayload("What is the north bank plan?", "s1"));
    expect(first.exit).toBe(0);
    expect(first.stdout).toBe("");
    // A neighbour decides on the same topic.
    const record = decision(REMOTE_DEVICE, topic, "pick the north bank", NEIGHBOUR_AGENT);
    await reindex();
    const second = await runHook(hookPayload("What is the north bank plan?", "s1"));
    expect(second.exit).toBe(0);
    const context = injected(second.stdout);
    expect(context).not.toBeNull();
    expect(context).toContain("pick the north bank");
    expect(context).toContain(`brain_topic\` action \`show\` topic ${topic}`);
    expect(context).toContain(NEIGHBOUR_AGENT);
    expect(context).not.toContain("the session's own decision");
    // Not again on the following prompt.
    const third = await runHook(hookPayload("And now?", "s1"));
    expect(third.exit).toBe(0);
    expect(third.stdout).toBe("");
    void record;
  });

  test("a routine log entry on an unworked topic of the same project injects nothing", async () => {
    const topicU = newUlid(h.clock());
    decision(LOCAL_DEVICE, topicU, "the session's own decision");
    await reindex();
    await runHook(hookPayload("Work on the session topic.", "s1"));
    logEntry(REMOTE_DEVICE, topicU, "routine progress line", true);
    await reindex();
    const result = await runHook(hookPayload("Work on the session topic.", "s1"));
    expect(result.exit).toBe(0);
    expect(result.stdout).toBe("");
  });

  test("this device and agent's records never return", async () => {
    const topic = newUlid(h.clock());
    decision(LOCAL_DEVICE, topic, "the session's own decision");
    await reindex();
    await runHook(hookPayload("Own work.", "s1"));
    decision(LOCAL_DEVICE, topic, "another own decision");
    await reindex();
    const result = await runHook(hookPayload("Own work.", "s1"));
    expect(result.exit).toBe(0);
    expect(result.stdout).toBe("");
  });

  test("eight neighbour decisions give five lines and the cut line naming three", async () => {
    const topic = newUlid(h.clock());
    decision(LOCAL_DEVICE, topic, "the session's own decision");
    await reindex();
    await runHook(hookPayload("Budget case.", "s1"));
    const texts = ["one", "two", "three", "four", "five", "six", "seven", "eight"];
    for (const text of texts) decision(REMOTE_DEVICE, topic, text, NEIGHBOUR_AGENT);
    await reindex();
    const result = await runHook(hookPayload("Budget case.", "s1"));
    expect(result.exit).toBe(0);
    const context = injected(result.stdout);
    expect(context).not.toBeNull();
    const lines = (context ?? "").split("\n").filter((l) => l.startsWith("- "));
    expect(lines).toHaveLength(5);
    expect(context).toContain("_3 more neighbour updates are not shown.");
    expect(context).toContain(`brain_changes\` since`);
  });

  test("disabled with the flag and without a store: no output", async () => {
    const topic = newUlid(h.clock());
    decision(LOCAL_DEVICE, topic, "own");
    await reindex();
    await runHook(hookPayload("First.", "s1"));
    // An update the enabled lane would inject on the next turn.
    decision(REMOTE_DEVICE, topic, "pick the north bank", NEIGHBOUR_AGENT);
    await reindex();
    const disabled = await runHook(hookPayload("Second.", "s1"), {
      OPEN_SECOND_BRAIN_NEIGHBOUR_UPDATES_ENABLED: "false",
    });
    expect(disabled.exit).toBe(0);
    expect(disabled.stdout).toBe("");
    const noStore = await runHook(hookPayload("Second.", "s1"), {
      OPEN_SECOND_BRAIN_STORE_ROOT: join(h.fx().root, "absent"),
    });
    expect(noStore.exit).toBe(0);
    expect(noStore.stdout).toBe("");
  });
});

/** A scoped decision on a topic of the session's project, by the neighbour. */
function scopedNeighbourDecision(topic: string, text: string): string {
  seedTopicCreate(topic);
  return appendRecord(
    h.fx().open(REMOTE_DEVICE),
    {
      partition: "shared",
      stream: "topics",
      kind: "decision",
      agent: NEIGHBOUR_AGENT,
      topic,
      scope: "project:o2b",
      body: { authority: "agent", text },
    },
    { now },
  ).record.id;
}

describe("neighbour_relevant at hook level", () => {
  test("enforce injects a same-project decision the model marks relevant and drops the fallback one it marks irrelevant; a failing provider keeps the fallback", async () => {
    const { startFakeSystemOne } = await import("../helpers/fake-decision-provider.ts");
    const { decisionThresholdsPath, writeThresholdEntry, resetThresholdsStoreCache } =
      await import("../../src/core/decision-model/thresholds.ts");
    const sessionTopic = newUlid(h.clock());
    decision(LOCAL_DEVICE, sessionTopic, "the session's own decision");
    await reindex();
    await runHook(hookPayload("Work.", "s1"), {});
    // The fallback candidate: a neighbour decision on the session topic.
    decision(
      REMOTE_DEVICE,
      sessionTopic,
      "fallback decision on the session topic",
      NEIGHBOUR_AGENT,
    );
    // The model-only candidate: another topic of the same project scope.
    const other = newUlid(h.clock());
    scopedNeighbourDecision(other, "same project decision on another topic");
    await reindex();
    writeThresholdEntry(
      decisionThresholdsPath(join(h.configHome(), "config.yaml")),
      "nb-model",
      "neighbour_relevant",
      {
        values: { inject_min: 0.5 },
        source: "set",
      },
    );
    resetThresholdsStoreCache();
    const server = await startFakeSystemOne();
    h.server = server;
    server.setReply((req) => {
      const questions = req.body["questions"] as Record<string, unknown>;
      const answers: Record<string, unknown> = {};
      // The state's records R0..R1: R0 is the newer candidate (the
      // other-topic one, newest first); mark it relevant, the other not.
      const n = Object.keys(questions).length;
      for (const [id, q] of Object.entries(questions)) {
        const k = Number((id as string).replace("matters_", ""));
        void n;
        answers[id] = { type: (q as { type: string }).type, noul: k === 0 ? 0.9 : 0.1 };
      }
      return {
        json: { model: "nb-model-1.0", answers, usage: { input_tokens: 50, output_tokens: 7 } },
      };
    });
    const enforce = await runHook(hookPayload("Work.", "s1"), decisionEnv("enforce", server.url));
    expect(enforce.exit).toBe(0);
    const enforceContext = injected(enforce.stdout);
    expect(enforceContext).toContain("same project decision on another topic");
    expect(enforceContext).not.toContain("fallback decision on the session topic");
    // A failing provider keeps the deterministic fallback: a fresh
    // decision on the session's topic is injected, the thresholds entry
    // still installed.
    decision(
      REMOTE_DEVICE,
      sessionTopic,
      "a fresh decision after the enforced turn",
      NEIGHBOUR_AGENT,
    );
    await reindex();
    server.setReply(() => ({ hang: true }));
    const fallback = await runHook(hookPayload("Work.", "s1"), decisionEnv("enforce", server.url));
    expect(fallback.exit).toBe(0);
    expect(injected(fallback.stdout)).toContain("a fresh decision after the enforced turn");
  });

  test.each(["enforce", "shadow"])(
    "under %s a provider that never answers within a configured budget past the ceiling still shows a pending update through the deterministic gate",
    async (mode) => {
      const { startFakeSystemOne } = await import("../helpers/fake-decision-provider.ts");
      const sessionTopic = newUlid(h.clock());
      decision(LOCAL_DEVICE, sessionTopic, "the session's own decision");
      await reindex();
      const server = await startFakeSystemOne();
      h.server = server;
      let asks = 0;
      server.setReply(() => {
        asks += 1;
        return { hang: true };
      });
      const env = {
        ...decisionEnv(mode, server.url),
        OPEN_SECOND_BRAIN_DECISION_MODEL_HOOK_BUDGET_MS: "60000",
        OPEN_SECOND_BRAIN_HOOK_CEILING_MS: "1400",
      };
      await runHook(hookPayload("Work.", "s1"), env);
      decision(
        REMOTE_DEVICE,
        sessionTopic,
        "pending decision on the session topic",
        NEIGHBOUR_AGENT,
      );
      await reindex();
      const asksBefore = asks;
      const hung = await runHook(hookPayload("Work.", "s1"), env);
      expect(hung.exit).toBe(0);
      // The hanging provider was asked: the update came through the timeout path.
      expect(asks).toBeGreaterThan(asksBefore);
      expect(injected(hung.stdout)).toContain("pending decision on the session topic");
    },
  );
});
