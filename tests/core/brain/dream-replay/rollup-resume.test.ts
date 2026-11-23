/**
 * A resumed window reuses its rollup target paths (dream replay task 5.1,
 * design D4.6): the paths are frozen in the window's plan with the run id
 * of the run that planned it, so a later run that finishes the window
 * queues the same targets an uninterrupted run queues.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";

import { dream } from "../../../../src/core/brain/dream.ts";
import { assertDreamOwner } from "../../../../src/core/brain/dream-owner/gate.ts";
import { claimDreamOwner } from "../../../../src/core/brain/dream-owner/owner.ts";
import { DREAM_WORK_EVIDENCE_MAX } from "../../../../src/core/brain/dream-queue/constants.ts";
import * as queueModule from "../../../../src/core/brain/dream-queue/queue.ts";
import { readDreamWork } from "../../../../src/core/brain/dream-queue/queue.ts";
import {
  DREAM_COVERAGE_KIND,
  DREAM_WINDOW_PLAN_KIND,
} from "../../../../src/core/brain/dream-replay/records.ts";
import { setBrainSetting } from "../../../../src/core/brain/policy/settings-write.ts";
import { writePreference } from "../../../../src/core/brain/preference.ts";
import type { Safeguard } from "../../../../src/core/brain/safeguard.ts";
import { openStore } from "../../../../src/core/store/store-open.ts";
import {
  makeDreamReplayFixture,
  type DreamReplayFixture,
} from "../../../helpers/dream-replay-fixtures.ts";
import { at, dateOf } from "../../../helpers/dream-replay-scenarios.ts";

const opened: DreamReplayFixture[] = [];
afterEach(() => {
  // Newest first: each fixture restores the environment it found.
  for (const f of opened.splice(0).toReversed()) f.cleanup();
});

function end(day: number): Date {
  return new Date(`${dateOf(day)}T23:59:59.999Z`);
}

/** A covered brain with an owner whose window of day 1 fires the fact rung. */
function rollupBrain(slugs: ReadonlyArray<string> = ["a", "b", "c"]): DreamReplayFixture {
  const f = makeDreamReplayFixture();
  opened.push(f);
  const human = { vault: f.vault, authority: "human" as const, agent: "t" };
  setBrainSetting(human, "rollup.fact_threshold", 3);
  for (const slug of slugs) {
    writePreference(f.vault, {
      slug,
      topic: slug,
      principle: `Keep rule ${slug}.`,
      created_at: at(0, 0),
      unconfirmed_until: at(14, 0),
      status: "confirmed",
      confirmed_at: at(0, 0),
      evidenced_by: [],
      scope: "coding",
    });
  }
  f.cover(dateOf(0));
  claimDreamOwner(openStore({ root: f.storeRoot, device: "dev-a" }), "claude", {
    writer: "o2b",
    authority: "human",
  });
  // The claim settles at the look after the one that first saw it.
  try {
    assertDreamOwner(f.vault, { live: true });
  } catch {
    // first look: unsettled
  }
  return f;
}

function targets(f: DreamReplayFixture): string[] {
  const state = readDreamWork(openStore({ root: f.storeRoot, device: "dev-a" }), {
    now: end(9).getTime(),
  });
  return state.order.map((id) => String(state.items.get(id)!.body.payload["target_path"]));
}

function stopping(stopAt: number): Safeguard {
  let calls = 0;
  return {
    operation: "dream",
    timeoutMs: null,
    checkpoint() {
      calls += 1;
      if (calls === stopAt) throw new Error(`stopped at checkpoint ${stopAt}`);
    },
  };
}

describe("dream replay: a resumed window", () => {
  test("queues the rollup targets its plan froze, not ones named after the resuming run", () => {
    const reference = rollupBrain();
    dream(reference.vault, { now: end(1) });
    const expected = targets(reference);
    expect(expected).toHaveLength(1);
    // Named after the run of day 1, the run that planned the window.
    expect(expected[0]).toContain(`dream-${dateOf(1)}-`);

    // Stop the pass at the first checkpoint where the window's plan is
    // written and its model work is not queued yet.
    let resumed: DreamReplayFixture | null = null;
    for (let stopAt = 1; stopAt < 200 && resumed === null; stopAt++) {
      const f = rollupBrain();
      try {
        dream(f.vault, { now: end(1), safeguard: stopping(stopAt) });
      } catch (error) {
        expect(String(error)).toContain(`stopped at checkpoint ${stopAt}`);
      }
      const planned = f.replayRecords().some((r) => r.kind === DREAM_WINDOW_PLAN_KIND);
      if (planned && targets(f).length === 0) resumed = f;
    }
    expect(resumed).not.toBeNull();
    // A later run, with its own run id, finishes the open window.
    dream(resumed!.vault, { now: end(2) });
    expect(targets(resumed!)).toEqual(expected);
    expect(expected[0]).not.toContain(`dream-${dateOf(2)}-`);
  }, 120_000);

  test("a window whose rollup work was not all queued stays open until a later pass queues it", () => {
    // Two chunks of fact evidence: the second write of the window fails.
    const slugs = Array.from(
      { length: DREAM_WORK_EVIDENCE_MAX + 1 },
      (_, i) => `f${String(i).padStart(3, "0")}`,
    );
    const f = rollupBrain(slugs);
    const original = queueModule.produceWork;
    const produce = spyOn(queueModule, "produceWork");
    let calls = 0;
    produce.mockImplementation((...args) => {
      calls += 1;
      if (calls === 2) throw new Error("temporary queue write failure");
      return original(...args);
    });
    const coveredDays = (): string[] =>
      f
        .replayRecords()
        .filter((r) => r.kind === DREAM_COVERAGE_KIND)
        .map((r) => String(r.body["day"]));
    const facts = (): string[] => {
      const state = readDreamWork(openStore({ root: f.storeRoot, device: "dev-a" }), {
        now: end(9).getTime(),
      });
      return state.order.flatMap((id) => [...state.items.get(id)!.body.evidence]);
    };
    try {
      const first = dream(f.vault, { now: end(1), agentName: "claude" });
      expect(first.warnings.map((w) => w.code)).toContain("dream-queue-produce-failed");
      // The window's plan is written; its coverage is not.
      expect(f.replayRecords().some((r) => r.kind === DREAM_WINDOW_PLAN_KIND)).toBe(true);
      expect(coveredDays()).not.toContain(dateOf(1));
      expect(first.windows?.open).toBe(dateOf(1));
      expect(facts()).toHaveLength(DREAM_WORK_EVIDENCE_MAX);
    } finally {
      produce.mockRestore();
    }
    // A later pass finishes the open window from its plan.
    dream(f.vault, { now: end(2), agentName: "claude" });
    const handed = facts();
    expect(handed.toSorted()).toEqual(slugs.map((s) => `pref-${s}`).toSorted());
    expect(new Set(handed).size).toBe(handed.length);
    expect(coveredDays()).toContain(dateOf(1));
    // Every item of the window is named after its day.
    const state = readDreamWork(openStore({ root: f.storeRoot, device: "dev-a" }), {
      now: end(9).getTime(),
    });
    for (const id of state.order) {
      expect(state.items.get(id)!.body.occurrence.startsWith(`${dateOf(1)}/`)).toBe(true);
    }
  }, 120_000);
});
