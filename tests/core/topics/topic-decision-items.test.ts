/**
 * A decision the agent recorded with an explicit kind (`brain_decision`
 * record, or resolve of an open decision) shows as a decision item of the
 * topic that holds it, with no decision model (design D10 `event_kind`:
 * the kind the agent passed decides). The item is derived when the page
 * or `show` is read, from the held `decision-record` and
 * `decision-resolved` events and any later `decision-outcome`: nothing is
 * written for it, so a second pass writes nothing, an undo of the
 * assignment or the topic takes it away, and it follows its record's
 * partition. A topic item for the same decision (a decision model's, the
 * user's edit of the line) replaces it.
 */
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { dream } from "../../../src/core/brain/dream.ts";
import { writeVaultPointer } from "../../../src/core/brain/portability/pointer.ts";
import { TRANSPORT_REACH } from "../../../src/core/graph/transport-reach.ts";
import type { MCPServer } from "../../../src/mcp/server.ts";
import { runMigration } from "../../../src/core/store-migration/migrate.ts";
import type { StoreRecord } from "../../../src/core/store/envelope.ts";
import { runTopicAction } from "../../../src/core/topics/actions.ts";
import { runTopicPlanning } from "../../../src/core/topics/planning.ts";
import { isTopicRecordKind } from "../../../src/core/topics/records.ts";
import { VIEW_TARGET_ENV } from "../../../src/core/view/constants.ts";
import { catchUpSettings } from "../../../src/core/view/catch-up.ts";
import { runViewPass } from "../../../src/core/view/render.ts";
import { claimSettled, claimViewWriter, requestViewWriter } from "../../../src/core/view/writer.ts";
import { foldViewWriter } from "../../../src/core/view/writer-fold.ts";
import { CLI_SPAWN_BUDGET_MS } from "../../helpers/cli-timeout.ts";
import { makeFleet, type Fleet, type Machine } from "../store-migration/fixtures/fleet.ts";
import { callTool, serverIn } from "./fixtures/record-project.ts";

setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

const SUBJECT = "Release notes list every migration step";
const CHOSEN = "Release notes list every migration step in commit order";
const CHOICE = "Release notes list every migration step grouped by module";
/** A decision item names the decision's title with the option chosen. */
const CHOSEN_ITEM = `Release notes order: ${CHOSEN}`;
const CHOICE_ITEM = `Release notes grouping: ${CHOICE}`;
const OUTCOME = "Readers found the grouped steps easier";

let fleet: Fleet | null = null;
let savedView: string | undefined;
afterEach(() => {
  fleet?.cleanup();
  fleet = null;
  if (savedView === undefined) delete process.env[VIEW_TARGET_ENV];
  else process.env[VIEW_TARGET_ENV] = savedView;
});

function out(result: unknown): Record<string, unknown> {
  const r = result as {
    structuredContent?: Record<string, unknown>;
    content?: Array<{ text?: string }>;
  };
  return (
    r.structuredContent ?? (JSON.parse(r.content?.[0]?.text ?? "{}") as Record<string, unknown>)
  );
}

interface Setup {
  readonly a: Machine;
  readonly dir: string;
  readonly one: MCPServer;
  readonly two: MCPServer;
  /** The slug of the decision recorded directly. */
  readonly slug: string;
}

/** A switched fleet whose first machine holds the view writer role and a view folder. */
function switchedFleet(names: ReadonlyArray<string>): Machine {
  savedView = process.env[VIEW_TARGET_ENV];
  fleet = makeFleet(names);
  const a = fleet.machine(names[0]!);
  a.use();
  process.env[VIEW_TARGET_ENV] = join(fleet.parent, `view-${a.name}`);
  expect(runMigration(a.vault, { settleMs: 0 }).ok).toBe(true);
  const store = a.store();
  claimViewWriter(store, { agent: "t" });
  claimSettled(store, foldViewWriter(catchUpSettings(store)!));
  return a;
}

/**
 * Notes of two sessions in a linked project, a decision recorded in the
 * first session and an open decision resolved in the second, all through
 * the real MCP handlers.
 */
