/**
 * `human_readable` as queue items, one per shared note (change
 * `dream-closed-questions`; was the decide pass, task 4.1, design D10):
 * `off` sends nothing and the page is today's; `shadow` records the call
 * without effect; `enforce` writes a `history-verdict` record with
 * `keep: false` for a note below `hide_below` and `keep: true` for one
 * at or above it (the question never abstains), and the rendered history
 * page leaves a hidden note out while decisions stay; on a timeout the
 * item waits and the page is today's; a note with a stored verdict is
 * never asked about again; a note of any age is asked about.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { listDecisionModelCalls } from "../../../src/core/decision-model/record.ts";
import { appendRecord } from "../../../src/core/store/appender.ts";
import { readPartition } from "../../../src/core/store/state-digest.ts";
import { catchUp } from "../../../src/core/view/catch-up.ts";
import { buildPages } from "../../../src/core/view/render.ts";
import { FakeDecisionProvider } from "../../helpers/fake-decision-provider.ts";
import { closedFixture, T0, type ClosedFixture } from "./fixtures/closed-fixture.ts";
import { ask, plan } from "./fixtures/closed-run.ts";

let f: ClosedFixture;

beforeEach(() => {
  f = closedFixture();
});

afterEach(() => {
  f.cleanup();
});

function history(
  p: number,
  extra: { model?: string; fail?: "timeout" } = {},
): FakeDecisionProvider {
  return new FakeDecisionProvider({
    answer: (id) => (id.startsWith("history_") ? p : undefined),
    ...extra,
  });
}

/** The streams the `history-verdict` records were written to. */
function historyVerdictStreams(): string[] {
  return readPartition(join(f.m.root("dev-a"), "shared"))
    .filter((s) => s.records.some((r) => r.kind === "history-verdict"))
    .map((s) => s.stream);
}

function historyVerdicts(): Array<Record<string, unknown>> {
  return readPartition(join(f.m.root("dev-a"), "shared"))
    .flatMap((s) => s.records)
    .filter((r) => r.kind === "history-verdict")
    .map((r) => r.body);
}

/** Whether the rendered pages mention the text. */
function pageMentions(text: string): boolean {
  const pages = buildPages(f.a, catchUp(f.a, f.now));
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
  await ask(f, "human_readable:enforce", fake);
  plan(f);
  return fake;
}

const WEEK_AGO = T0 - 3 * 24 * 60 * 60 * 1000;

