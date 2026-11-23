/**
 * A window is finished once, whatever interrupts it (dream replay task
 * 5.1; spec "A window is finished once, whatever interrupts it", "A
 * budget stops a pass without losing work").
 *
 * The crash matrix stops a pass at every checkpoint it passes, one run
 * per checkpoint, and lets a new pass finish: the store must end in the
 * records of an uninterrupted pass, with one set of audit events and one
 * spend of each allowance.
 */
import { afterEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";

import { appendApplyEvidence } from "../../../../src/core/brain/apply-evidence.ts";
import { existsSync } from "node:fs";

import { dream } from "../../../../src/core/brain/dream.ts";
import { workrunPath } from "../../../../src/core/brain/dream-workrun.ts";
import { DREAM_WINDOW_PLAN_KIND } from "../../../../src/core/brain/dream-replay/records.ts";
import * as healRun from "../../../../src/core/brain/heal-run.ts";
import { setBrainSetting } from "../../../../src/core/brain/policy/settings-write.ts";
import type { DreamRunSummary } from "../../../../src/core/brain/dream-types.ts";
import type { ProgressEvent } from "../../../../src/core/brain/progress.ts";
import { writePreference } from "../../../../src/core/brain/preference.ts";
import type { Safeguard } from "../../../../src/core/brain/safeguard.ts";
import { writeSignal } from "../../../../src/core/brain/signal.ts";
import { dumpStore, firstDreamHistoryDifference } from "../../../helpers/dream-history.ts";
import {
  makeDreamReplayFixture,
  type DreamReplayFixture,
} from "../../../helpers/dream-replay-fixtures.ts";
import { at, dateOf, dumpRowsOf } from "../../../helpers/dream-replay-scenarios.ts";
import { partitionRecords } from "../store-only/fixtures.ts";

const opened: DreamReplayFixture[] = [];
afterEach(() => {
  setSystemTime();
  // Newest first: each fixture restores the environment it found.
  for (const f of opened.splice(0).toReversed()) f.cleanup();
});

function end(day: number): Date {
  return new Date(`${dateOf(day)}T23:59:59.999Z`);
}

const ALPHA = "Always pin exact dependency versions in every manifest file.";

/** A brain covered through day 0 whose next three windows each change something. */
function busyBrain(): DreamReplayFixture {
  const f = makeDreamReplayFixture();
  opened.push(f);
  const human = { vault: f.vault, authority: "human" as const, agent: "test" };
  setBrainSetting(human, "cross_topic.enabled", true);
  const pref = (slug: string, topic: string, principle: string, status = "confirmed") =>
    writePreference(f.vault, {
      slug,
      topic,
      principle,
      created_at: at(0, 0),
      unconfirmed_until: status === "confirmed" ? at(14, 0) : at(2, 12),
      status: status as "confirmed" | "unconfirmed",
      confirmed_at: status === "confirmed" ? at(0, 0) : null,
      evidenced_by: [],
      scope: "coding",
    });
  pref("alpha-one", "deps", ALPHA);
  pref("alpha-two", "packaging", ALPHA);
  pref("trial", "trial-topic", "Keep the trial rule.", "unconfirmed");
  pref("used", "used-topic", "Keep the used rule.");
  f.cover(dateOf(0));
  for (const [slug, agent, day] of [
    ["s1", "claude", 1],
    ["s2", "codex", 1],
    ["s3", "hermes", 2],
  ] as const) {
    writeSignal(f.vault, {
      topic: "tabs",
      signal: "positive",
      agent,
      principle: "Follow the rule of tabs.",
      created_at: at(day, 9),
      date: dateOf(day),
      slug,
      scope: "coding",
    });
  }
  for (const day of [1, 2, 3]) {
    appendApplyEvidence(
      f.vault,
      {
        pref_id: "pref-used",
        artifact: `Daily/${dateOf(day)}.md`,
        result: "applied",
        agent: "c",
      },
      { now: new Date(at(day, 10)) },
    );
  }
  return f;
}

/**
 * Stop the wall clock the replay budget reads (`Date.now()`) and let the
 * test move it: the budget then runs out exactly where the test spends
 * it, never earlier on a slow machine.
 */
function frozenClock(): { readonly spend: (ms: number) => void } {
  let now = Date.now();
  setSystemTime(new Date(now));
  return {
    spend(ms) {
      now += ms;
      setSystemTime(new Date(now));
    },
  };
}

/** Set the replay budget of `f`'s brain. */
function budget(f: DreamReplayFixture, ms: number): void {
  setBrainSetting(
    { vault: f.vault, authority: "human", agent: "test" },
    "dream.replay_budget_ms",
    ms,
  );
}

/** How many snapshots the store's log records. */
function snapshotEvents(f: DreamReplayFixture): number {
  return partitionRecords(f.storeRoot, "shared").filter(
    (r) => r.kind === "log-event" && r.body["event_type"] === "snapshot",
  ).length;
}

/** A safeguard that counts its checkpoints and stops at the `stopAt`-th one. */
function stopping(stopAt: number): Safeguard & { readonly calls: () => number } {
  let calls = 0;
  return {
    operation: "dream",
    timeoutMs: null,
    calls: () => calls,
    checkpoint() {
      calls += 1;
      if (calls === stopAt) throw new Error(`stopped at checkpoint ${stopAt}`);
    },
  };
}

/** The topic stage takes a stop as "plan topics next pass" (`dream-tail.ts`): the pass returns. */
const TOPICS_LEFT = "topics left to the next pass";

/** How a pass under `safeguard` ended: the stop it threw, or what it finished. */
function outcomeOf(run: () => DreamRunSummary): string {
  try {
    return run().topics === undefined ? TOPICS_LEFT : "finished";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe("dream replay: a window is finished once", () => {
  test("a stop at any checkpoint, then a new pass, ends in the uninterrupted records", () => {
    const reference = busyBrain();
    const counter = stopping(Number.POSITIVE_INFINITY);
    expect(outcomeOf(() => dream(reference.vault, { now: end(3), safeguard: counter }))).toBe(
      "finished",
    );
    const expected = dumpStore(reference.storeRoot);
    const total = counter.calls();
    expect(total).toBeGreaterThan(10);
    // Every checkpoint is a stop point; a sample of them keeps the file fast.
    const points = [...new Set([1, 2, 3, 5, 8, 13, 21, 34, total - 2, total - 1, total])].filter(
      (n) => n >= 1 && n <= total,
    );
    for (const stopAt of points) {
      const f = busyBrain();
      // The trial must really stop at its checkpoint: one that reaches
      // fewer checkpoints would compare an uninterrupted pass and prove
      // nothing. A stop throws, except in the topic stage, which takes it.
      const trial = stopping(stopAt);
      const outcome = outcomeOf(() => dream(f.vault, { now: end(3), safeguard: trial }));
      expect({ stopAt, reached: trial.calls() >= stopAt }).toEqual({ stopAt, reached: true });
      expect([`stopped at checkpoint ${stopAt}`, TOPICS_LEFT]).toContain(outcome);
      dream(f.vault, { now: end(3) });
      const difference = firstDreamHistoryDifference(expected, dumpStore(f.storeRoot));
      expect({ stopAt, difference }).toEqual({ stopAt, difference: null });
    }
  }, 120_000);

  test("a resumed window decides nothing again: it applies the plan it froze", () => {
    const f = busyBrain();
    // Stop inside window 1, after its plan record.
    let stopNext = false;
    const guard: Safeguard = {
      operation: "dream",
      timeoutMs: null,
      checkpoint() {
        if (stopNext) throw new Error("stopped after the plan");
        stopNext = f.replayRecords().some((r) => r.kind === DREAM_WINDOW_PLAN_KIND);
      },
    };
    expect(() => dream(f.vault, { now: end(3), safeguard: guard })).toThrow();
    const plans = () => f.replayRecords().filter((r) => r.kind === DREAM_WINDOW_PLAN_KIND);
    expect(plans()).toHaveLength(1);
    const first = plans()[0]!;
    dream(f.vault, { now: end(3) });
    // Window 1 has one plan, the same record; the later windows one each.
    const byWindow = new Map<string, number>();
    for (const plan of plans()) {
      const window = String(plan.body["window"]);
      byWindow.set(window, (byWindow.get(window) ?? 0) + 1);
    }
    expect([...byWindow.values()].every((n) => n === 1)).toBe(true);
    expect(plans()[0]!.id).toBe(first.id);
  });

  test("the budget spent inside a window ends the pass; the next pass applies the same plan", () => {
    // One fixture at a time: each points the process at its own store.
    const reference = busyBrain();
    dream(reference.vault, { now: end(3) });
    const expected = dumpStore(reference.storeRoot);
    const f = busyBrain();
    budget(f, 200);
    const clock = frozenClock();
    // The fifth checkpoint takes longer than the whole budget.
    let calls = 0;
    const slow: Safeguard = {
      operation: "dream",
      timeoutMs: null,
      checkpoint() {
        calls += 1;
        if (calls === 5) clock.spend(300);
      },
    };
    const stopped = dream(f.vault, { now: end(3), safeguard: slow });
    expect(stopped.warnings.map((w) => w.code)).toContain("dream-replay-budget");
    expect(stopped.windows?.behind).toBeGreaterThan(0);
    const open = f.replayState().open;
    expect(open).not.toBeNull();
    // The clock stands still, so the next pass cannot spend its budget.
    dream(f.vault, { now: end(3) });
    expect(f.replayState().lastCovered).toBe(dateOf(3));
    expect(firstDreamHistoryDifference(expected, dumpStore(f.storeRoot))).toBeNull();
  });

  test("the budget spent between windows leaves the next window untouched", () => {
    const f = busyBrain();
    budget(f, 200);
    const clock = frozenClock();
    // The end of the first window's stream takes longer than the budget.
    let spent = false;
    const result = dream(f.vault, {
      now: end(3),
      onProgress: (event) => {
        if (!spent && event.stage === "finalize" && event.kind === "advanced") {
          spent = true;
          clock.spend(300);
        }
      },
    });
    expect(result.windows).toEqual({
      evaluated: 1,
      covered: dateOf(1),
      behind: 2,
      open: dateOf(2),
    });
    const admitted = f.replayRecords().filter((r) => r.kind === "dream-admission");
    expect(admitted.map((r) => r.body["day"])).toEqual([dateOf(1)]);
  });

  test("the budget spent in the first window after its scan ends the pass with a legal progress stream", () => {
    const f = busyBrain();
    budget(f, 200);
    const clock = frozenClock();
    const events: ProgressEvent[] = [];
    // The first window's apply takes longer than the budget: no window of
    // the pass finishes, and its stream has already left the scan.
    const result = dream(f.vault, {
      now: end(3),
      onProgress: (event) => {
        events.push(event);
        if (event.stage === "apply" && event.kind === "started") clock.spend(300);
      },
    });
    expect(result.warnings.map((w) => w.code)).toContain("dream-replay-budget");
    expect(result.warnings.map((w) => w.code)).not.toContain("progress-sink-failed");
    expect(result.windows).toEqual({
      evaluated: 0,
      covered: dateOf(0),
      behind: 3,
      open: dateOf(1),
    });
    // Stages are per window: the window the budget cut short ends in the
    // stage it was in, and the pass goes on to its end; nothing is
    // reported for a stage that is not the current one.
    let current: string | null = null;
    for (const event of events) {
      if (event.kind === "started") current = event.stage;
      if (event.kind === "advanced")
        expect({ event, current }).toEqual({ event, current: event.stage });
    }
    expect(events.filter((e) => e.kind === "started" && e.stage === "scan")).toHaveLength(1);
    expect(events.filter((e) => e.kind === "finished")).toHaveLength(1);
    expect(events.at(-1)?.kind).toBe("finished");
    // The next pass finishes the window from the plan it froze.
    dream(f.vault, { now: end(3) });
    expect(f.replayState().lastCovered).toBe(dateOf(3));
  });

  test("a pass whose windows plan nothing takes no snapshot", () => {
    const f = makeDreamReplayFixture();
    opened.push(f);
    f.cover(dateOf(0));
    dream(f.vault, { now: end(3) });
    expect(snapshotEvents(f)).toBe(0);
    expect(f.replayState().lastCovered).toBe(dateOf(3));
  });

  test("a replay takes one snapshot however many windows change", () => {
    const f = busyBrain();
    dream(f.vault, { now: end(3) });
    expect(snapshotEvents(f)).toBe(1);
  });

  test("a window after the snapshot names its workrun after itself, not the run id ladder", () => {
    const f = busyBrain();
    dream(f.vault, { now: end(3) });
    const run = "dream-2026-04-04-235959";
    // Window 1 took the pass's snapshot and run id; windows 2 and 3 are named.
    expect(existsSync(workrunPath(f.vault, run))).toBe(true);
    expect(existsSync(workrunPath(f.vault, `${run}-${dateOf(2)}`))).toBe(true);
    expect(existsSync(workrunPath(f.vault, `${run}-${dateOf(3)}`))).toBe(true);
    expect(existsSync(workrunPath(f.vault, `${run}-2`))).toBe(false);
  });

  test("heal enrichment runs once per pass, after the last window", () => {
    const f = busyBrain();
    const spy = spyOn(healRun, "runHealEnrichment");
    try {
      dream(f.vault, { now: end(3), gates: { heal_enrich: true } });
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  test("audit events carry the window and the effect, and none is written twice", () => {
    const f = busyBrain();
    dream(f.vault, { now: end(3) });
    const events = dumpRowsOf(dumpStore(f.storeRoot), "log-event")
      .map((row) => row.body["body"] as Record<string, unknown>)
      .filter((body) => typeof body["effect"] === "string");
    expect(events.length).toBeGreaterThan(0);
    const effects = events.map((body) => body["effect"]);
    expect(new Set(effects).size).toBe(effects.length);
    expect(events.every((body) => typeof body["window"] === "string")).toBe(true);
  });
});

describe("dream replay: a plan of another encoding", () => {
  test("an open window whose plan has another version is planned again, and the new plan is kept", () => {
    const f = makeDreamReplayFixture();
    opened.push(f);
    f.cover(dateOf(0));
    const day = dateOf(1);
    f.append("dream-admission", {
      day,
      window: day,
      from: `${day}T00:00:00.000Z`,
      to: `${day}T23:59:59.999Z`,
      positions: [],
      gaps: [],
      late: [],
      clamped: [],
      left_out: [],
      rebased: null,
      admitted_at: `${day}T23:00:00.000Z`,
      run: "fixture",
    });
    f.append(DREAM_WINDOW_PLAN_KIND, {
      day,
      window: day,
      version: 0,
      effects: [],
      frozen: null,
    });
    const stale = f.replayRecords().find((r) => r.kind === DREAM_WINDOW_PLAN_KIND)!;
    dream(f.vault, { now: end(1) });
    const coverage = f
      .replayRecords()
      .find((r) => r.kind === "dream-coverage" && r.body["window"] === day)!;
    expect(coverage.body["plan"]).not.toBe(stale.id);
    const plan = f.replayRecords().find((r) => r.id === coverage.body["plan"]);
    expect(plan?.body["version"]).toBe(1);
    expect(f.replayState().plans.get(day)?.id).toBe(plan?.id);
  });
});
