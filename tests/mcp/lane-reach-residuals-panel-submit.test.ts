/**
 * A refused panel step leaves nothing of the step (change
 * `lane-reach-residuals`, package 9, design R7, residual F2): below local
 * reach a panel submit on a session whose target the store holds in
 * `private` (it became one since the open) is refused with the fixed
 * answer right after the session is loaded, before the step is validated:
 * a persona step, an invalid step, a colliding synthesis and a
 * direct-commit synthesis with the opt-in metric all leave the session
 * record, the failed attempts and the metrics ledger unchanged. A local
 * submit on the same kind of store behaves as before.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import {
  openPanelSession,
  submitToPanelSession,
} from "../../src/core/brain/write-session/panel.ts";
import { withPrivateWithheld } from "../../src/core/store/caller-reach.ts";
import { laneEntryInPrivate, writeLanePage } from "../../src/core/store/lane-pages.ts";
import { readPartition } from "../../src/core/store/state-digest.ts";
import { makeLaneEnv, type LaneEnv } from "../core/lanes/fixtures/lane-env.ts";
import { REGION } from "./lane-private-partition-reach-writes-fixture.ts";

const WITHHELD = "this entry cannot be written at this reach";
const TOPIC = "Zqsubmit topic";
const TARGET = "Brain/decisions/panels/zqsubmit-panel.md";
const NOW = "2026-11-20T10:00:00.000Z";
const LATER = "2026-11-20T10:05:00.000Z";

const lanes: LaneEnv[] = [];
afterEach(() => {
  for (const lane of lanes.splice(0)) lane.cleanup();
});

/** Every record of both partitions, by id, as the store holds them. */
function rawRecords(e: LaneEnv): string {
  const ids = (partition: "shared" | "private") =>
    readPartition(join(e.env.storeRoot, partition))
      .flatMap((shard) => shard.all)
      .map((r) => r.id)
      .toSorted();
  return JSON.stringify({ shared: ids("shared"), private: ids("private") });
}

/** `<name>: <message>` of what `fn` throws, or its answer serialized. */
function outcome(fn: () => unknown): string {
  try {
    return JSON.stringify(fn());
  } catch (err) {
    return `${(err as Error).name}: ${(err as Error).message}`;
  }
}

type Step = "persona" | "invalid" | "colliding-synthesis" | "direct-commit-synthesis";

/**
 * A one-persona panel session at `TARGET` opened at the given reach, at
 * the synthesis step when `step` is a synthesis; then the target is held
 * in `private` (a local writer published a private page there).
 */
function sessionOnHeldTarget(remote: boolean, step: Step): { e: LaneEnv; id: string } {
  const e = makeLaneEnv("store", `osb-lane-panel-submit-${step}-`);
  lanes.push(e);
  const id = withPrivateWithheld(remote, () => {
    const opened = openPanelSession(e.vault, {
      agent: "tester",
      topic: TOPIC,
      personas: ["technical"],
      targetPath: TARGET,
      now: NOW,
    });
    if (step === "colliding-synthesis" || step === "direct-commit-synthesis") {
      submitToPanelSession(e.vault, { sessionId: opened.session_id, text: "answer", now: NOW });
    }
    return opened.session_id;
  });
  writeLanePage(e.vault, join(e.vault, TARGET), { topic: TOPIC }, `held ${REGION}\n`);
  expect(laneEntryInPrivate(e.vault, join(e.vault, TARGET))).toBe(true);
  return { e, id };
}

/** The submit of `step` on session `id` at the given reach. */
function submit(e: LaneEnv, remote: boolean, id: string, step: Step): string {
  return outcome(() =>
    withPrivateWithheld(remote, () =>
      submitToPanelSession(e.vault, {
        sessionId: id,
        text: step === "invalid" ? "   " : `zqsubmit ${step}`,
        now: LATER,
        ...(step === "direct-commit-synthesis" ? { promptPrefixMetric: true } : {}),
      }),
    ),
  );
}

const STEPS: ReadonlyArray<Step> = [
  "persona",
  "invalid",
  "colliding-synthesis",
  "direct-commit-synthesis",
];

describe("a refused panel step leaves nothing of the step", () => {
  for (const step of STEPS) {
    test(`${step}: a remote submit on a target held in private is refused and writes nothing`, () => {
      const { e, id } = sessionOnHeldTarget(true, step);
      const before = rawRecords(e);
      expect(submit(e, true, id, step)).toBe(`LaneEntryWithheldError: ${WITHHELD}`);
      expect(rawRecords(e)).toEqual(before);
    });
  }

  test("persona: a local submit advances the session", () => {
    const { e, id } = sessionOnHeldTarget(false, "persona");
    const answer = JSON.parse(submit(e, false, id, "persona")) as Record<string, unknown>;
    expect(answer["status"]).toBe("needs-llm-step");
  });

  test("invalid: a local submit records a failed attempt with its validation errors", () => {
    const { e, id } = sessionOnHeldTarget(false, "invalid");
    const before = rawRecords(e);
    const answer = JSON.parse(submit(e, false, id, "invalid")) as Record<string, unknown>;
    expect((answer["errors"] as ReadonlyArray<unknown>).length).toBeGreaterThan(0);
    expect(rawRecords(e)).not.toEqual(before);
  });

  for (const step of ["colliding-synthesis", "direct-commit-synthesis"] as const) {
    test(`${step}: a local submit is refused by the occupied target`, () => {
      const { e, id } = sessionOnHeldTarget(false, step);
      const answer = submit(e, false, id, step);
      expect(answer).toContain(`${TARGET} already exists`);
    });
  }
});
