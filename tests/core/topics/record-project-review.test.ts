/**
 * One rule owns a record's project from the writer to every reader: the
 * scoped-rules key of the linked directory's name (`scopedRuleKey`), which
 * keeps letters and marks of every script. The planner reads a record's
 * project without re-normalising it, so directories named in another
 * script or with an accent keep distinct projects, the planned topic is
 * scoped by the stamped key, and the session start digest, `o2b topic
 * list --scope` and a hand-made topic find it. A caller below local reach
 * gets no project stamped: the server's directory is not where it works.
 */
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { buildAgentContextBlocks } from "../../../hooks/lib/agent-context-blocks.ts";
import { createInjectionMeter, resolveInjectionLimits } from "../../../hooks/lib/active-context.ts";
import { dreamAnswered } from "../../helpers/closed-answers.ts";
import { withPrivateWithheld } from "../../../src/core/store/caller-reach.ts";
import { buildStoreStatusBlock } from "../../../src/core/store/store-status.ts";
import { readTopicPlanOutcome } from "../../../src/core/topics/plan-outcome.ts";
import { writeVaultPointer } from "../../../src/core/brain/portability/pointer.ts";
import { TRANSPORT_REACH } from "../../../src/core/graph/transport-reach.ts";
import { topicCandidates } from "../../../src/core/topics/candidates.ts";
import { runTopicAction } from "../../../src/core/topics/actions.ts";
import { readTopics } from "../../../src/core/topics/read.ts";
import { CLI_SPAWN_BUDGET_MS } from "../../helpers/cli-timeout.ts";
import type { Fleet } from "../store-migration/fixtures/fleet.ts";
import { callTool, serverIn, stampedProjects, switchedMachine } from "./fixtures/record-project.ts";

setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

let fleet: Fleet | null = null;
afterEach(() => {
  fleet?.cleanup();
  fleet = null;
});

/** Linked directory name, the key it stamps, and a subject of its own. */
const PROJECTS = [
  { dir: "Проект-X", key: "проект-x", subject: "Release notes list every migration step" },
  { dir: "café", key: "café", subject: "Menu cards print the allergens first" },
  { dir: "cafe", key: "cafe", subject: "Opening hours move to the summer table" },
  { dir: "日本語repo", key: "日本語repo", subject: "Translation memory exports keep the glossary" },
] as const;

test("projects named in any script keep their own key from the record to the topic and the digest", async () => {
  const made = switchedMachine();
  fleet = made.fleet;
  const a = made.machine;
  const dirs = new Map<string, string>();
  const writes: Array<Promise<unknown>> = [];
  for (const p of PROJECTS) {
    const dir = join(fleet.parent, "work", p.dir);
    mkdirSync(dir, { recursive: true });
    writeVaultPointer(dir, a.vault);
    dirs.set(p.key, dir);
    // Two sessions (two agents) of five related records each project.
    const one = serverIn(a, dir);
    const two = serverIn(a, dir);
    for (const i of [0, 1, 2, 3, 4]) {
      const [server, agent] = i < 3 ? [one, "agent-one"] : [two, "agent-two"];
      writes.push(callTool(server, "brain_note", { text: `${p.subject} ${i}`, agent }));
    }
  }
  await Promise.all(writes);

  // Stamped: the scoped-rules key of the directory's name.
  const stamped = stampedProjects(a);
  for (const p of PROJECTS) {
    const mine = stamped.filter((r) => r.text.startsWith(p.subject));
    expect(mine).toHaveLength(5);
    expect(new Set(mine.map((r) => r.project))).toEqual(new Set([p.key]));
  }

  // Read back by the planner unchanged: café and cafe stay two projects.
  const candidates = topicCandidates(a.records(), new Set());
  for (const p of PROJECTS) {
    const mine = candidates.filter((c) => c.text.startsWith(p.subject));
    expect(new Set(mine.map((c) => c.project))).toEqual(new Set([p.key]));
  }

  // Planned: one topic per project, scoped by the stamped key.
  const report = dreamAnswered(a.vault, a.store()).topics?.report;
  expect(report?.status).toBe("planned");
  const fold = readTopics().fold;
  const scopes = [...fold.topics.values()].map((t) => t.scope).toSorted();
  expect(scopes).toEqual(PROJECTS.map((p) => `project:${p.key}`).toSorted());

  // The digest of a session in each directory shows that project's topic only.
  const limits = resolveInjectionLimits(a.vault);
  const digests = await Promise.all(
    PROJECTS.map((p) =>
      buildAgentContextBlocks({
        vault: a.vault,
        workspaceDir: dirs.get(p.key)!,
        limits,
        meter: createInjectionMeter(limits.injectBudgetChars),
        remainingMs: 1000,
      }),
    ),
  );
  PROJECTS.forEach((p, i) => {
    const heads = digests[i]!.headsBlock.split("\n").filter((l) => /^- .+ \[active\]/.test(l));
    expect(heads, p.dir).toHaveLength(1);
  });

  // `o2b topic list --scope` and `brain_topic list` find it as the person spells the name.
  for (const p of PROJECTS) {
    const listed = runTopicAction({ action: "list", listScope: `project:${p.dir}` });
    expect((listed["topics"] as unknown[]).length, p.dir).toBe(1);
  }
});

