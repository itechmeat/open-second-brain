/**
 * `human_readable` in the decide pass (task 4.1, design D10): `off`
 * sends nothing and the page is today's; `shadow` records the call
 * without effect; `enforce` writes a `history-verdict` record with
 * `keep: false` for a note below `hide_below`, and the rendered history
 * page leaves that note out while decisions stay; below the threshold
 * and on a timeout the page is today's; a note with a stored verdict is
 * never asked about again.
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
import { decideTopicPlan } from "../../../src/core/topics/decide.ts";
import { runTopicPlanning } from "../../../src/core/topics/planning.ts";
import { catchUp } from "../../../src/core/view/catch-up.ts";
import { claimSettled, claimViewWriter, readViewWriter } from "../../../src/core/view/writer.ts";
import { buildPages } from "../../../src/core/view/render.ts";
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
  m = makeMachines(["dev-a"], "o2b-decide-hist-");
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

function note(text: string, ms: number): string {
  clock += 1000;
  return appendRecord(
    a,
    {
      partition: "shared",
      stream: "log",
      kind: "log-event",
      agent: "seed",
      body: { timestamp: new Date(ms).toISOString(), event_type: "note", body: { text } },
    },
    { now: () => ms },
  ).record.id;
}

function envFor(mode: string): Record<string, string | undefined> {
  return {
    OPEN_SECOND_BRAIN_DECISION_MODEL_ENABLED: "true",
    OPEN_SECOND_BRAIN_DECISION_MODEL_PROVIDER: "compatible",
    OPEN_SECOND_BRAIN_DECISION_MODEL_BASE_URL: "https://decide.invalid/v1",
    OPEN_SECOND_BRAIN_DECISION_MODEL_ID: "decide-model",
    OPEN_SECOND_BRAIN_DECISION_MODEL_ENV_KEY: "O2B_TEST_DECIDE_KEY",
    OPEN_SECOND_BRAIN_DECISION_MODEL_USES: `human_readable:${mode}`,
    O2B_TEST_DECIDE_KEY: FAKE_DECISION_KEY,
    OPEN_SECOND_BRAIN_CONFIG: configPath,
  };
}

function tuneForEnforce(value = 0.3): void {
  writeThresholdEntry(decisionThresholdsPath(configPath), "decide-model", "human_readable", {
    values: { hide_below: value },
    source: "set",
  });
  resetThresholdsStoreCache();
}

/** The streams the `history-verdict` records were written to. */
function historyVerdictStreams(): string[] {
  return readPartition(join(m.root("dev-a"), "shared"))
    .filter((s) => s.records.some((r) => r.kind === "history-verdict"))
    .map((s) => s.stream);
}

function historyVerdicts(): Array<Record<string, unknown>> {
  return readPartition(join(m.root("dev-a"), "shared"))
    .flatMap((s) => s.records)
    .filter((r) => r.kind === "history-verdict")
    .map((r) => r.body);
}

/** Whether the rendered pages mention the text. */
function pageMentions(text: string): boolean {
  const pages = buildPages(a, catchUp(a, now));
  return [...pages.values()].some((page) => page.lines.some((line) => line.text.includes(text)));
}

/** The note texts every request of `fake` asked about. */
function asked(fake: FakeDecisionProvider): string[] {
  return fake.requests.flatMap((r) =>
    Object.values((r.state as { records: Record<string, string> }).records),
  );
}

/** One enforce pass that keeps every note, applied under the planning lock. */
async function keepAllPass(): Promise<FakeDecisionProvider> {
  const fake = new FakeDecisionProvider({ answer: () => 0.9 });
  const verdicts = await decideTopicPlan(a, { provider: fake, env: envFor("enforce"), now });
  runTopicPlanning(a, { agent: "dream", now, topicVerdicts: verdicts });
  return fake;
}

const WEEK_AGO = T0 - 3 * 24 * 60 * 60 * 1000;

