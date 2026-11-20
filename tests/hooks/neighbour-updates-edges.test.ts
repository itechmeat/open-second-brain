/**
 * The neighbour-updates hook at the edges the main suite does not reach:
 * a store with more than one change page, more than one page of new
 * records in a turn, an index rebuilt between turns, a cap that must not
 * hide the session's own topic, private records and titles against a
 * hosted provider, model-derived items, routine log entries and the
 * boolean form of the off switch.
 */

import { describe, expect, setDefaultTimeout, test } from "bun:test";

import { CLI_SPAWN_BUDGET_MS } from "../helpers/cli-timeout.ts";
import {
  injected,
  LOCAL_DEVICE,
  NEIGHBOUR_AGENT,
  neighbourHarness,
  REMOTE_DEVICE,
  SELF_AGENT,
} from "../helpers/neighbour-hook.ts";
import { startFakeSystemOne } from "../helpers/fake-decision-provider.ts";
import { listContinuityRecords } from "../../src/core/brain/continuity/store.ts";
import { isLoopbackUrl } from "../../src/core/decision-model/egress-guard.ts";
import { reindexVault } from "../../src/core/search/indexer.ts";
import { newUlid } from "../../src/core/store/ulid.ts";

setDefaultTimeout(CLI_SPAWN_BUDGET_MS * 2);

const h = neighbourHarness("osb-neighbour-edge-");

/**
 * A decision configuration whose provider the guard counts as hosted:
 * the fake server under a trailing-dot name, plain http allowed.
 */
function hostedEnv(url: string): Record<string, string> {
  const hosted = url.replace("127.0.0.1", "localhost.");
  expect(isLoopbackUrl(hosted)).toBe(false);
  return {
    ...h.decisionEnv("shadow", hosted),
    OPEN_SECOND_BRAIN_DECISION_MODEL_ALLOW_INSECURE_HTTP: "true",
  };
}

describe("the watermark", () => {
  test("starts at the head of a store with more than one page: old history is never replayed", async () => {
    h.noise(510);
    const topic = newUlid(h.clock());
    h.decision(LOCAL_DEVICE, topic, "the session's own decision");
    h.decision(REMOTE_DEVICE, topic, "an old neighbour decision", { agent: NEIGHBOUR_AGENT });
    await h.reindex();
    const first = await h.runHook(h.payload("Start.", "s1"));
    expect(first.exit).toBe(0);
    expect(first.stdout).toBe("");
    // No record was written since the session began: nothing is new.
    const second = await h.runHook(h.payload("Again.", "s1"));
    expect(second.stdout).toBe("");
    // A real update on the session's topic shows on the next turn.
    h.decision(REMOTE_DEVICE, topic, "a fresh neighbour decision", { agent: NEIGHBOUR_AGENT });
    await h.reindex();
    const third = await h.runHook(h.payload("And now?", "s1"));
    const context = injected(third.stdout);
    expect(context).toContain("a fresh neighbour decision");
    expect(context).not.toContain("an old neighbour decision");
  });

  test("pages through more than one page of new records in one turn", async () => {
    const topic = newUlid(h.clock());
    h.decision(LOCAL_DEVICE, topic, "the session's own decision");
    await h.reindex();
    await h.runHook(h.payload("Start.", "s1"));
    h.noise(510);
    h.decision(REMOTE_DEVICE, topic, "decided after a busy hour", { agent: NEIGHBOUR_AGENT });
    await h.reindex();
    const result = await h.runHook(h.payload("Next.", "s1"));
    expect(injected(result.stdout)).toContain("decided after a busy hour");
  });

  test("re-seeds after an index rebuild instead of replaying the store", async () => {
    const topic = newUlid(h.clock());
    h.decision(LOCAL_DEVICE, topic, "the session's own decision");
    h.decision(REMOTE_DEVICE, topic, "an old neighbour decision", { agent: NEIGHBOUR_AGENT });
    await h.reindex();
    await h.runHook(h.payload("Start.", "s1"));
    await reindexVault(h.fx().config());
    const afterReset = await h.runHook(h.payload("Next.", "s1"));
    expect(afterReset.exit).toBe(0);
    expect(afterReset.stdout).toBe("");
    // The lane keeps working from the new head.
    h.decision(REMOTE_DEVICE, topic, "decided after the rebuild", { agent: NEIGHBOUR_AGENT });
    await h.reindex();
    const later = await h.runHook(h.payload("Later.", "s1"));
    const context = injected(later.stdout);
    expect(context).toContain("decided after the rebuild");
    expect(context).not.toContain("an old neighbour decision");
  });
});

