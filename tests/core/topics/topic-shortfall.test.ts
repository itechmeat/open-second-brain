/**
 * Why a dream pass made no topic of a project (field check, fourth rerun
 * item 15): twelve records of a linked project with a non-Latin name
 * (six notes, two signals, four decision events) made no topic, and the
 * pass said only that 12 of the records no topic holds name a project. The
 * rule is the documented one (a topic needs `topics.new_min_records`
 * related records from `topics.new_min_sessions` sessions, and records a
 * topic once held are never grouped again); the summary now says, per
 * project, which of them held the topic back and by how much.
 */
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { dream } from "../../../src/core/brain/dream.ts";
import { writeVaultPointer } from "../../../src/core/brain/portability/pointer.ts";
import { runTopicAction } from "../../../src/core/topics/actions.ts";
import type { TopicCandidate } from "../../../src/core/topics/candidates.ts";
import { foldTopics } from "../../../src/core/topics/fold.ts";
import { planTopics } from "../../../src/core/topics/plan.ts";
import { describeTopicPlanning } from "../../../src/core/topics/planning.ts";
import { emptyTopicVerdicts, topicGroupKey } from "../../../src/core/topics/verdicts.ts";
import type { MCPServer } from "../../../src/mcp/server.ts";
import { CLI_SPAWN_BUDGET_MS } from "../../helpers/cli-timeout.ts";
import type { Fleet, Machine } from "../store-migration/fixtures/fleet.ts";
import { callTool, serverIn, switchedMachine } from "./fixtures/record-project.ts";

setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

const PROJECT = "тема-четыре";
const SUBJECT = "Тема-четыре журнал изменений";

let fleet: Fleet | null = null;
afterEach(() => {
  fleet?.cleanup();
  fleet = null;
});

function project(): { a: Machine; server: MCPServer } {
  const made = switchedMachine();
  fleet = made.fleet;
  const dir = join(fleet.parent, "projects", PROJECT);
  mkdirSync(dir, { recursive: true });
  writeVaultPointer(dir, made.machine.vault);
  return { a: made.machine, server: serverIn(made.machine, dir) };
}

async function note(server: MCPServer, text: string, agent: string): Promise<void> {
  await callTool(server, "brain_note", { text: `${SUBJECT} ${text}`, agent });
}

/** Six notes, two signals and four decisions, all written by one agent in one session. */
async function fieldRecords(server: MCPServer): Promise<void> {
  for (const text of ["ведём в README", "один файл", "дата и тег", "автор", "ссылки", "проверка"]) {
    // eslint-disable-next-line no-await-in-loop
    await note(server, text, "one");
  }
  for (const tag of ["формат", "частота"]) {
    // eslint-disable-next-line no-await-in-loop
    await callTool(server, "brain_feedback", {
      topic: `changelog-${tag === "формат" ? "format" : "cadence"}`,
      signal: "positive",
      principle: `${SUBJECT}: ${tag}`,
      agent: "one",
    });
  }
  for (const [title, chosen] of [
    ["файл на релиз", "один файл"],
    ["колонки", "дата, тег, автор"],
    ["место", "README"],
    ["частота тегов", "раз в неделю"],
  ] as const) {
    // eslint-disable-next-line no-await-in-loop
    await callTool(server, "brain_decision", {
      action: "record",
      title: `${SUBJECT} ${title}`,
      chosen,
      assumption: "a",
      review_date: "2027-01-01",
      agent: "one",
    });
  }
}

function planned(a: Machine): { summary: string; report: Record<string, unknown> } {
  const topics = dream(a.vault).topics;
  if (topics?.report.status !== "planned") throw new Error(`not planned: ${topics?.report.status}`);
  return { summary: topics.summary, report: topics.report as unknown as Record<string, unknown> };
}

test("twelve records of one session make no topic, and the pass says it lacks a second session", async () => {
  const { a, server } = project();
  await fieldRecords(server);
  const { summary, report } = planned(a);
  expect(report["created"]).toEqual([]);
  expect(report["shortfalls"]).toEqual([
    {
      project: PROJECT,
      free: 12,
      closest: { records: 12, sessions: 1, kinds: { note: 6, signal: 2, decision: 4 } },
      heldBack: 0,
      vetoed: 0,
    },
  ]);
  expect(summary).toContain(
    `no topic was made: project ${PROJECT}: of its 12 records no topic holds, the group of related ` +
      "records closest to a topic has 12 records (6 notes, 2 signals and 4 decisions) from 1 session, " +
      "1 more session short of a topic, which needs 5 records from 2 sessions " +
      "(topics.new_min_records, topics.new_min_sessions)",
  );

  // One record of a second session is what was missing.
  await note(server, "из второй сессии", "two");
  const next = planned(a);
  expect((next.report["created"] as unknown[]).length).toBe(1);
  expect(next.summary).not.toContain("no topic was made");
});