describe("human_readable in the decide pass", () => {
  test("off sends nothing, records nothing, and the page shows every note", async () => {
    const kept = note("Refactor of the shard writer landed cleanly", WEEK_AGO);
    const hidden = note("Routine heartbeat of the nightly compaction job", WEEK_AGO);
    const fake = new FakeDecisionProvider({
      answer: (id) => (id.startsWith("history_") ? 0.1 : undefined),
    });
    const verdicts = await decideTopicPlan(a, { provider: fake, env: envFor("off"), now });
    expect([...verdicts.hidden.keys()]).toEqual([]);
    expect(fake.requests).toEqual([]);
    expect(listDecisionModelCalls(vault)).toEqual([]);
    const report = runTopicPlanning(a, { agent: "dream", now, topicVerdicts: verdicts });
    expect(report.status === "planned" ? report.hidden : -1).toBe(0);
    expect(historyVerdicts()).toEqual([]);
    expect(pageMentions("Refactor of the shard writer")).toBe(true);
    expect(pageMentions("Routine heartbeat of the nightly compaction job")).toBe(true);
    void kept;
    void hidden;
  });

  test("shadow asks once, records, and the page is today's", async () => {
    note("Refactor of the shard writer landed cleanly", WEEK_AGO);
    note("Routine heartbeat of the nightly compaction job", WEEK_AGO);
    const fake = new FakeDecisionProvider({
      answer: (id) => (id.startsWith("history_") ? 0.1 : undefined),
      model: "hist-shadow-1",
    });
    const verdicts = await decideTopicPlan(a, { provider: fake, env: envFor("shadow"), now });
    expect([...verdicts.hidden.keys()]).toEqual([]);
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]!.use).toBe("human_readable");
    expect(Object.keys(fake.requests[0]!.state as Record<string, string>)).toContain("records");
    const calls = listDecisionModelCalls(vault);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.payload["mode"]).toBe("shadow");
    expect(runTopicPlanning(a, { agent: "dream", now, topicVerdicts: verdicts }).status).toBe(
      "planned",
    );
    expect(historyVerdicts()).toEqual([]);
    expect(pageMentions("Routine heartbeat of the nightly compaction job")).toBe(true);
  });

  test("enforce writes the verdict and the page hides the note, keeping the other", async () => {
    const kept = note("Refactor of the shard writer landed cleanly", WEEK_AGO);
    const routine = note("Routine heartbeat of the nightly compaction job", WEEK_AGO);
    tuneForEnforce();
    // Answered by the note's text, whichever question id it got.
    const fake = new FakeDecisionProvider({
      answer: (id, req) => {
        const k = /^history_(\d+)$/.exec(id)?.[1];
        if (k === undefined) return undefined;
        const text = (req.state as { records: Record<string, string> }).records[`R${k}`] ?? "";
        return text.includes("Routine heartbeat") ? 0.1 : 0.9;
      },
      model: "hist-model-4",
    });
    const verdicts = await decideTopicPlan(a, { provider: fake, env: envFor("enforce"), now });
    // The model read both notes; only the low-probability one is hidden.
    expect(Object.keys(fake.requests[0]!.questions)).toHaveLength(2);
    expect([...verdicts.hidden.keys()]).toEqual([routine]);
    const report = runTopicPlanning(a, { agent: "dream", now, topicVerdicts: verdicts });
    expect(report.status === "planned" ? report.hidden : -1).toBe(1);
    // FORMAT.md: `history-verdict` goes to the `log` stream of `shared`.
    expect(historyVerdictStreams()).toEqual(["log"]);
    const written = historyVerdicts().filter((v) => v["keep"] === false);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      authority: "model",
      record: [...verdicts.hidden.keys()][0],
      keep: false,
      verdict: { use: "human_readable", model: "hist-model-4", mode: "enforce", version: 2 },
    });
    expect([...verdicts.kept.keys()]).toEqual([kept]);
    expect(pageMentions("Refactor of the shard writer landed cleanly")).toBe(true);
    expect(pageMentions("Routine heartbeat of the nightly compaction job")).toBe(false);
  });

  test("below the threshold and on a timeout the page is today's", async () => {
    note("Refactor of the shard writer landed cleanly", WEEK_AGO);
    tuneForEnforce();
    const low = await decideTopicPlan(a, {
      provider: new FakeDecisionProvider({
        answer: (id) => (id.startsWith("history_") ? 0.5 : undefined),
      }),
      env: envFor("enforce"),
      now,
    });
    expect([...low.hidden.keys()]).toEqual([]);
    const timedOut = await decideTopicPlan(a, {
      provider: new FakeDecisionProvider({
        answer: (id) => (id.startsWith("history_") ? 0.1 : undefined),
        fail: "timeout",
      }),
      env: envFor("enforce"),
      now,
    });
    expect([...timedOut.hidden.keys()]).toEqual([]);
    expect(runTopicPlanning(a, { agent: "dream", now, topicVerdicts: low }).status).toBe("planned");
    // Above the threshold the note is kept (stored as kept), never hidden.
    expect(historyVerdicts().filter((v) => v["keep"] === false)).toEqual([]);
    expect(pageMentions("Refactor of the shard writer")).toBe(true);
  });

  test("a note with a stored verdict is never asked about again", async () => {
    const routine = note("Routine heartbeat of the nightly compaction job", WEEK_AGO);
    appendRecord(
      a,
      {
        partition: "shared",
        stream: "log",
        kind: "history-verdict",
        agent: "seed",
        body: { authority: "model", record: routine, keep: false },
      },
      { now },
    );
    const fake = new FakeDecisionProvider({ answer: () => 0.1 });
    await decideTopicPlan(a, { provider: fake, env: envFor("shadow"), now });
    expect(fake.requests).toEqual([]);
    // The page still hides the note: the stored verdict decides.
    expect(pageMentions("Routine heartbeat of the nightly compaction job")).toBe(false);
  });

  test("a kept note is stored as kept, so a second pass asks only the notes not yet judged", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 60; i++) ids.push(note(`Weekly note number ${i}`, WEEK_AGO + i * 60_000));
    tuneForEnforce();
    const first = asked(await keepAllPass());
    expect(first).toHaveLength(50);
    // The newest notes go first.
    expect(first).toContain("Weekly note number 59");
    expect(historyVerdicts().filter((v) => v["keep"] === true)).toHaveLength(50);
    const second = asked(await keepAllPass());
    expect(second).toHaveLength(10);
    expect(second.some((text) => first.includes(text))).toBe(false);
    expect(asked(await keepAllPass())).toEqual([]);
    // Kept notes stay on the page.
    expect(pageMentions("Weekly note number 59")).toBe(true);
  });

  test("notes dated after the run wait behind the present ones under the per-pass cap", async () => {
    // A device with a fast clock: a full pass of notes dated a month ahead.
    const MONTH_AHEAD = T0 + 30 * 24 * 60 * 60 * 1000;
    for (let i = 0; i < 50; i++) note(`Future dated note ${i}`, MONTH_AHEAD + i * 60_000);
    note("A present note from this week", WEEK_AGO);
    const fake = new FakeDecisionProvider({});
    await decideTopicPlan(a, { provider: fake, env: envFor("shadow"), now });
    const first = asked(fake);
    expect(first).toHaveLength(50);
    expect(first[0]).toBe("A present note from this week");
  });

  test("a note older than eight weeks is never asked about", async () => {
    note("A very old note from the summer sprint", T0 - 10 * 7 * 24 * 60 * 60 * 1000);
    const fake = new FakeDecisionProvider({});
    await decideTopicPlan(a, { provider: fake, env: envFor("shadow"), now });
    expect(fake.requests).toEqual([]);
  });
});

