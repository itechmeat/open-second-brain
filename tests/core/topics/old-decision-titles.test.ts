/**
 * Decisions a release recorded before decision events carried a title
 * (field check, fourth rerun item 16): every surface that names a decision
 * from its log event (the view's decisions and history pages, a topic's
 * decision items and held listing, the planning text) takes the title from
 * the decision's own page when the event carries none, on a machine that
 * switched to the store (the pages imported by the migration) and on one
 * that has not (the pages its dual write kept in the store).
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { runMigration } from "../../../src/core/store-migration/migrate.ts";
import type { StoreRecord } from "../../../src/core/store/envelope.ts";
import { appendRecord } from "../../../src/core/store/appender.ts";
import { logEventRecord } from "../../../src/core/store/dual-write-records.ts";
import { laneEntryRecord } from "../../../src/core/store/lane-records.ts";
import { withPrivateWithheld } from "../../../src/core/store/caller-reach.ts";
import { runTopicAction } from "../../../src/core/topics/actions.ts";
import { isTopicPlanningInput, topicCandidates } from "../../../src/core/topics/candidates.ts";
import { decisionTitlesOfCatchUp } from "../../../src/core/topics/decision-titles.ts";
import {
  catchUpSettings,
  catchUpWhere,
  partitionRecords,
} from "../../../src/core/view/catch-up.ts";
import { runViewPass } from "../../../src/core/view/render.ts";
import { claimSettled, claimViewWriter } from "../../../src/core/view/writer.ts";
import { foldViewWriter } from "../../../src/core/view/writer-fold.ts";
import { CLI_SPAWN_BUDGET_MS } from "../../helpers/cli-timeout.ts";
import { makeFleet, type Fleet, type Machine } from "../store-migration/fixtures/fleet.ts";
import {
  appendOldDualWrites,
  OLD_DECISION_LINES,
  OLD_PROJECT,
  oldLegacyFiles,
} from "./fixtures/old-decisions.ts";

setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

let fleet: Fleet | null = null;
afterEach(() => {
  fleet?.cleanup();
  fleet = null;
});

type Layout = "switched" | "unswitched";

/** A machine holding the view writer role whose vault has the two old decisions. */
function machineWithOldDecisions(layout: Layout): Machine {
  fleet = makeFleet(["dev-a"]);
  const a = fleet.machine("dev-a");
  a.use();
  for (const [rel, text] of Object.entries(oldLegacyFiles())) a.write(rel, text);
  if (layout === "switched") expect(runMigration(a.vault, { settleMs: 0 }).ok).toBe(true);
  else appendOldDualWrites(a.store());
  const store = a.store();
  claimViewWriter(store, { agent: "t" });
  claimSettled(store, foldViewWriter(catchUpSettings(store)!));
  return a;
}

/** One render pass of the view writer. */
function render(a: Machine): void {
  const report = runViewPass(a.store(), {
    target: join(fleet!.parent, "view"),
    vault: a.vault,
    agent: "t",
  });
  expect(report.status).toBe("rendered");
}

function viewPage(rel: string): string {
  return readFileSync(join(fleet!.parent, "view", ...rel.split("/")), "utf8");
}

function decisionEvents(a: Machine): StoreRecord[] {
  return a
    .records()
    .filter((r) => r.kind === "log-event" && r.body["event_type"] === "decision-record");
}

/** The candidates as topic planning reads them: its read, with that read's page titles. */
function plannerCandidates(a: Machine): ReturnType<typeof topicCandidates> {
  const read = catchUpWhere(a.store(), isTopicPlanningInput);
  const privateIds = new Set(partitionRecords(read, "private").map((r) => r.id));
  return topicCandidates(
    [...read.records.values()].flat(),
    privateIds,
    decisionTitlesOfCatchUp(read),
  );
}

function decisionLines(page: string): string[] {
  const at = page.indexOf("## Decisions");
  if (at < 0) return [];
  const rest = page.slice(at).split("\n").slice(2);
  const end = rest.findIndex((l) => l.startsWith("## "));
  return (end < 0 ? rest : rest.slice(0, end)).filter((l) => l.startsWith("- "));
}

