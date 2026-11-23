/**
 * Records carry the project they were written in, so topic planning can
 * make topics from them (design D17, "What planning reads"). A note, a
 * signal and a decision written through the MCP handlers of a server
 * launched inside a linked project carry that project, and on the next
 * dream pass records of two sessions of that project form a topic; a
 * server launched outside every linked project writes no project, never a
 * guess, and its records join no topic.
 */
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { dreamAnswered } from "../../helpers/closed-answers.ts";
import { runDoctor } from "../../../src/core/brain/doctor.ts";
import { TOPICS_WITHOUT_PROJECT_CODE } from "../../../src/core/brain/doctor/topic-plan-check.ts";
import { buildStoreStatusBlock } from "../../../src/core/store/store-status.ts";
import { readTopicPlanOutcome } from "../../../src/core/topics/plan-outcome.ts";
import { recordDecision } from "../../../src/core/brain/decisions/record.ts";
import { appendBrainNote } from "../../../src/core/brain/note.ts";
import { writeSignal } from "../../../src/core/brain/signal.ts";
import { topicCandidates } from "../../../src/core/topics/candidates.ts";
import { writeVaultPointer } from "../../../src/core/brain/portability/pointer.ts";
import { runMigration } from "../../../src/core/store-migration/migrate.ts";
import { CLI_SPAWN_BUDGET_MS } from "../../helpers/cli-timeout.ts";
import { makeFleet, type Fleet, type Machine } from "../store-migration/fixtures/fleet.ts";
import { callTool, serverIn, stampedProjects, switchedMachine } from "./fixtures/record-project.ts";

setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

const SUBJECT = "Release notes list every migration step";

let fleet: Fleet | null = null;
afterEach(() => {
  fleet?.cleanup();
  fleet = null;
});

/** A switched machine holding the view writer role. */
function machine(): Machine {
  const made = switchedMachine();
  fleet = made.fleet;
  return made.machine;
}

const server = serverIn;
const call = async (...args: Parameters<typeof callTool>): Promise<void> => {
  await callTool(...args);
};

test("notes, signals and decisions written in a linked project carry it and form a topic", async () => {
  const a = machine();
  const project = join(fleet!.parent, "work", "release-tool");
  mkdirSync(project, { recursive: true });
  writeVaultPointer(project, a.vault);
  const elsewhere = join(fleet!.parent, "work", "scratch");
  mkdirSync(elsewhere, { recursive: true });

  // Two sessions of one project: two agents, each in its own server.
  const one = server(a, join(project, "src"));
  const two = server(a, project);
  await Promise.all(
    [0, 1, 2].map((i) => call(one, "brain_note", { text: `${SUBJECT} ${i}`, agent: "agent-one" })),
  );
  await call(two, "brain_note", { text: `${SUBJECT} again`, agent: "agent-two" });
  await call(two, "brain_feedback", {
    topic: "release-notes",
    signal: "positive",
    principle: `${SUBJECT} in order`,
    agent: "agent-two",
  });
  // Outside every linked project: no project, and no topic from it.
  const outside = server(a, elsewhere);
  await call(outside, "brain_note", { text: `${SUBJECT} outside`, agent: "agent-three" });

  const written = stampedProjects(a).filter((r) => r.text.startsWith(SUBJECT));
  expect(written.filter((r) => r.project === "release-tool")).toHaveLength(5);
  expect(written.find((r) => r.text.endsWith("outside"))?.project).toBeUndefined();

  const report = dreamAnswered(a.vault, a.store()).topics?.report;
  expect(report?.status).toBe("planned");
  if (report?.status !== "planned") return;
  expect(report.created).toHaveLength(1);
  expect(report.created[0]!.members).toBe(5);
});

test("on a machine not yet switched the project rides the legacy day file and page, and the migration keeps it", () => {
  fleet = makeFleet(["dev-a"]);
  const a = fleet.machine("dev-a");
  a.use();
  const origin = { project: "release-tool", session: "s-42" };
  appendBrainNote({ vault: a.vault, text: `${SUBJECT} legacy`, agent: "solo", origin });
  writeSignal(a.vault, {
    topic: "release-notes",
    signal: "positive",
    agent: "solo",
    principle: `${SUBJECT} as a page`,
    created_at: "2026-11-10T08:00:00.000Z",
    date: "2026-11-10",
    slug: "release-notes",
    origin,
  });
  recordDecision(a.vault, {
    title: "Ship order",
    chosen: `${SUBJECT} first`,
    assumption: "Users read the notes",
    reviewDate: "2026-12-01",
    agent: "solo",
    origin,
  });
  expect(runMigration(a.vault, { settleMs: 0 }).ok).toBe(true);
  const found = topicCandidates(a.records(), new Set()).filter((c) => c.text.includes(SUBJECT));
  expect(found.map((c) => [c.project, c.session])).toEqual([
    ["release-tool", "s-42"],
    ["release-tool", "s-42"],
    ["release-tool", "s-42"],
  ]);
});

test("status and doctor say why the last pass made no topic when no unassigned record names a project", async () => {
  const a = machine();
  // Written outside every linked project: no project.
  const elsewhere = join(fleet!.parent, "work", "scratch");
  mkdirSync(elsewhere, { recursive: true });
  const s = server(a, elsewhere);
  await Promise.all(
    [0, 1, 2, 3, 4].map((i) =>
      call(s, "brain_note", { text: `${SUBJECT} ${i}`, agent: `agent-${i % 2}` }),
    ),
  );
  expect(readTopicPlanOutcome()).toBeNull();
  const summary = dreamAnswered(a.vault, a.store()).topics?.summary;
  expect(summary).toContain("names a project");

  const block = buildStoreStatusBlock({ vault: a.vault, configPath: null }) as {
    topics: { created: number; unassigned: number; without_project: number; advice: string };
  };
  expect(block.topics.created).toBe(0);
  expect(block.topics.without_project).toBe(block.topics.unassigned);
  expect(block.topics.unassigned).toBeGreaterThanOrEqual(5);
  expect(block.topics.advice).toContain("name no project");
  expect(block.topics.advice).toContain("o2b brain project link");

  const doctor = runDoctor(a.vault);
  const finding = (doctor.uncertain ?? []).find((u) => u.code === TOPICS_WITHOUT_PROJECT_CODE);
  expect(finding?.message).toContain("name no project");
});