async function decisionsInProject(names: ReadonlyArray<string> = ["dev-a"]): Promise<Setup> {
  const a = switchedFleet(names);
  const dir = join(fleet!.parent, "work", "release-tool");
  mkdirSync(dir, { recursive: true });
  writeVaultPointer(dir, a.vault);
  const one = serverIn(a, dir);
  const two = serverIn(a, dir);
  // One after the other: records of one session keep their order.
  await callTool(one, "brain_note", { text: `${SUBJECT} 0`, agent: "agent-one" });
  await callTool(one, "brain_note", { text: `${SUBJECT} 1`, agent: "agent-one" });
  const recorded = out(
    await callTool(one, "brain_decision", {
      action: "record",
      title: "Release notes order",
      chosen: CHOSEN,
      assumption: "Readers follow the steps top to bottom",
      review_date: "2027-01-01",
      agent: "agent-one",
    }),
  );
  // One after the other: records of one session keep their order.
  await callTool(two, "brain_note", { text: `${SUBJECT} 2`, agent: "agent-two" });
  await callTool(two, "brain_note", { text: `${SUBJECT} 3`, agent: "agent-two" });
  const opened = out(
    await callTool(two, "brain_decision", {
      action: "open",
      title: "Release notes grouping",
      question: "How do the release notes group the migration steps?",
      options: [CHOICE, "One flat list"],
      agent: "agent-two",
    }),
  );
  await callTool(two, "brain_decision", {
    action: "resolve",
    id: String(opened["id"]),
    choice: CHOICE,
    agent: "agent-two",
  });
  return { a, dir, one, two, slug: String(recorded["slug"]) };
}

function createdTopic(vault: string): string {
  const report = dream(vault).topics?.report;
  expect(report?.status).toBe("planned");
  if (report?.status !== "planned") throw new Error("not planned");
  expect(report.created).toHaveLength(1);
  return report.created[0]!.topic;
}

function decisionItems(shown: Record<string, unknown>): Array<Record<string, unknown>> {
  const items = (shown["topic"] as Record<string, unknown>)["items"] as Array<
    Record<string, unknown>
  >;
  return items.filter((i) => i["kind"] === "decision");
}

/** The topic page the view writer wrote to disk for `topic`. */
function diskPage(topic: string): string {
  const root = join(process.env[VIEW_TARGET_ENV]!, "topics");
  for (const folder of existsSync(root) ? readdirSync(root) : []) {
    const path = join(root, folder, "topic.md");
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf8");
    if (text.includes(`topic=${topic}`)) return text;
  }
  throw new Error(`no page for ${topic}`);
}

function topicRecords(machine: Machine): StoreRecord[] {
  return machine.records().filter((r) => isTopicRecordKind(r.kind));
}

function decisionLines(page: string): string[] {
  const at = page.indexOf("## Decisions");
  if (at < 0) return [];
  const rest = page.slice(at).split("\n").slice(2);
  const end = rest.findIndex((l) => l.startsWith("## "));
  return (end < 0 ? rest : rest.slice(0, end)).filter((l) => l.startsWith("- "));
}

test("a dream pass puts held decisions on the page and in show, a resolved one as resolved", async () => {
  const { a, slug, one } = await decisionsInProject();
  const topic = createdTopic(a.vault);

  const shown = runTopicAction({ action: "show", topic });
  const page = String(shown["page"]);
  // The decision recorded, and the open decision resolved (its minted
  // decision and the resolution are one item).
  expect(decisionLines(page)).toEqual([
    `- ${CHOICE_ITEM} (resolved open decision)`,
    `- ${CHOSEN_ITEM}`,
  ]);
  expect(decisionLines(diskPage(topic))).toEqual(decisionLines(page));
  const items = decisionItems(shown);
  expect(items.map((i) => i["text"]).toSorted()).toEqual([CHOICE_ITEM, CHOSEN_ITEM].toSorted());
  expect(items.every((i) => i["authority"] === "agent")).toBe(true);

  // brain_topic show through the MCP handler carries the same items.
  const viaTool = out(await callTool(one, "brain_topic", { action: "show", topic }));
  expect(decisionLines(String(viaTool["page"]))).toEqual(decisionLines(page));
  expect(decisionItems(viaTool)).toHaveLength(2);

  // The second pass writes no topic record and leaves the page as it was.
  const before = topicRecords(a).length;
  const pageBefore = diskPage(topic);
  dream(a.vault);
  expect(topicRecords(a).length).toBe(before);
  expect(diskPage(topic)).toBe(pageBefore);

  // An outcome backfilled later updates the item.
  await callTool(one, "brain_decision", { action: "outcome", slug, outcome: OUTCOME });
  dream(a.vault);
  expect(decisionLines(diskPage(topic))).toEqual([
    `- ${CHOICE_ITEM} (resolved open decision)`,
    `- ${CHOSEN_ITEM} (outcome: ${OUTCOME})`,
  ]);
  expect(topicRecords(a).length).toBe(before);
});