describe("the candidate cap", () => {
  test("filters by session topic and project before the cap", async () => {
    const topic = newUlid(h.clock());
    h.decision(LOCAL_DEVICE, topic, "the session's own decision");
    await h.reindex();
    await h.runHook(h.payload("Start.", "s1"));
    h.decision(REMOTE_DEVICE, topic, "the one that matters here", { agent: NEIGHBOUR_AGENT });
    const elsewhere = newUlid(h.clock());
    h.seedTopic(elsewhere, {
      scope: "project:other",
      device: REMOTE_DEVICE,
      agent: NEIGHBOUR_AGENT,
    });
    for (let i = 0; i < 25; i++) {
      h.decision(REMOTE_DEVICE, elsewhere, `another project's decision ${i}`, {
        agent: NEIGHBOUR_AGENT,
        scope: "project:other",
      });
    }
    await h.reindex();
    const result = await h.runHook(h.payload("Next.", "s1"));
    const context = injected(result.stdout);
    expect(context).toContain("the one that matters here");
    expect(context).not.toContain("another project's decision");
  });

  test("counts what the cap removed in the cut line", async () => {
    const topic = newUlid(h.clock());
    h.decision(LOCAL_DEVICE, topic, "the session's own decision");
    await h.reindex();
    await h.runHook(h.payload("Start.", "s1"));
    for (let i = 0; i < 25; i++) {
      h.decision(REMOTE_DEVICE, topic, `decision ${i}`, { agent: NEIGHBOUR_AGENT });
    }
    await h.reindex();
    const result = await h.runHook(h.payload("Next.", "s1"));
    const context = injected(result.stdout) ?? "";
    // Five short lines and the cut line fit the 800 characters; the
    // candidate cap's five and the fifteen past the line cap are counted.
    expect(context.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(5);
    expect(context).toContain("_20 more neighbour updates are not shown.");
  });
});

describe("privacy against a hosted provider", () => {
  test("private records, private topics and private regions never reach it; their ids are withheld", async () => {
    const topic = newUlid(h.clock());
    h.decision(LOCAL_DEVICE, topic, "the session's own decision");
    const privateTopic = newUlid(h.clock() + 1);
    h.seedTopic(privateTopic, { partition: "private", title: "PRIVATE-TITLE salary talks" });
    h.decision(LOCAL_DEVICE, privateTopic, "own work on the private topic", {
      partition: "private",
    });
    await h.reindex();
    await h.runHook(h.payload("Start.", "s1"));
    h.decision(REMOTE_DEVICE, topic, "PUBLIC-TEXT pick the north bank", { agent: NEIGHBOUR_AGENT });
    const privateRecord = h.decision(REMOTE_DEVICE, topic, "PRIVATE-TEXT ask for more", {
      agent: NEIGHBOUR_AGENT,
      partition: "private",
    });
    const onPrivateTopic = h.decision(REMOTE_DEVICE, privateTopic, "TEXT-ON-PRIVATE-TOPIC", {
      agent: NEIGHBOUR_AGENT,
    });
    await h.reindex();
    const server = await startFakeSystemOne();
    h.server = server;
    const result = await h.runHook(h.payload("Next.", "s1"), hostedEnv(server.url));
    expect(result.exit).toBe(0);
    expect(server.requests).toHaveLength(1);
    const sent = JSON.stringify(server.requests[0]!.body);
    expect(sent).toContain("PUBLIC-TEXT");
    expect(sent).not.toContain("PRIVATE-TEXT");
    expect(sent).not.toContain("PRIVATE-TITLE");
    expect(sent).not.toContain("TEXT-ON-PRIVATE-TOPIC");
    const calls = listContinuityRecords(h.fx().vault, { kind: "decision_model_call" });
    const ids = calls.flatMap((c) => (c.payload as { record_ids?: string[] }).record_ids ?? []);
    expect(ids).toContain("(withheld)");
    expect(ids).not.toContain(privateRecord);
    expect(ids).not.toContain(onPrivateTopic);
    // The session's own agent still sees them locally.
    const context = injected(result.stdout) ?? "";
    expect(context).toContain("PRIVATE-TEXT");
  });

  test("a <private> region in a topic title is stripped from the request", async () => {
    const topic = newUlid(h.clock());
    h.seedTopic(topic, { title: "North bank <private>TITLE-REGION</private> plan" });
    h.decision(LOCAL_DEVICE, topic, "the session's own decision");
    await h.reindex();
    await h.runHook(h.payload("Start.", "s1"));
    h.decision(REMOTE_DEVICE, topic, "pick the north bank", { agent: NEIGHBOUR_AGENT });
    await h.reindex();
    const server = await startFakeSystemOne();
    h.server = server;
    await h.runHook(h.payload("Next.", "s1"), hostedEnv(server.url));
    expect(server.requests).toHaveLength(1);
    const sent = JSON.stringify(server.requests[0]!.body);
    expect(sent).toContain("pick the north bank");
    expect(sent).not.toContain("TITLE-REGION");
  });
});

describe("model-derived items and routine entries", () => {
  test("an item derived from this agent's own record never returns; one from a neighbour is named model-derived", async () => {
    const topic = newUlid(h.clock());
    const own = h.decision(LOCAL_DEVICE, topic, "the session's own note text");
    await h.reindex();
    await h.runHook(h.payload("Start.", "s1"));
    const neighbourSource = h.decision(REMOTE_DEVICE, null, "a neighbour's raw note", {
      agent: NEIGHBOUR_AGENT,
    });
    // The view writer's dream derives decision items from both records.
    for (const [source, text] of [
      [own, "derived from my own note"],
      [neighbourSource, "derived from the neighbour's note"],
    ] as const) {
      h.decision(REMOTE_DEVICE, topic, text, {
        agent: "dream",
        authority: "model",
        extra: { item: source, source },
      });
    }
    await h.reindex();
    const result = await h.runHook(h.payload("Next.", "s1"));
    const context = injected(result.stdout) ?? "";
    expect(context).not.toContain("derived from my own note");
    expect(context).toContain("derived from the neighbour's note");
    expect(context).toMatch(/model-derived decision/);
  });

  test("a routine log entry never becomes a candidate, even when the model would pass it", async () => {
    const topic = newUlid(h.clock());
    h.decision(LOCAL_DEVICE, topic, "the session's own decision");
    await h.reindex();
    await h.runHook(h.payload("Start.", "s1"));
    h.logEntry(REMOTE_DEVICE, topic, "ROUTINE progress line", true);
    h.logEntry(REMOTE_DEVICE, topic, "BLOCKER on the north bank", false);
    await h.reindex();
    const { decisionThresholdsPath, writeThresholdEntry, resetThresholdsStoreCache } =
      await import("../../src/core/decision-model/thresholds.ts");
    writeThresholdEntry(
      decisionThresholdsPath(`${h.configHome()}/config.yaml`),
      "nb-model",
      "neighbour_relevant",
      { values: { inject_min: 0.5 }, source: "set" },
    );
    resetThresholdsStoreCache();
    const server = await startFakeSystemOne();
    h.server = server;
    server.setReply((req) => {
      const questions = req.body["questions"] as Record<string, { type: string }>;
      const answers: Record<string, unknown> = {};
      for (const [id, q] of Object.entries(questions)) answers[id] = { type: q.type, noul: 0.9 };
      return {
        json: { model: "nb-model-1.0", answers, usage: { input_tokens: 5, output_tokens: 1 } },
      };
    });
    const result = await h.runHook(h.payload("Next.", "s1"), h.decisionEnv("enforce", server.url));
    const sent = JSON.stringify(server.requests[0]?.body ?? {});
    expect(sent).not.toContain("ROUTINE progress line");
    const context = injected(result.stdout) ?? "";
    expect(context).toContain("BLOCKER on the north bank");
    expect(context).not.toContain("ROUTINE progress line");
  });
});

describe("inject_min from the thresholds store", () => {
  test("a stored inject_min decides, not the built-in default", async () => {
    const topic = newUlid(h.clock());
    h.decision(LOCAL_DEVICE, topic, "the session's own decision");
    await h.reindex();
    await h.runHook(h.payload("Start.", "s1"));
    h.decision(REMOTE_DEVICE, topic, "pick the north bank", { agent: NEIGHBOUR_AGENT });
    await h.reindex();
    const { decisionThresholdsPath, writeThresholdEntry, resetThresholdsStoreCache } =
      await import("../../src/core/decision-model/thresholds.ts");
    writeThresholdEntry(
      decisionThresholdsPath(`${h.configHome()}/config.yaml`),
      "nb-model",
      "neighbour_relevant",
      { values: { inject_min: 0.95 }, source: "set" },
    );
    resetThresholdsStoreCache();
    const server = await startFakeSystemOne();
    h.server = server;
    server.setReply((req) => {
      const questions = req.body["questions"] as Record<string, { type: string }>;
      const answers: Record<string, unknown> = {};
      for (const [id, q] of Object.entries(questions)) answers[id] = { type: q.type, noul: 0.9 };
      return {
        json: { model: "nb-model-1.0", answers, usage: { input_tokens: 5, output_tokens: 1 } },
      };
    });
    const result = await h.runHook(h.payload("Next.", "s1"), h.decisionEnv("enforce", server.url));
    expect(server.requests).toHaveLength(1);
    // The built-in 0.5 would inject at 0.9; the stored 0.95 decides.
    expect(injected(result.stdout)).toBeNull();
  });
});

describe("the off switch", () => {
  test("the value 0 turns the lane off, as every other boolean setting reads it", async () => {
    const topic = newUlid(h.clock());
    h.decision(LOCAL_DEVICE, topic, "own");
    await h.reindex();
    await h.runHook(h.payload("First.", "s1"));
    h.decision(REMOTE_DEVICE, topic, "pick the north bank", { agent: NEIGHBOUR_AGENT });
    await h.reindex();
    const off = await h.runHook(h.payload("Second.", "s1"), {
      OPEN_SECOND_BRAIN_NEIGHBOUR_UPDATES_ENABLED: "0",
    });
    expect(off.stdout).toBe("");
    void SELF_AGENT;
  });
});
