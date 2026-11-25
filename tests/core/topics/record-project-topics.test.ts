/**
 * Records carry the project they were written in (design D17, "What
 * planning reads"). A note, a signal and a decision written through the
 * MCP handlers of a server launched inside a linked project carry that
 * project, and on the next dream pass records of two sessions of that
 * project form a topic scoped to it; a server launched outside every
 * linked project writes no project, never a guess. The project is an
 * attribute only: records that name none form a topic by theme too.
 */
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { dreamAnswered } from "../../helpers/closed-answers.ts";
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
  // Outside every linked project: no project; it joins by theme when it fits.
  const outside = server(a, elsewhere);
  await call(outside, "brain_note", { text: `${SUBJECT} outside`, agent: "agent-three" });

  const written = stampedProjects(a).filter((r) => r.text.startsWith(SUBJECT));
  expect(written.filter((r) => r.project === "release-tool")).toHaveLength(5);
  expect(written.find((r) => r.text.endsWith("outside"))?.project).toBeUndefined();

  const report = dreamAnswered(a.vault, a.store()).topics?.report;
  expect(report?.status).toBe("planned");
  if (report?.status !== "planned") return;
  // The note written outside every linked project names no project and
  // joins by theme; the topic keeps the one project its other records name.
  expect(report.created).toHaveLength(1);
  expect(report.created[0]!.members).toBe(6);
  const topic = a.records().find((r) => r.kind === "topic-create")!;
  expect(topic.body["scope"]).toBe("project:release-tool");
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

test("records that name no project, from two sessions, form a topic with no project", async () => {
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
  const report = dreamAnswered(a.vault, a.store()).topics?.report;
  expect(report?.status).toBe("planned");
  if (report?.status !== "planned") return;
  expect(report.created.map((c) => c.members)).toEqual([5]);
  const topic = a.records().find((r) => r.kind === "topic-create")!;
  expect(topic.body["scope"]).toBe("personal");
  // Made of shared records, the topic is shared: the human view shows it.
  expect(report.shared.created).toBe(1);

  const block = buildStoreStatusBlock({ vault: a.vault, configPath: null }) as {
    topics: { created: number; unassigned: number; without_project: number };
  };
  expect(block.topics.created).toBe(1);
  expect(block.topics).not.toHaveProperty("advice");
});