test("undo of the assignment takes the item away, undo of the topic the whole page", async () => {
  const { a } = await decisionsInProject();
  const topic = createdTopic(a.vault);
  const chosenEvent = a
    .records()
    .find(
      (r) =>
        r.kind === "log-event" &&
        r.body["event_type"] === "decision-record" &&
        (r.body["body"] as Record<string, unknown>)["chosen"] === CHOSEN,
    )!;
  const assign = topicRecords(a).find(
    (r) => r.kind === "assign" && r.body["record"] === chosenEvent.id,
  )!;
  runTopicAction({ action: "undo", record: assign.id });
  dream(a.vault);
  expect(decisionLines(diskPage(topic))).toEqual([`- ${CHOICE_ITEM} (resolved open decision)`]);
  expect(decisionItems(runTopicAction({ action: "show", topic }))).toHaveLength(1);

  const create = topicRecords(a).find((r) => r.kind === "topic-create" && r.topic === topic)!;
  runTopicAction({ action: "undo", record: create.id });
  expect(() => runTopicAction({ action: "show", topic })).toThrow(/no topic with id/);
});

test("a topic item for the same decision replaces the derived one, and a human item is never displaced", async () => {
  const { a } = await decisionsInProject();
  const topic = createdTopic(a.vault);
  const chosenEvent = a
    .records()
    .find(
      (r) =>
        r.kind === "log-event" &&
        r.body["event_type"] === "decision-record" &&
        (r.body["body"] as Record<string, unknown>)["chosen"] === CHOSEN,
    )!;
  // The item a decision model's `event_kind` writes: item id = record id.
  runTopicAction({
    action: "record",
    topic,
    kind: "decision",
    fields: { item: chosenEvent.id, text: "Steps in commit order" },
  });
  const shown = runTopicAction({ action: "show", topic });
  expect(
    decisionItems(shown)
      .map((i) => i["text"])
      .toSorted(),
  ).toEqual([CHOICE_ITEM, "Steps in commit order"].toSorted());

  // Twenty-five decisions of the user fill the page budget: the derived
  // item moves to the archive, none of the user's leaves the page.
  for (let i = 0; i < 25; i++) {
    runTopicAction(
      { action: "record", topic, kind: "decision", fields: { text: `User decision ${i}` } },
      { humanRequest: true },
    );
  }
  const page = String(runTopicAction({ action: "show", topic })["page"]);
  const lines = decisionLines(page);
  expect(lines).toHaveLength(25);
  expect(lines.every((l) => l.startsWith("- User decision"))).toBe(true);
  dream(a.vault);
  const archive = readFileSync(archiveOf(topic), "utf8");
  expect(archive).toContain(`- ${CHOICE_ITEM} (resolved open decision)`);
  expect(archive).toContain("- Steps in commit order");
});

function archiveOf(topic: string): string {
  const root = join(process.env[VIEW_TARGET_ENV]!, "topics");
  for (const folder of readdirSync(root)) {
    const path = join(root, folder, "topic.md");
    if (existsSync(path) && readFileSync(path, "utf8").includes(`topic=${topic}`)) {
      return join(root, folder, "archive.md");
    }
  }
  throw new Error(`no folder for ${topic}`);
}