describe.each(["switched", "unswitched"] as const)("old decisions, %s machine", (layout) => {
  test("the view's decisions and history pages name each decision by its page's title", () => {
    const a = machineWithOldDecisions(layout);
    // The events carry no title: only the page they link has it.
    const events = decisionEvents(a);
    expect(events).toHaveLength(2);
    for (const e of events)
      expect((e.body["body"] as Record<string, unknown>)["title"]).toBeUndefined();
    render(a);
    const decisions = viewPage("decisions.md");
    const week = viewPage("history/2026-W47.md");
    for (const line of OLD_DECISION_LINES) {
      expect(decisions).toContain(`- 2026-11-21: ${line} (review on 2027-01-01)\n`);
      expect(week).toContain(`- Decision: ${line}\n`);
    }
  });

  test("a topic that holds them names each decision, on its page and in its held listing", () => {
    const a = machineWithOldDecisions(layout);
    const topic = String(
      runTopicAction({
        action: "create",
        title: "Журнал релизов",
        scope: `project:${OLD_PROJECT}`,
      })["topic"],
    );
    for (const e of decisionEvents(a)) runTopicAction({ action: "assign", topic, record: e.id });
    const page = String(runTopicAction({ action: "show", topic })["page"]);
    expect(decisionLines(page).toSorted()).toEqual(
      OLD_DECISION_LINES.map((l) => `- ${l}`).toSorted(),
    );
    const held = runTopicAction({ action: "show", topic, held: true })["records"] as Array<
      Record<string, unknown>
    >;
    expect(held.map((h) => h["text"]).toSorted()).toEqual([...OLD_DECISION_LINES].toSorted());
    render(a);
    const topicsDir = join(fleet!.parent, "view", "topics");
    // The folder is the topic's creation day and its title.
    const folder = readdirSync(topicsDir).find((n) => n.endsWith("-журнал-релизов"));
    const rendered = readFileSync(join(topicsDir, folder!, "topic.md"), "utf8");
    expect(decisionLines(rendered).toSorted()).toEqual(
      OLD_DECISION_LINES.map((l) => `- ${l}`).toSorted(),
    );
  });

  test("planning reads each decision as its title with the option chosen", () => {
    const a = machineWithOldDecisions(layout);
    const texts = plannerCandidates(a)
      .filter((c) => decisionEvents(a).some((e) => e.id === c.id))
      .map((c) => c.text);
    expect(texts.toSorted()).toEqual([...OLD_DECISION_LINES].toSorted());
  });
});

test("a private decision page's title never names a shared event", () => {
  fleet = makeFleet(["dev-a"]);
  const a = fleet.machine("dev-a");
  a.use();
  const store = a.store();
  const page = laneEntryRecord({
    lane: "decisions",
    entry: "decision-secret-plan",
    fields: { type: "decision", id: "decision-secret-plan", title: "Секретный план запуска" },
    text: "",
    authority: "agent",
    private: true,
  });
  const event = logEventRecord({
    timestamp: "2026-11-21T09:00:00Z",
    eventType: "decision-record",
    body: { decision: "[[decision-secret-plan]]", chosen: "одна страница", agent: "t4" },
  });
  appendRecord(store, { ...page, partition: "private", agent: "t4", scope: null });
  appendRecord(store, { ...event, partition: "shared", agent: "t4", scope: null });
  claimViewWriter(store, { agent: "t" });
  claimSettled(store, foldViewWriter(catchUpSettings(store)!));
  render(a);
  const decisions = viewPage("decisions.md");
  expect(decisions).toContain("- 2026-11-21: одна страница\n");
  expect(decisions).not.toContain("Секретный");
  const records = a.records();
  const privateIds = new Set(records.filter((r) => r.kind === "lane-entry").map((r) => r.id));
  const [shared] = topicCandidates(records, privateIds);
  // The slug's words, as for an event whose page this reader does not hold.
  expect(shared?.text).toBe("secret plan: одна страница");
});