describe("human_readable on the queue", () => {
  test("off sends nothing, records nothing, and the page shows every note", async () => {
    f.note("Refactor of the shard writer landed cleanly", WEEK_AGO);
    f.note("Routine heartbeat of the nightly compaction job", WEEK_AGO);
    const fake = history(0.1);
    await ask(f, "human_readable:off", fake);
    expect(fake.requests).toEqual([]);
    expect(listDecisionModelCalls(f.vault)).toEqual([]);
    const report = plan(f);
    expect(report.status === "planned" ? report.hidden : -1).toBe(0);
    expect(historyVerdicts()).toEqual([]);
    expect(pageMentions("Refactor of the shard writer")).toBe(true);
    expect(pageMentions("Routine heartbeat of the nightly compaction job")).toBe(true);
  });

  test("shadow asks once per note, records, and the page is today's", async () => {
    f.note("Refactor of the shard writer landed cleanly", WEEK_AGO);
    f.note("Routine heartbeat of the nightly compaction job", WEEK_AGO);
    const fake = history(0.1, { model: "hist-shadow-1" });
    await ask(f, "human_readable:shadow", fake);
    expect(fake.requests).toHaveLength(2);
    expect(fake.requests[0]!.use).toBe("human_readable");
    expect(Object.keys(fake.requests[0]!.state as Record<string, string>)).toContain("records");
    const calls = listDecisionModelCalls(f.vault);
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.payload["mode"] === "shadow")).toBe(true);
    expect(plan(f).status).toBe("planned");
    expect(historyVerdicts()).toEqual([]);
    expect(pageMentions("Routine heartbeat of the nightly compaction job")).toBe(true);
  });

  test("enforce writes the verdict and the page hides the note, keeping the other", async () => {
    const kept = f.note("Refactor of the shard writer landed cleanly", WEEK_AGO);
    const routine = f.note("Routine heartbeat of the nightly compaction job", WEEK_AGO);
    f.tune("human_readable", { hide_below: 0.3 });
    // Answered by the note's text.
    const fake = new FakeDecisionProvider({
      answer: (id, req) => {
        if (!id.startsWith("history_")) return undefined;
        const text = (req.state as { records: Record<string, string> }).records["R0"] ?? "";
        return text.includes("Routine heartbeat") ? 0.1 : 0.9;
      },
      model: "hist-model-4",
    });
    await ask(f, "human_readable:enforce", fake);
    // The model read both notes, one request each; only the low one is hidden.
    expect(fake.requests).toHaveLength(2);
    const report = plan(f);
    expect(report.status === "planned" ? report.hidden : -1).toBe(1);
    // FORMAT.md: `history-verdict` goes to the `log` stream of `shared`.
    expect(historyVerdictStreams()).toEqual(["log"]);
    const written = historyVerdicts().filter((v) => v["keep"] === false);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      authority: "model",
      record: routine,
      keep: false,
      verdict: { use: "human_readable", model: "hist-model-4", mode: "enforce", version: 2 },
    });
    expect(
      historyVerdicts()
        .filter((v) => v["keep"] === true)
        .map((v) => v["record"]),
    ).toEqual([kept]);
    expect(pageMentions("Refactor of the shard writer landed cleanly")).toBe(true);
    expect(pageMentions("Routine heartbeat of the nightly compaction job")).toBe(false);
  });

  test("at or above the threshold the note is kept and on a timeout the page is today's", async () => {
    f.note("Refactor of the shard writer landed cleanly", WEEK_AGO);
    f.tune("human_readable", { hide_below: 0.3 });
    await ask(f, "human_readable:enforce", history(0.1, { fail: "timeout" }));
    const [waiting] = f.items("human-readable");
    expect(waiting!.attempts).toBe(1);
    plan(f);
    expect(historyVerdicts()).toEqual([]);
    f.setClock(Date.parse(waiting!.retry_at!) + 1000);
    await ask(f, "human_readable:enforce", history(0.5));
    const report = plan(f);
    // The question never abstains: above the threshold the note is stored as kept.
    expect(report.status === "planned" && report.abstained).toBe(0);
    expect(historyVerdicts().filter((v) => v["keep"] === false)).toEqual([]);
    expect(historyVerdicts().filter((v) => v["keep"] === true)).toHaveLength(1);
    expect(pageMentions("Refactor of the shard writer")).toBe(true);
  });

  test("a note with a stored verdict is never asked about again", async () => {
    const routine = f.note("Routine heartbeat of the nightly compaction job", WEEK_AGO);
    appendRecord(
      f.a,
      {
        partition: "shared",
        stream: "log",
        kind: "history-verdict",
        agent: "seed",
        body: { authority: "model", record: routine, keep: false },
      },
      { now: f.now },
    );
    const fake = new FakeDecisionProvider({ answer: () => 0.1 });
    await ask(f, "human_readable:shadow", fake);
    expect(fake.requests).toEqual([]);
    // The page still hides the note: the stored verdict decides.
    expect(pageMentions("Routine heartbeat of the nightly compaction job")).toBe(false);
  });

  test("a kept note is stored as kept, so a second pass asks only the notes not yet judged", async () => {
    for (let i = 0; i < 60; i++) f.note(`Weekly note number ${i}`, WEEK_AGO + i * 60_000);
    f.tune("human_readable", { hide_below: 0.3 });
    // No per-pass cap: every note is asked in the first pass.
    const first = asked(await keepAllPass());
    expect(first).toHaveLength(60);
    // The oldest notes go first.
    expect(first[0]).toBe("Weekly note number 0");
    expect(historyVerdicts().filter((v) => v["keep"] === true)).toHaveLength(60);
    f.note("Weekly note number 60", WEEK_AGO + 60 * 60_000);
    const second = asked(await keepAllPass());
    expect(second).toEqual(["Weekly note number 60"]);
    expect(asked(await keepAllPass())).toEqual([]);
    // Kept notes stay on the page.
    expect(pageMentions("Weekly note number 59")).toBe(true);
  }, 30_000);

  test("notes dated after the run wait behind the present ones in the queue", async () => {
    // A device with a fast clock: notes dated a month ahead.
    const MONTH_AHEAD = T0 + 30 * 24 * 60 * 60 * 1000;
    for (let i = 0; i < 50; i++) f.note(`Future dated note ${i}`, MONTH_AHEAD + i * 60_000);
    f.note("A present note from this week", WEEK_AGO);
    const fake = new FakeDecisionProvider({});
    await ask(f, "human_readable:shadow", fake);
    const first = asked(fake);
    expect(first).toHaveLength(51);
    expect(first[0]).toBe("A present note from this week");
  }, 30_000);

  test("a note older than eight weeks is asked about too", async () => {
    f.note("A very old note from the summer sprint", T0 - 10 * 7 * 24 * 60 * 60 * 1000);
    const fake = new FakeDecisionProvider({});
    await ask(f, "human_readable:shadow", fake);
    expect(asked(fake)).toEqual(["A very old note from the summer sprint"]);
  });
});

describe("hide_below from the thresholds store", () => {
  test("a stored hide_below under the answer decides, not the built-in default", async () => {
    const id = f.note("Routine heartbeat of the nightly compaction job", WEEK_AGO);
    f.tune("human_readable", { hide_below: 0.05 });
    await ask(f, "human_readable:enforce", history(0.2));
    plan(f);
    // The built-in 0.3 would hide at 0.2; the stored 0.05 decides.
    expect(historyVerdicts().map((v) => [v["record"], v["keep"]])).toEqual([[id, true]]);
  });
});

describe("history verdicts under the lock", () => {
  test("two passes over the same notes write one verdict per note", async () => {
    f.tune("human_readable", { hide_below: 0.3 });
    f.note("Refactor of the shard writer landed cleanly", WEEK_AGO);
    f.note("Routine heartbeat of the nightly compaction job", WEEK_AGO);
    // Both front doors (the CLI dream and brain_dream) ask before either
    // applies: the second finds the items answered and asks nothing.
    await ask(f, "human_readable:enforce", new FakeDecisionProvider({ answer: () => 0.9 }));
    const secondProvider = new FakeDecisionProvider({ answer: () => 0.1 });
    await ask(f, "human_readable:enforce", secondProvider);
    expect(asked(secondProvider)).toEqual([]);
    plan(f);
    plan(f);
    const verdicts = historyVerdicts();
    expect(verdicts).toHaveLength(2);
    // The first answer stands.
    expect(verdicts.every((v) => v["keep"] === true)).toBe(true);
  });
});
