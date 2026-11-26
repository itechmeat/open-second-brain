/**
 * Recall feedback below local reach (change `lane-private-partition-reach`,
 * the lead's answer to the feedback question of the write census).
 *
 * A feedback event is the call's own record, written with the attribution
 * the caller's search was shown. The fold into the machine's shared
 * learned weights reads every contribution on the whole fold: the
 * `search-feedback` ledger rows of every partition, so a remote feedback
 * never rewrites the weights from a narrowed set. The same event recorded
 * at local reach is the control.
 */

import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  computeLearnedWeights,
  learnedWeightsFile,
  loadFeedbackEvents,
  recordRecallFeedback,
  type RecallFeedbackEvent,
} from "../../src/core/search/feedback.ts";
import { withPrivateWithheld } from "../../src/core/store/caller-reach.ts";
import { readStreamRecords } from "../../src/core/store/read/stream-read.ts";
import { makeLaneEnv, type LaneEnv } from "../core/lanes/fixtures/lane-env.ts";

const lanes: LaneEnv[] = [];
afterEach(() => {
  for (const lane of lanes.splice(0)) lane.cleanup();
});

function event(ts: number, resultPath: string, keyword: number): RecallFeedbackEvent {
  return Object.freeze({
    ts,
    queryHash: `q${ts}`,
    resultPath,
    verdict: "up" as const,
    contributions: Object.freeze({ keyword, semantic: 1 - keyword, entity: 0, recency: 0 }),
  });
}

function weightsOnDisk(vault: string): Record<string, unknown> {
  return JSON.parse(readFileSync(learnedWeightsFile(vault), "utf8")) as Record<string, unknown>;
}

for (const remote of [false, true]) {
  test(`a ${remote ? "remote" : "local"} feedback folds the weights from every recorded contribution`, () => {
    const e = makeLaneEnv("store", "osb-lane-reach-feedback-");
    lanes.push(e);
    // Recorded at local reach first: on a machine that holds `private`,
    // the row lands there.
    recordRecallFeedback(e.vault, event(1_000, "notes/held.md", 0.9));
    recordRecallFeedback(e.vault, event(2_000, "notes/held-too.md", 0.8));
    const second = event(3_000, "notes/shown.md", 0.1);
    withPrivateWithheld(remote, () => recordRecallFeedback(e.vault, second));
    const held = readStreamRecords(e.env.storeRoot, "private", {
      stream: "ledgers",
      ledger: "search-feedback",
    }).records;
    expect(held.length).toBeGreaterThanOrEqual(2);
    const every = loadFeedbackEvents(e.vault);
    expect(every.map((ev) => ev.ts)).toEqual([1_000, 2_000, 3_000]);
    const folded = computeLearnedWeights(every);
    const disk = weightsOnDisk(e.vault);
    expect({
      events: disk["events"],
      keywordMul: disk["keywordMul"],
      semanticMul: disk["semanticMul"],
    }).toEqual({
      events: 3,
      keywordMul: folded.keywordMul,
      semanticMul: folded.semanticMul,
    });
  });
}
