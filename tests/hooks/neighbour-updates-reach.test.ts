/**
 * The neighbour-updates hook's reach: a record the model did not judge
 * under `enforce` falls back to the deterministic gate, a reader more
 * than ten pages of unrelated records behind still sees the update on its
 * topic, and a session whose own record on a topic is older than one page
 * still counts that topic as its own.
 */

import { describe, expect, setDefaultTimeout, test } from "bun:test";

import { CLI_SPAWN_BUDGET_MS } from "../helpers/cli-timeout.ts";
import {
  injected,
  LOCAL_DEVICE,
  NEIGHBOUR_AGENT,
  neighbourHarness,
  REMOTE_DEVICE,
} from "../helpers/neighbour-hook.ts";
import { startFakeSystemOne, type FakeSystemOne } from "../helpers/fake-decision-provider.ts";
import { isLoopbackUrl } from "../../src/core/decision-model/egress-guard.ts";
import {
  decisionThresholdsPath,
  resetThresholdsStoreCache,
  writeThresholdEntry,
} from "../../src/core/decision-model/thresholds.ts";
import { newUlid } from "../../src/core/store/ulid.ts";

setDefaultTimeout(CLI_SPAWN_BUDGET_MS * 4);

const h = neighbourHarness("osb-neighbour-reach-");

/** A provider that answers `value` to every question it is asked. */
async function answering(value: number): Promise<FakeSystemOne> {
  const server = await startFakeSystemOne();
  h.server = server;
  server.setReply((req) => {
    const questions = req.body["questions"] as Record<string, { type: string }>;
    const answers: Record<string, unknown> = {};
    for (const [id, q] of Object.entries(questions)) answers[id] = { type: q.type, noul: value };
    return {
      json: { model: "nb-model-1.0", answers, usage: { input_tokens: 5, output_tokens: 1 } },
    };
  });
  return server;
}

describe("a candidate the model did not judge under enforce", () => {
  test("a private decision on the session's topic is still shown through the deterministic gate", async () => {
    const topic = newUlid(h.clock());
    h.decision(LOCAL_DEVICE, topic, "the session's own decision");
    await h.reindex();
    await h.runHook(h.payload("Start.", "s1"));
    h.decision(REMOTE_DEVICE, topic, "SHARED-DECISION pick the north bank", {
      agent: NEIGHBOUR_AGENT,
    });
    h.decision(REMOTE_DEVICE, topic, "PRIVATE-DECISION ask for more", {
      agent: NEIGHBOUR_AGENT,
      partition: "private",
    });
    await h.reindex();
    writeThresholdEntry(
      decisionThresholdsPath(`${h.configHome()}/config.yaml`),
      "nb-model",
      "neighbour_relevant",
      { values: { inject_min: 0.5 }, source: "set" },
    );
    resetThresholdsStoreCache();
    const server = await answering(0.9);
    const hosted = server.url.replace("127.0.0.1", "localhost.");
    expect(isLoopbackUrl(hosted)).toBe(false);
    const result = await h.runHook(h.payload("Next.", "s1"), {
      ...h.decisionEnv("enforce", hosted),
      OPEN_SECOND_BRAIN_DECISION_MODEL_ALLOW_INSECURE_HTTP: "true",
    });
    expect(result.exit).toBe(0);
    expect(server.requests).toHaveLength(1);
    const sent = JSON.stringify(server.requests[0]!.body);
    expect(sent).toContain("SHARED-DECISION");
    expect(sent).not.toContain("PRIVATE-DECISION");
    const context = injected(result.stdout) ?? "";
    expect(context).toContain("SHARED-DECISION");
    // Withheld from the request, so never judged: the deterministic gate
    // (session topic, kind decision) decides, as with the use off.
    expect(context).toContain("PRIVATE-DECISION");
  });
});

describe("a reader far behind", () => {
  test("more than ten pages of unrelated records between two prompts do not hide an update on the session's topic", async () => {
    const topic = newUlid(h.clock());
    h.decision(LOCAL_DEVICE, topic, "the session's own decision");
    await h.reindex();
    await h.runHook(h.payload("Start.", "s1"));
    h.decision(REMOTE_DEVICE, topic, "decided before the import", { agent: NEIGHBOUR_AGENT });
    await h.reindex();
    await h.runHook(h.payload("Meanwhile.", "s0"));
    // The old paging probe re-seeded past ten pages of 500 records: with
    // the update, 5100 records stand between the two prompts.
    h.noise(5100);
    await h.reindex();
    const result = await h.runHook(h.payload("Next.", "s1"));
    expect(result.exit).toBe(0);
    expect(injected(result.stdout)).toContain("decided before the import");
  });
});

describe("the candidate limit", () => {
  test("candidates past the limit are counted in one fenced line naming the call that fetches them", async () => {
    const topic = newUlid(h.clock());
    h.decision(LOCAL_DEVICE, topic, "the session's own decision");
    await h.reindex();
    await h.runHook(h.payload("Start.", "s1"));
    const elsewhere = newUlid(h.clock());
    h.seedTopic(elsewhere, {
      scope: "project:other",
      device: REMOTE_DEVICE,
      agent: NEIGHBOUR_AGENT,
    });
    h.importRecords(
      REMOTE_DEVICE,
      Array.from({ length: 2011 }, (_, i) => ({
        stream: "topics" as const,
        kind: "decision",
        topic: elsewhere,
        body: { authority: "agent", text: `another project's decision ${i}` },
      })),
    );
    await h.reindex();
    const result = await h.runHook(h.payload("Next.", "s1"));
    const context = injected(result.stdout) ?? "";
    expect(context).toContain("<untrusted_source");
    expect(context).toMatch(
      /_11 older topic records from other devices, on any topic or project, arrived since the last turn and were not read\. `brain_changes` since [0-9A-Z]{26}\.\d+ lists them among every record written since then\._/,
    );
    expect(context).not.toContain("another project's decision");
  });
});

describe("the session's topics", () => {
  test("an own record older than one page still makes its topic the session's", async () => {
    const topic = newUlid(h.clock());
    h.decision(LOCAL_DEVICE, topic, "the agent's decision from yesterday");
    // Ingested first (an earlier session's turn catches the index up),
    // then more than one page of other records after it.
    await h.reindex();
    await h.runHook(h.payload("Yesterday.", "s1"));
    h.noise(510);
    await h.reindex();
    await h.runHook(h.payload("Start.", "s2"));
    h.decision(REMOTE_DEVICE, topic, "a neighbour decided on the same topic", {
      agent: NEIGHBOUR_AGENT,
    });
    await h.reindex();
    const result = await h.runHook(h.payload("Next.", "s2"));
    expect(injected(result.stdout)).toContain("a neighbour decided on the same topic");
  });
});