/**
 * Two shared versions of one decision page, one public and one with a
 * `<private>` region in its title. Privacy is judged on the version the
 * fold lets win, never by dropping a version before the fold: a private
 * winner leaves every shared surface with what the event says, and a
 * public winner names the event with its title, whichever order they
 * were written in.
 */
describe.each([
  { order: "public, then private", winner: "private" },
  { order: "private, then public", winner: "public" },
] as const)("a decision page written $order", ({ winner }) => {
  const PUBLIC = "Публичный план релиза";
  const PRIVATE = "План <private>тайный</private> релиза";

  function machine(): { a: Machine; topic: string } {
    fleet = makeFleet(["dev-a"]);
    const a = fleet.machine("dev-a");
    a.use();
    const store = a.store();
    const titles = winner === "private" ? [PUBLIC, PRIVATE] : [PRIVATE, PUBLIC];
    for (const title of titles) {
      const page = laneEntryRecord({
        lane: "decisions",
        entry: "decision-plan-x",
        fields: { type: "decision", id: "decision-plan-x", title },
        text: "",
        authority: "agent",
        private: false,
      });
      appendRecord(store, { ...page, partition: "shared", agent: "t4", scope: null });
    }
    const event = logEventRecord({
      timestamp: "2026-11-21T09:00:00Z",
      eventType: "decision-record",
      body: {
        decision: "[[decision-plan-x]]",
        chosen: "одна страница",
        agent: "t4",
        project: OLD_PROJECT,
      },
    });
    appendRecord(store, { ...event, partition: "shared", agent: "t4", scope: null });
    claimViewWriter(store, { agent: "t" });
    claimSettled(store, foldViewWriter(catchUpSettings(store)!));
    const topic = String(
      runTopicAction({ action: "create", title: "План", scope: `project:${OLD_PROJECT}` })["topic"],
    );
    const id = decisionEvents(a)[0]!.id;
    runTopicAction({ action: "assign", topic, record: id });
    return { a, topic };
  }

  /** What a shared surface must say: the public title, or the event alone. */
  const named = winner === "public" ? `${PUBLIC}: одна страница` : null;

  test("the view's decisions, history and topic pages", () => {
    const { a } = machine();
    render(a);
    const decisions = viewPage("decisions.md");
    const week = viewPage("history/2026-W47.md");
    const topicsDir = join(fleet!.parent, "view", "topics");
    const folder = readdirSync(topicsDir).find((n) => n.endsWith("-план"));
    const topicPage = readFileSync(join(topicsDir, folder!, "topic.md"), "utf8");
    for (const page of [decisions, week, topicPage]) {
      expect(page).not.toContain("тайный");
      if (named === null) expect(page).not.toContain(PUBLIC);
    }
    expect(decisions).toContain(`- 2026-11-21: ${named ?? "одна страница"}\n`);
    expect(week).toContain(`- Decision: ${named ?? "одна страница"}\n`);
    expect(decisionLines(topicPage)).toEqual([`- ${named ?? "plan x: одна страница"}`]);
  });

  test("topic show and its held listing, at local reach and below it", () => {
    const { a, topic } = machine();
    for (const withhold of [false, true]) {
      withPrivateWithheld(withhold, () => {
        const page = String(runTopicAction({ action: "show", topic })["page"]);
        const held = runTopicAction({ action: "show", topic, held: true })["records"] as Array<
          Record<string, unknown>
        >;
        const expected = named ?? "plan x: одна страница";
        expect(decisionLines(page)).toEqual([`- ${expected}`]);
        // Below local reach a text arrives framed as stored, untrusted text.
        expect(held).toHaveLength(1);
        expect(String(held[0]!["text"])).toContain(expected);
        expect(String(held[0]!["text"])).not.toContain("тайный");
      });
    }
    // The planner reads the same.
    const [candidate] = plannerCandidates(a);
    expect(candidate?.text).toBe(named ?? "plan x: одна страница");
  });
});
