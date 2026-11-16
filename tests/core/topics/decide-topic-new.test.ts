/**
 * `topic_new` in the decide pass (task 4.1, design D10): `off` sends
 * nothing; `shadow` records the answer without effect; `enforce`
 * approves the create (the create carries the verdict) or vetoes it for
 * this pass below `veto_below`; on a timeout the create is written as
 * today; a group below the count or session thresholds is never asked
 * about and never created, whatever the model says.
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
import { readPartition } from "../../../src/core/store/state-digest.ts";
import type { StoreHandle } from "../../../src/core/store/store-open.ts";
import { TOPIC_CREATE_KIND } from "../../../src/core/topics/constants.ts";
import { decideTopicPlan } from "../../../src/core/topics/decide.ts";
import { runTopicPlanning } from "../../../src/core/topics/planning.ts";
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
let vault: string;
let configPath: string;

beforeEach(() => {
  clock = T0;
  m = makeMachines(["dev-a"], "o2b-decide-new-");
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

let seq = 0;
function signal(text: string, session: string): string {
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
        id: `sig-2026-12-01-n${seq}`,
        path: `Brain/inbox/n${seq}.md`,
        staged: false,
        frontmatter: { principle: text, project: "o2b", session },
        raw: null,
        raw_shape: "bare",
      },
    },
    { now },
  ).record.id;
}

/** A qualifying cluster: five records of one subject, two sessions. */
function cluster(): string[] {
  return [
    signal("Deprecation windows for the public API start next quarter", "s1"),
    signal("Deprecation windows for the public API were drafted", "s1"),
    signal("Deprecation windows for the public API got reviewed", "s2"),
    signal("Deprecation windows for the public API were approved", "s2"),
    signal("Deprecation windows for the public API announced today", "s2"),
  ];
}

function envFor(mode: string): Record<string, string | undefined> {
  return {
    OPEN_SECOND_BRAIN_DECISION_MODEL_ENABLED: "true",
    OPEN_SECOND_BRAIN_DECISION_MODEL_PROVIDER: "compatible",
    OPEN_SECOND_BRAIN_DECISION_MODEL_BASE_URL: "https://decide.invalid/v1",
    OPEN_SECOND_BRAIN_DECISION_MODEL_ID: "decide-model",
    OPEN_SECOND_BRAIN_DECISION_MODEL_ENV_KEY: "O2B_TEST_DECIDE_KEY",
    OPEN_SECOND_BRAIN_DECISION_MODEL_USES: `topic_new:${mode}`,
    O2B_TEST_DECIDE_KEY: FAKE_DECISION_KEY,
    OPEN_SECOND_BRAIN_CONFIG: configPath,
  };
}

function tuneForEnforce(value = 0.3): void {
  writeThresholdEntry(decisionThresholdsPath(configPath), "decide-model", "topic_new", {
    values: { veto_below: value },
    source: "set",
  });
  resetThresholdsStoreCache();
}

function creates(): Array<Record<string, unknown>> {
  return readPartition(join(m.root("dev-a"), "shared"))
    .flatMap((s) => s.records)
    .filter((r) => r.kind === TOPIC_CREATE_KIND)
    .map((r) => r.body);
}