describe("hide_below from the thresholds store", () => {
  test("a stored hide_below under the answer decides, not the built-in default", async () => {
    const id = note("Routine heartbeat of the nightly compaction job", WEEK_AGO);
    tuneForEnforce(0.05);
    const fake = new FakeDecisionProvider({
      answer: (qid) => (qid.startsWith("history_") ? 0.2 : undefined),
    });
    const verdicts = await decideTopicPlan(a, { provider: fake, env: envFor("enforce"), now });
    // The built-in 0.3 would hide at 0.2; the stored 0.05 decides.
    expect([...verdicts.hidden.keys()]).toEqual([]);
    expect([...verdicts.kept.keys()]).toEqual([id]);
  });
});

describe("history verdicts under the lock", () => {
  test("two passes that judged the same notes write one verdict per note under the lock", async () => {
    tuneForEnforce();
    note("Refactor of the shard writer landed cleanly", WEEK_AGO);
    note("Routine heartbeat of the nightly compaction job", WEEK_AGO);
    // Both front doors (the CLI dream and brain_dream) judge outside the
    // lock before either applies.
    const first = await decideTopicPlan(a, {
      provider: new FakeDecisionProvider({ answer: () => 0.9 }),
      env: envFor("enforce"),
      now,
    });
    // human_readable keeps no asked entry: a note is skipped only once a
    // stored verdict judges it, and none is written before the lock, so
    // the second pass asks both notes again and would hide them.
    const secondProvider = new FakeDecisionProvider({ answer: () => 0.1 });
    const second = await decideTopicPlan(a, {
      provider: secondProvider,
      env: envFor("enforce"),
      now,
    });
    expect(asked(secondProvider)).toHaveLength(2);
    expect(second.hidden.size).toBe(2);
    runTopicPlanning(a, { agent: "dream", now, topicVerdicts: first });
    runTopicPlanning(a, { agent: "dream", now, topicVerdicts: second });
    const verdicts = historyVerdicts();
    expect(verdicts).toHaveLength(2);
    // The first applied verdict stands.
    expect(verdicts.every((v) => v["keep"] === true)).toBe(true);
  });
});