test("too few related records: the pass says how many more a topic needs", async () => {
  const { a, server } = project();
  await note(server, "ведём в README", "one");
  await note(server, "один файл", "two");
  const { summary } = planned(a);
  expect(summary).toContain(
    `project ${PROJECT}: of its 2 records no topic holds, the group of related records ` +
      "closest to a topic has 2 records (2 notes) from 2 sessions, 3 more records short of a topic",
  );
});

test("records a topic held once are named as held back, not as missing", async () => {
  const { a, server } = project();
  await fieldRecords(server);
  await note(server, "из второй сессии", "two");
  const first = planned(a);
  const [made] = first.report["created"] as Array<{ undo: string; record: string }>;
  runTopicAction({ action: "undo", record: made!.record });
  const { summary, report } = planned(a);
  expect(report["created"]).toEqual([]);
  expect(summary).toContain(
    `project ${PROJECT}: 13 records a topic once held (an undone topic or assignment) are routed ` +
      "to a fitting topic but never grouped again",
  );
});

/** A note of the project, as planning reads it. */
function candidate(id: string, text: string, session: string, at: number): TopicCandidate {
  return { id, kind: "note", text, project: PROJECT, session, at, private: false, topic: null };
}

const SETTINGS = { minRecords: 5, minSessions: 2, quietDays: 30 };

test("the group named is the one closest to a topic, not the largest", () => {
  // At 5 records from 3 sessions: six records of one session are 2 sessions
  // short, four records of three sessions are 1 record short.
  const settings = { minRecords: 5, minSessions: 3, quietDays: 30 };
  const big = [0, 1, 2, 3, 4, 5].map((i) => candidate(`a${i}`, "журнал изменений README", "s1", i));
  const near = [0, 1, 2, 3].map((i) =>
    candidate(`b${i}`, "частота тегов релиза", `s${(i % 3) + 1}`, 10 + i),
  );
  const plan = planTopics(foldTopics([]), [...big, ...near], settings, 0);
  expect(plan.creates).toEqual([]);
  expect(plan.shortfalls[0]!.closest).toEqual({
    records: 4,
    sessions: 3,
    kinds: { note: 4, signal: 0, decision: 0 },
  });
  // Equally close (six of one session and three of three sessions are each
  // 2 short): the group with more records is named.
  const tie = planTopics(foldTopics([]), [...big, ...near.slice(0, 3)], settings, 0);
  expect(tie.shortfalls[0]!.closest.records).toBe(6);
  const even = planTopics(foldTopics([]), [...big.slice(0, 4), ...near], settings, 0);
  // 4 of 1 session (3 short) against 4 of 3 sessions (1 short).
  expect(even.shortfalls[0]!.closest.sessions).toBe(3);
});

test("a group a decision model vetoed is named as vetoed", () => {
  const members = [0, 1, 2, 3, 4].map((i) =>
    candidate(`v${i}`, "журнал изменений README", i % 2 === 0 ? "s1" : "s2", i),
  );
  const verdict = { use: "topic_new", model: "m", p: 0.1, confidence: 0.9 } as never;
  const verdicts = {
    ...emptyTopicVerdicts(),
    vetoes: new Map([[topicGroupKey(members.map((m) => m.id)), { verdict, veto: true }]]),
  };
  const plan = planTopics(foldTopics([]), members, SETTINGS, 0, verdicts);
  expect(plan.creates).toEqual([]);
  expect(plan.shortfalls).toEqual([
    {
      project: PROJECT,
      free: 5,
      closest: { records: 5, sessions: 2, kinds: { note: 5, signal: 0, decision: 0 } },
      heldBack: 0,
      vetoed: 1,
    },
  ]);
});

test("a planned topic whose record would be refused is named with the cause", () => {
  // The planner drafts a record the fold accepts for every project key it can
  // read today (keys are capped at 64 characters, titles and goals are clamped);
  // the pass still checks each create as the fold does, and says why one was
  // refused instead of printing a group that qualified with no cause.
  const summary = describeTopicPlanning({
    status: "planned",
    unheld: 5,
    unheldWithoutProject: 0,
    shared: { created: 0, unheld: 5, unheldWithoutProject: 0 },
    created: [],
    routed: [],
    merges: [],
    splits: [],
    quiet: [],
    shortfalls: [],
    thresholds: { minRecords: 5, minSessions: 2 },
    skipped: 0,
    invalid: 1,
    invalidCreates: [
      { scope: `project:${PROJECT}`, reason: "scope must be personal or project:<project>" },
    ],
    derived: 0,
    resolutions: 0,
    completions: 0,
    hidden: 0,
    kept: 0,
  });
  expect(summary).toContain(
    `; 1 planned topic was not created because the topic record would be refused: project:${PROJECT} ` +
      "(scope must be personal or project:<project>)",
  );
});