describe("topic_new in the decide pass", () => {
  test("off sends nothing and the create is written as today", async () => {
    cluster();
    const fake = new FakeDecisionProvider({
      answer: (id) => (id.startsWith("new_") ? 0.9 : undefined),
    });
    const verdicts = await decideTopicPlan(a, { provider: fake, env: envFor("off"), now });
    expect([...verdicts.vetoes.keys()]).toEqual([]);
    expect(fake.requests).toEqual([]);
    expect(listDecisionModelCalls(vault)).toEqual([]);
    const report = runTopicPlanning(a, { agent: "dream", now, topicVerdicts: verdicts });
    expect(report.status).toBe("planned");
    if (report.status !== "planned") return;
    expect(report.created).toHaveLength(1);
    const written = creates();
    expect(written).toHaveLength(1);
    expect(written[0]!["verdict"]).toBeUndefined();
  });

  test("shadow asks once, records the call, and the create carries no verdict", async () => {
    cluster();
    const fake = new FakeDecisionProvider({
      answer: (id) => (id.startsWith("new_") ? 0.9 : undefined),
      model: "shadow-model-2",
    });
    const verdicts = await decideTopicPlan(a, { provider: fake, env: envFor("shadow"), now });
    expect([...verdicts.vetoes.keys()]).toEqual([]);
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]!.use).toBe("topic_new");
    const state = fake.requests[0]!.state as { title: string; groups: Record<string, string> };
    expect(state.title.toLowerCase()).toContain("deprecation");
    expect(Object.keys(state.groups)).toHaveLength(5);
    const calls = listDecisionModelCalls(vault);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.payload["mode"]).toBe("shadow");
    expect(calls[0]!.payload["p_yes"]).toBe(0.9);
    expect(calls[0]!.payload["veto"]).toBe(false);
    const report = runTopicPlanning(a, { agent: "dream", now, topicVerdicts: verdicts });
    expect(report.status).toBe("planned");
    expect(creates()).toHaveLength(1);
    expect(creates()[0]!["verdict"]).toBeUndefined();
  });

  test("enforce approval writes the create with the verdict", async () => {
    cluster();
    tuneForEnforce();
    const fake = new FakeDecisionProvider({
      answer: (id) => (id.startsWith("new_") ? 0.9 : undefined),
      model: "approve-model-4",
    });
    const verdicts = await decideTopicPlan(a, { provider: fake, env: envFor("enforce"), now });
    expect(verdicts.vetoes.size).toBe(1);
    const entry = [...verdicts.vetoes.values()][0]!;
    expect(entry.veto).toBe(false);
    expect(entry.verdict).toEqual({
      use: "topic_new",
      model: "approve-model-4",
      provider: "compatible",
      version: 1,
      mode: "enforce",
      confidence: 0.9,
    });
    const report = runTopicPlanning(a, { agent: "dream", now, topicVerdicts: verdicts });
    expect(report.status).toBe("planned");
    expect(creates()).toHaveLength(1);
    expect(creates()[0]!["verdict"]).toMatchObject({
      use: "topic_new",
      model: "approve-model-4",
      mode: "enforce",
    });
    expect(creates()[0]!["authority"]).toBe("agent");
  });

  test("enforce below veto_below vetoes the creation for this pass", async () => {
    cluster();
    tuneForEnforce();
    const fake = new FakeDecisionProvider({
      answer: (id) => (id.startsWith("new_") ? 0.2 : undefined),
    });
    const verdicts = await decideTopicPlan(a, { provider: fake, env: envFor("enforce"), now });
    expect(verdicts.vetoes.size).toBe(1);
    expect([...verdicts.vetoes.values()][0]!.veto).toBe(true);
    const report = runTopicPlanning(a, { agent: "dream", now, topicVerdicts: verdicts });
    expect(report.status).toBe("planned");
    if (report.status !== "planned") return;
    expect(report.created).toEqual([]);
    expect(creates()).toEqual([]);
  });

  test("a group below the thresholds is never asked about and never created", async () => {
    // Two records from one session: below minSessions, whatever p(yes) is.
    signal("Deprecation windows for the public API start next quarter", "s1");
    signal("Deprecation windows for the public API were drafted", "s1");
    tuneForEnforce();
    const fake = new FakeDecisionProvider({
      answer: (id) => (id.startsWith("new_") ? 1 : undefined),
    });
    const verdicts = await decideTopicPlan(a, { provider: fake, env: envFor("enforce"), now });
    expect(fake.requests).toEqual([]);
    expect(verdicts.vetoes.size).toBe(0);
    const report = runTopicPlanning(a, { agent: "dream", now, topicVerdicts: verdicts });
    expect(report.status).toBe("planned");
    expect(report.status === "planned" ? report.created : []).toEqual([]);
    expect(creates()).toEqual([]);
  });

  test("a timeout keeps the deterministic create", async () => {
    cluster();
    tuneForEnforce();
    const fake = new FakeDecisionProvider({
      answer: (id) => (id.startsWith("new_") ? 0.2 : undefined),
      fail: "timeout",
    });
    const verdicts = await decideTopicPlan(a, { provider: fake, env: envFor("enforce"), now });
    expect(verdicts.vetoes.size).toBe(0);
    const report = runTopicPlanning(a, { agent: "dream", now, topicVerdicts: verdicts });
    expect(report.status).toBe("planned");
    expect(creates()).toHaveLength(1);
    expect(creates()[0]!["verdict"]).toBeUndefined();
  });
});

describe("veto_below from the thresholds store", () => {
  test("a stored veto_below under the answer decides, not the built-in default", async () => {
    cluster();
    tuneForEnforce(0.05);
    const fake = new FakeDecisionProvider({
      answer: (id) => (id.startsWith("new_") ? 0.1 : undefined),
    });
    const verdicts = await decideTopicPlan(a, { provider: fake, env: envFor("enforce"), now });
    // The built-in 0.3 would veto at 0.1; the stored 0.05 decides.
    expect([...verdicts.vetoes.values()].map((v) => v.veto)).toEqual([false]);
  });
});