test("a private decision is shown to a local caller only, never on the view or below local reach", async () => {
  const { a, one, dir } = await decisionsInProject();
  const topic = createdTopic(a.vault);
  const secretChosen = `${SUBJECT} <private>codename aurora</private> behind a flag`;
  await callTool(one, "brain_decision", {
    action: "record",
    title: "Release notes flag",
    chosen: secretChosen,
    assumption: "The flag stays internal",
    review_date: "2027-01-01",
    agent: "agent-one",
  });
  const event = a
    .records()
    .find(
      (r) =>
        r.kind === "log-event" &&
        r.body["event_type"] === "decision-record" &&
        String((r.body["body"] as Record<string, unknown>)["chosen"]).includes("behind a flag"),
    )!;
  const report = dream(a.vault).topics?.report;
  if (report?.status !== "planned") throw new Error("not planned");
  expect(report.routed.map((r) => r.record)).toContain(event.id);

  const local = runTopicAction({ action: "show", topic });
  const localTexts = decisionItems(local).map((i) => String(i["text"]));
  expect(localTexts.some((t) => t.includes("behind a flag"))).toBe(true);
  expect(localTexts.some((t) => t.includes("aurora"))).toBe(false);

  const remote = out(
    await callTool(serverIn(a, dir, TRANSPORT_REACH.remote), "brain_topic", {
      action: "show",
      topic,
    }),
  );
  expect(JSON.stringify(remote)).not.toContain("behind a flag");
  expect(decisionItems(remote)).toHaveLength(2);
  expect(diskPage(topic)).not.toContain("behind a flag");
});

test("two devices: the other device's show carries the items, and neither writes anything for them", async () => {
  const { a } = await decisionsInProject(["dev-a", "dev-b"]);
  const topic = createdTopic(a.vault);
  const written = topicRecords(a).length;

  fleet!.syncStore("dev-a", "dev-b");
  const b = fleet!.machine("dev-b");
  b.use();
  process.env[VIEW_TARGET_ENV] = join(fleet!.parent, "view-dev-b");
  const onB = runTopicAction({ action: "show", topic });
  expect(decisionLines(String(onB["page"]))).toEqual([
    `- ${CHOICE_ITEM} (resolved open decision)`,
    `- ${CHOSEN_ITEM}`,
  ]);
  // Not the writer: planning and the render write nothing.
  const viewB = process.env[VIEW_TARGET_ENV]!;
  const pass = () => runViewPass(b.store(), { agent: "t", target: viewB, vault: b.vault });
  expect(runTopicPlanning(b.store(), { agent: "t" }).status).toBe("not-writer");
  expect(pass().status).toBe("not-writer");

  // The role moves to dev-b; its passes derive the same items and write no topic record.
  requestViewWriter(b.store(), { agent: "t", force: true });
  for (let i = 0; i < 3; i++) {
    runTopicPlanning(b.store(), { agent: "t" });
    pass();
  }
  expect(pass().status).toBe("rendered");
  expect(topicRecords(b).length).toBe(written);
  expect(decisionLines(diskPage(topic))).toEqual([
    `- ${CHOICE_ITEM} (resolved open decision)`,
    `- ${CHOSEN_ITEM}`,
  ]);
});

test("the user's edit of a derived line on the page becomes the item, with no second one", async () => {
  const { a } = await decisionsInProject();
  const topic = createdTopic(a.vault);
  const path = pagePathOf(topic);
  const edited = "Release notes list the steps in commit order, newest last";
  writeFileSync(path, readFileSync(path, "utf8").replace(`- ${CHOSEN_ITEM}\n`, `- ${edited}\n`));
  dream(a.vault);
  expect(decisionLines(diskPage(topic))).toEqual([
    `- ${CHOICE_ITEM} (resolved open decision)`,
    `- ${edited}`,
  ]);
  const items = decisionItems(runTopicAction({ action: "show", topic }));
  expect(items.find((i) => i["text"] === edited)?.["authority"]).toBe("human");
  expect(items).toHaveLength(2);
});

function pagePathOf(topic: string): string {
  return join(archiveOf(topic), "..", "topic.md");
}