test("a topic made by hand for a project spelled as its directory is that project's topic", () => {
  const made = switchedMachine();
  fleet = made.fleet;
  runTopicAction({ action: "create", title: "Launch plan", scope: "project:Проект-X" }, {});
  const fold = readTopics().fold;
  expect([...fold.topics.values()].map((t) => t.scope)).toEqual(["project:проект-x"]);
});

test("a caller below local reach gets no project stamped, a local one does", async () => {
  const made = switchedMachine();
  fleet = made.fleet;
  const a = made.machine;
  const dir = join(fleet.parent, "work", "release-tool");
  mkdirSync(dir, { recursive: true });
  writeVaultPointer(dir, a.vault);
  await callTool(serverIn(a, dir, TRANSPORT_REACH.remote), "brain_note", {
    text: "Remote caller note",
    agent: "agent-far",
  });
  await callTool(serverIn(a, dir, TRANSPORT_REACH.remote), "brain_feedback", {
    topic: "remote-pref",
    signal: "positive",
    principle: "Remote caller signal",
    agent: "agent-far",
  });
  await callTool(serverIn(a, dir), "brain_note", {
    text: "Local caller note",
    agent: "agent-near",
  });
  const stamped = stampedProjects(a);
  expect(stamped.find((r) => r.text === "Remote caller note")?.project).toBeUndefined();
  expect(stamped.find((r) => r.text === "Remote caller signal")?.project).toBeUndefined();
  expect(stamped.find((r) => r.text === "Local caller note")?.project).toBe("release-tool");
});

test("below local reach the topic counts of status leave the private records out", async () => {
  const made = switchedMachine();
  fleet = made.fleet;
  const a = made.machine;
  const elsewhere = join(fleet.parent, "work", "scratch");
  mkdirSync(elsewhere, { recursive: true });
  const s = serverIn(a, elsewhere);
  await Promise.all(
    [0, 1, 2].map((i) =>
      callTool(s, "brain_note", {
        text: `Private planning words ${i} <private>kept here</private>`,
        agent: "agent-one",
      }),
    ),
  );
  await callTool(s, "brain_note", { text: "Shared planning words", agent: "agent-one" });
  dreamAnswered(a.vault, a.store());

  type Topics = { created: number; unassigned: number; without_project: number };
  const local = (buildStoreStatusBlock({ vault: a.vault, configPath: null }) as { topics: Topics })
    .topics;
  const remote = withPrivateWithheld(
    true,
    () => buildStoreStatusBlock({ vault: a.vault, configPath: null }) as { topics: Topics },
  ).topics;
  expect(local.unassigned - remote.unassigned).toBe(3);
  expect(local.without_project - remote.without_project).toBe(3);
});

test("a shared record a private topic record assigns is unheld in the shared counts, held in the local ones", async () => {
  const made = switchedMachine();
  fleet = made.fleet;
  const a = made.machine;
  const elsewhere = join(fleet.parent, "work", "scratch");
  mkdirSync(elsewhere, { recursive: true });
  await callTool(serverIn(a, elsewhere), "brain_note", {
    text: "Shared note filed privately",
    agent: "agent-one",
  });
  const note = a
    .records()
    .find(
      (r) =>
        r.kind === "log-event" &&
        (r.body["body"] as Record<string, unknown>)["text"] === "Shared note filed privately",
    )!;
  // A personal topic is private, so its assign record lands in `private`.
  runTopicAction({ action: "create", title: "My own matters" });
  const topic = [...readTopics().fold.topics.values()][0]!;
  expect(topic.private).toBe(true);
  runTopicAction({ action: "assign", topic: topic.id, record: note.id });
  dreamAnswered(a.vault, a.store());

  const outcome = readTopicPlanOutcome();
  expect(outcome).not.toBeNull();
  expect(outcome!.shared!.unassigned - outcome!.unassigned).toBe(1);
  expect(outcome!.shared!.withoutProject - outcome!.withoutProject).toBe(1);
});
