/**
 * A decision page's title is used only when the read of that page's
 * versions is known complete (review of pull request 340): when a newer
 * version of the page could not be read (a shard read only in part) or its
 * body has not arrived (a quarantined pending blob), an older public
 * version must not name a shared event, on any surface: the view's
 * decisions, history and topic pages, `topic show` (which then says its
 * decisions are incomplete), the held listing (which names the shard), and
 * the planner's text. The surface falls back to what the event says.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import { appendRecord } from "../../../src/core/store/appender.ts";
import { logEventRecord } from "../../../src/core/store/dual-write-records.ts";
import { laneEntryRecord } from "../../../src/core/store/lane-records.ts";
import { addQuarantine } from "../../../src/core/store/shard-quarantine-write.ts";
import { lineSha256At } from "../../../src/core/store/shard-quarantine.ts";
import { partitionDir } from "../../../src/core/store/store-paths.ts";
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

setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

const PROJECT = "тема-четыре";
const PUBLIC = "Публичный план релиза";
const FALLBACK = "plan x: одна страница";

let fleet: Fleet | null = null;
afterEach(() => {
  fleet?.cleanup();
  fleet = null;
});

type Loss = "unreadable" | "pending";

function decisionLines(page: string): string[] {
  const at = page.indexOf("## Decisions");
  if (at < 0) return [];
  const rest = page.slice(at).split("\n").slice(2);
  const end = rest.findIndex((l) => l.startsWith("## "));
  return (end < 0 ? rest : rest.slice(0, end)).filter((l) => l.startsWith("- "));
}

/** One version of a decision page. */
const pageVersion = (entry: string, title: string, text: string) =>
  laneEntryRecord({
    lane: "decisions",
    entry,
    fields: { type: "decision", id: entry, title },
    text,
    authority: "agent",
    private: false,
  });

/**
 * A public page version, a newer one with a `<private>` region in its
 * title (its text large enough to live in a blob), another page after
 * it, an old decision event without a title, and a topic holding it;
 * then the newer version is lost as `loss` says.
 */
function machine(loss: Loss): { a: Machine; topic: string } {
  fleet = makeFleet(["dev-a"]);
  const a = fleet.machine("dev-a");
  a.use();
  const store = a.store();
  appendRecord(store, {
    ...pageVersion("decision-plan-x", PUBLIC, ""),
    partition: "shared",
    agent: "t4",
    scope: null,
  });
  const newer = appendRecord(store, {
    ...pageVersion("decision-plan-x", "План <private>тайный</private> релиза", "x".repeat(300_000)),
    partition: "shared",
    agent: "t4",
    scope: null,
  });
  appendRecord(store, {
    ...pageVersion("decision-other", "Другое", ""),
    partition: "shared",
    agent: "t4",
    scope: null,
  });
  const event = logEventRecord({
    timestamp: "2026-11-21T09:00:00Z",
    eventType: "decision-record",
    body: {
      decision: "[[decision-plan-x]]",
      chosen: "одна страница",
      agent: "t4",
      project: PROJECT,
    },
  });
  appendRecord(store, { ...event, partition: "shared", agent: "t4", scope: null });
  claimViewWriter(store, { agent: "t" });
  claimSettled(store, foldViewWriter(catchUpSettings(store)!));
  const topic = String(
    runTopicAction({ action: "create", title: "План", scope: `project:${PROJECT}` })["topic"],
  );
  const id = a
    .records()
    .find((r) => r.kind === "log-event" && r.body["event_type"] === "decision-record")!.id;
  runTopicAction({ action: "assign", topic, record: id });

  const shared = partitionDir(a.storeRoot, "shared");
  const bytes = readFileSync(newer.path);
  const lines = bytes.toString("utf8").split("\n").filter(Boolean);
  // The newer version is the second line of its shard.
  const offset = Buffer.byteLength(`${lines[0]}\n`, "utf8");
  if (loss === "unreadable") {
    // A line in the middle of the shard that no longer parses: the shard reads only in part.
    lines[1] = "{not a record";
    writeFileSync(newer.path, `${lines.join("\n")}\n`);
  } else {
    // Its blob has not arrived, and its line is quarantined as pending (no gap).
    rmSync(join(shared, "blobs"), { recursive: true, force: true });
    addQuarantine(a.storeRoot, {
      partition: "shared",
      shard: relative(shared, newer.path).split("\\").join("/"),
      offset,
      sha256: lineSha256At(newer.path, offset, shared)!,
      kind: "blob-pending",
      reason: "test",
    });
  }
  return { a, topic };
}

describe.each(["unreadable", "pending"] as const)("the newer page version is %s", (loss) => {
  test("topic show names no title and says its decisions are incomplete", () => {
    const { topic } = machine(loss);
    const shown = runTopicAction({ action: "show", topic });
    const page = String(shown["page"]);
    expect(page).not.toContain(PUBLIC);
    expect(decisionLines(page)).toEqual([`- ${FALLBACK}`]);
    expect(shown["decisions_incomplete"]).toBe(true);
  });

  test("the held listing names no title and lists what it could not read", () => {
    const { topic } = machine(loss);
    const held = runTopicAction({ action: "show", topic, held: true });
    const records = held["records"] as Array<Record<string, unknown>>;
    expect(records.map((r) => r["text"])).toEqual([FALLBACK]);
    if (loss === "unreadable") expect(held["records_unreadable"]).toBeDefined();
  });

  test("the planner reads the event alone", () => {
    const { a } = machine(loss);
    const read = catchUpWhere(a.store(), isTopicPlanningInput);
    const records = [...read.records.values()].flat();
    const privateIds = new Set(partitionRecords(read, "private").map((r) => r.id));
    const titles = decisionTitlesOfCatchUp(read);
    expect(titles.complete).toBe(false);
    const [candidate] = topicCandidates(records, privateIds, titles);
    expect(candidate?.text).toBe(FALLBACK);
  });

  test("the view names no title on its decisions, history and topic pages", () => {
    const { a } = machine(loss);
    const view = join(fleet!.parent, "view");
    const report = runViewPass(a.store(), { target: view, vault: a.vault, agent: "t" });
    // A shard read only in part stops the render; a pending blob does not.
    if (loss === "unreadable") {
      expect(report.status).toBe("incomplete-read");
      return;
    }
    expect(report.status).toBe("rendered");
    const decisions = readFileSync(join(view, "decisions.md"), "utf8");
    const week = readFileSync(join(view, "history", "2026-W47.md"), "utf8");
    const folder = readdirSync(join(view, "topics")).find((n) => n.endsWith("-план"))!;
    const topicPage = readFileSync(join(view, "topics", folder, "topic.md"), "utf8");
    for (const text of [decisions, week, topicPage]) expect(text).not.toContain(PUBLIC);
    expect(decisions).toContain("- 2026-11-21: одна страница\n");
    expect(decisionLines(topicPage)).toEqual([`- ${FALLBACK}`]);
  });
});
