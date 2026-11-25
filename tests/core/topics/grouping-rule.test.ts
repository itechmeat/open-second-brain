/**
 * The grouping rule (`plan.ts` `groups`): records join by their subject,
 * not by the workflow words every project writes. A word a large share of
 * the pool says joins nothing, a record joins a group on three shared
 * signature words, and a theme led twice is proposed once.
 */

import { expect, test } from "bun:test";
import type { TopicCandidate } from "../../../src/core/topics/candidates.ts";
import { foldTopics } from "../../../src/core/topics/fold.ts";
import { planTopics } from "../../../src/core/topics/plan.ts";

const SETTINGS = { minRecords: 5, minSessions: 2, quietDays: 30 };

function note(n: number, text: string): TopicCandidate {
  return {
    id: `r${String(n).padStart(3, "0")}`,
    kind: "note",
    text,
    project: null,
    session: `s${n % 3}`,
    at: n,
    private: false,
    topic: null,
  };
}

/** Workflow words every project writes, in more records than the rule calls rare. */
const WORKFLOW = "merged opened released branch ready review";

/** Thirty records of thirty projects that share only the workflow words. */
function busyDay(): TopicCandidate[] {
  return Array.from({ length: 30 }, (_, i) => note(i, `project${i} component${i} ${WORKFLOW}`));
}

function askedMembers(candidates: ReadonlyArray<TopicCandidate>, minRecords = 5): string[][] {
  const plan = planTopics(foldTopics([]), candidates, { ...SETTINGS, minRecords }, 0);
  return plan.asks.groups.map((g) => [...g.members]);
}

test("records that share only common workflow words do not group", () => {
  expect(askedMembers(busyDay())).toEqual([]);
});

test("records that share a rare subject group, whatever workflow words they also say", () => {
  const subject = [100, 101, 102, 103, 104].map((n) =>
    note(n, `vaultwarden backup restore drill ${WORKFLOW} step${n}`),
  );
  expect(askedMembers([...busyDay(), ...subject])).toEqual([subject.map((c) => c.id)]);
});

test("one theme led twice is proposed as one group, not two", () => {
  // The second leader shares two words with the first (one short of a
  // join), but the two groups' cores share them: one theme, one proposal.
  const first = [200, 201, 202].map((n) => note(n, `garden watering schedule alley beds`));
  const second = [203, 204, 205].map((n) => note(n, `garden watering hoses pump timer`));
  expect(askedMembers([...first, ...second], 3)).toEqual([[...first, ...second].map((c) => c.id)]);
});
