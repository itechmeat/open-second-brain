/**
 * Topic pages, reports and sources in the human view (task 3.2, spec
 * `topics`): `topics/<date>-<slug>/topic.md` rendered through the phase 2
 * render protocol in the fixed section order, the page budget with its
 * companion archive, a rename that moves the folder and keeps the id, the
 * user's edits landing as human topic records, and `reports/` and
 * `sources/` pages from their lane entries. Snapshots in English and
 * Russian.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { readPartition } from "../../../src/core/store/state-digest.ts";
import type { StoreHandle } from "../../../src/core/store/store-open.ts";
import { newUlid } from "../../../src/core/store/ulid.ts";
import { foldTopics } from "../../../src/core/topics/fold.ts";
import { runViewPass } from "../../../src/core/view/render.ts";
import { claimViewWriter } from "../../../src/core/view/writer.ts";
import { makeMachines, type Machines } from "./fixtures/machines.ts";
import { seedLaneEntry, seedLaneRemove, seedSetting, seedTopicRecord } from "./fixtures/seed.ts";

const T0 = Date.UTC(2026, 10, 2, 9, 0, 0);
let clock = T0;
const now = () => clock;

let m: Machines;
let a: StoreHandle;
let topic: string;
let other: string;

beforeEach(() => {
  clock = T0;
  m = makeMachines(["dev-a", "dev-b"]);
  a = m.open("dev-a");
  topic = newUlid(T0);
  other = newUlid(T0 + 1);
});
afterEach(() => m.cleanup());

type Opts = Parameters<typeof seedTopicRecord>[5] & { topic?: string; on?: StoreHandle };
function rec(kind: string, body: Record<string, unknown>, opts: Opts = {}): string {
  clock += 60_000;
  return seedTopicRecord(opts.on ?? a, clock, kind, opts.topic ?? topic, body, opts);
}

function createTopic(extra: Record<string, unknown> = {}, opts: Opts = {}): void {
  rec(
    "topic-create",
    {
      title: "Brain store",
      scope: "project:o2b",
      goal: "Move machine data out of the vault",
      ...extra,
    },
    { authority: "human", ...opts },
  );
}

function render(passes = 2): void {
  claimViewWriter(a, { agent: "t", now });
  for (let i = 0; i < passes; i++) {
    clock += 1000;
    runViewPass(a, { target: m.view("dev-a"), vault: null, agent: "t", now });
  }
}

const view = (rel = "") => join(m.view("dev-a"), ...rel.split("/").filter(Boolean));
function page(rel: string): string {
  return readFileSync(view(rel), "utf8").replaceAll(a.storeId, "<store>").replaceAll(topic, "<id>");
}
const topicDir = "topics/2026-11-02-brain-store";

function seedFull(): void {
  createTopic({ description: "Store outside the vault" });
  rec("topic-create", { title: "Docs", scope: "project:o2b" }, { topic: other });
  rec("milestone", { item: "m1", text: "Store core" });
  rec("milestone", { item: "m2", text: "Migration" });
  rec("milestone", { item: "m3", text: "Topics" });
  rec("milestone-done", { milestone: "m1", evidence: "PR 289 merged" });
  rec("milestone-done", { milestone: "m2" }, { authority: "model" });
  rec("decision", { text: "Monthly shards per device", serves: ["m1"] });
  rec("open-question", { text: "Where do phones get the view?" });
  rec("log-entry", { text: "Ran the tests and they passed", class: "routine" });
  rec("log-entry", { text: "Sync conflicts on pinned.md", class: "blocker" });
  rec("log-entry", { text: "One file per writer", class: "rejected", reason: "devices churn" });
  rec("topic-goal", { goal: "Ship it all" }, { agent: "planner" });
  rec("link", { to: other });
}

describe("topic pages", () => {
  test("a new topic: title, description, Status: Active, the goal and related, no empty section", () => {
    createTopic();
    render();
    expect(page(`${topicDir}/topic.md`)).toBe(
      [
        `<!-- open-second-brain-view store=<store> page=${topicDir}/topic.md topic=<id> -->`,
        "",
        "# Brain store",
        "",
        "No description yet.",
        "",
        "Status: Active",
        "",
        "## Goal",
        "",
        "Move machine data out of the vault",
        "",
        "## Related",
        "",
        "- Project: o2b",
        "",
      ].join("\n"),
    );
  });

  test("English snapshot: fixed section order, earned log only, proposals as open questions", () => {
    seedFull();
    render();
    expect(page(`${topicDir}/topic.md`)).toBe(
      [
        `<!-- open-second-brain-view store=<store> page=${topicDir}/topic.md topic=<id> -->`,
        "",
        "# Brain store",
        "",
        "Store outside the vault",
        "",
        "Status: Active",
        "",
        "## Goal",
        "",
        "Move machine data out of the vault",
        "",
        "## Milestones",
        "",
        "- [ ] Migration (looks done, confirm)",
        "- [ ] Topics",
        "- [x] Store core (done 2026-11-02)",
        "",
        "## Decisions",
        "",
        "- Monthly shards per device (serves: Store core)",
        "",
        "## Open questions",
        "",
        "- Where do phones get the view?",
        "- Goal proposed by planner: Ship it all",
        "",
        "## Log",
        "",
        "- 2026-11-02, rejected approach: One file per writer, because devices churn",
        "- 2026-11-02, blocker: Sync conflicts on pinned.md",
        "",
        "## Related",
        "",
        "- Project: o2b",
        "- [Docs](../2026-11-02-docs/topic.md)",
        "",
      ].join("\n"),
    );
  });

  test("Russian snapshot: generated prose in Russian, quoted lines as written", () => {
    seedSetting(a, T0, "view.language", "ru");
    seedFull();
    render();
    const text = page(`${topicDir}/topic.md`);
    expect(text.split("\n").slice(6)).toEqual([
      "Статус: Активна",
      "",
      "## Цель",
      "",
      "Move machine data out of the vault",
      "",
      "## Вехи",
      "",
      "- [ ] Migration (похоже, готово, подтвердите)",
      "- [ ] Topics",
      "- [x] Store core (готово 2026-11-02)",
      "",
      "## Решения",
      "",
      "- Monthly shards per device (служит: Store core)",
      "",
      "## Открытые вопросы",
      "",
      "- Where do phones get the view?",
      "- Цель, предложенная planner: Ship it all",
      "",
      "## Журнал",
      "",
      "- 2026-11-02, отвергнутый подход: One file per writer, потому что devices churn",
      "- 2026-11-02, блокер: Sync conflicts on pinned.md",
      "",
      "## Связанное",
      "",
      "- Проект: o2b",
      "- [Docs](../2026-11-02-docs/topic.md)",
      "",
    ]);
  });

  test("budget overflow: the oldest done milestones and log entries move to archive.md", () => {
    createTopic();
    for (let i = 1; i <= 12; i++) {
      rec("milestone", { item: `m${i}`, text: `Milestone ${i}` });
      rec("milestone-done", { milestone: `m${i}` }, { authority: "human" });
    }
    for (let i = 1; i <= 17; i++) rec("log-entry", { text: `Blocker ${i}`, class: "blocker" });
    render();
    const main = page(`${topicDir}/topic.md`);
    expect(main.match(/^- \[x\]/gm)!.length).toBe(10);
    expect(main.match(/, blocker: /g)!.length).toBe(15);
    expect(main).not.toContain("Milestone 1 ");
    expect(main).not.toContain("Blocker 2\n");
    expect(main.trimEnd().endsWith("- [Older entries](archive.md)")).toBe(true);
    expect(page(`${topicDir}/archive.md`)).toBe(
      [
        `<!-- open-second-brain-view store=<store> page=${topicDir}/archive.md topic=<id> -->`,
        "",
        "# Brain store: archive",
        "",
        "Entries that moved off the topic page, newest first.",
        "",
        "[Back to the topic](topic.md)",
        "",
        "## Milestones",
        "",
        "- [x] Milestone 2 (done 2026-11-02)",
        "- [x] Milestone 1 (done 2026-11-02)",
        "",
        "## Log",
        "",
        "- 2026-11-02, blocker: Blocker 2",
        "- 2026-11-02, blocker: Blocker 1",
        "",
      ].join("\n"),
    );
  });

  test("a rename moves the folder, keeps the id and takes the user's companion files along", () => {
    createTopic();
    rec("decision", { text: "Keep JSONL" });
    render();
    writeFileSync(view(`${topicDir}/notes.md`), "my notes\n");
    rec("topic-rename", { title: "Store and topics" }, { authority: "human" });
    render(1);
    const moved = "topics/2026-11-02-store-and-topics";
    expect(existsSync(view(topicDir))).toBe(false);
    expect(readdirSync(view(moved)).toSorted()).toEqual(["notes.md", "topic.md"]);
    const text = page(`${moved}/topic.md`);
    expect(text).toContain("topic=<id> -->");
    expect(text).toContain("# Store and topics");
    expect(text).toContain("- Keep JSONL");
  });

  test("the user's goal on the page wins, and a later agent goal shows as its open question", () => {
    createTopic();
    render();
    const path = view(`${topicDir}/topic.md`);
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace("Move machine data out of the vault", "Ship phase 3"),
    );
    render(1);
    rec("topic-goal", { goal: "Ship everything at once" }, { agent: "planner" });
    render(1);
    const goals = readPartition(join(m.root("dev-a"), "shared"))
      .flatMap((s) => s.records)
      .filter((r) => r.kind === "topic-goal")
      .map((r) => [r.body["authority"], r.body["goal"], r.topic]);
    expect(goals).toEqual([
      ["human", "Ship phase 3", topic],
      ["agent", "Ship everything at once", topic],
    ]);
    const text = page(`${topicDir}/topic.md`);
    expect(text).toContain("## Goal\n\nShip phase 3\n");
    expect(text).toContain("- Goal proposed by planner: Ship everything at once");
  });

  test("an item the user deletes or adds on the page becomes a human topic record", () => {
    createTopic();
    rec("decision", { item: "d1", text: "Keep JSONL" });
    rec("decision", { item: "d2", text: "Use SQLite" });
    render();
    const path = view(`${topicDir}/topic.md`);
    const edit = (from: string, to: string): void => {
      writeFileSync(path, readFileSync(path, "utf8").replace(from, to));
      render(1);
    };
    edit("- Keep JSONL\n", "");
    edit("- Use SQLite\n", "- Use SQLite\n- Mirror nothing to phones\n");
    const records = readPartition(join(m.root("dev-a"), "shared")).flatMap((s) => s.records);
    const fold = foldTopics(records).topics.get(topic)!;
    expect(fold.items.map((i) => [i.text, i.author.authority])).toEqual([
      ["Use SQLite", "agent"],
      ["Mirror nothing to phones", "human"],
    ]);
    expect(page(`${topicDir}/topic.md`)).toContain(
      "## Decisions\n\n- Mirror nothing to phones\n- Use SQLite\n",
    );
  });

  test("a milestone unticked on the page is open again on the next render", () => {
    createTopic();
    rec("milestone", { item: "m1", text: "Store core" });
    rec("milestone-done", { milestone: "m1" }, { authority: "human" });
    render();
    const path = view(`${topicDir}/topic.md`);
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace("- [x] Store core (done 2026-11-02)", "- [ ] Store core"),
    );
    render(2);
    expect(page(`${topicDir}/topic.md`)).toContain("## Milestones\n\n- [ ] Store core\n");
  });

  test("two machines' events for one topic land on one page, with no conflict copy", () => {
    createTopic();
    const b = m.open("dev-b");
    rec("log-entry", { text: "Found on A", class: "blocker" });
    rec("log-entry", { text: "Found on B", class: "reframing" }, { on: b });
    render();
    m.sync();
    render();
    expect(page(`${topicDir}/topic.md`)).toContain(
      "## Log\n\n- 2026-11-02, reframing: Found on B\n- 2026-11-02, blocker: Found on A\n",
    );
    expect(readdirSync(view(topicDir))).toEqual(["topic.md"]);
  });

  test("a merged topic's page is removed; its items and name show on the topic it joined", () => {
    createTopic();
    rec(
      "topic-create",
      { title: "Docs", scope: "project:o2b" },
      { topic: other, authority: "human" },
    );
    rec("decision", { text: "Write the guide" }, { topic: other });
    render();
    expect(existsSync(view("topics/2026-11-02-docs/topic.md"))).toBe(true);
    rec("merge", { into: topic }, { topic: other, authority: "human" });
    render(1);
    expect(existsSync(view("topics/2026-11-02-docs"))).toBe(false);
    const text = page(`${topicDir}/topic.md`);
    expect(text).toContain("- Write the guide");
    expect(text).toContain("- Merged from: Docs");
  });

  test("a folder taken by a title that ends in another topic's id tail is never shared", () => {
    const tail = "01KA0000000000000000ABCDEF";
    rec(
      "topic-create",
      { title: "alpha-abcdef", scope: "project:o2b" },
      { topic: newUlid(T0 + 5), authority: "human" },
    );
    rec(
      "topic-create",
      { title: "alpha", scope: "project:o2b" },
      { topic: newUlid(T0 + 6), authority: "human" },
    );
    rec(
      "topic-create",
      { title: "alpha", scope: "project:o2b" },
      { topic: tail, authority: "human" },
    );
    render();
    expect(readdirSync(view("topics"))).toHaveLength(3);
  });

  test("a private topic and a shared record carrying a private region stay off the view", () => {
    rec(
      "topic-create",
      { title: "Health", scope: "personal" },
      { partition: "private", topic: other },
    );
    createTopic();
    rec("decision", { text: "Ask <private>Dr. X</private> first" });
    render();
    expect(readdirSync(view("topics"))).toEqual(["2026-11-02-brain-store"]);
    expect(page(`${topicDir}/topic.md`)).not.toContain("Dr. X");
  });
});

describe("report and source pages", () => {
  test("ids that differ only in case render one page, and a device name renders none", () => {
    for (const entry of ["2026-11-02-vector", "2026-11-02-Vector", "con", "nul.txt"]) {
      seedLaneEntry(a, (clock += 1000), "reports", entry, { title: entry }, `Body of ${entry}.`);
    }
    render();
    expect(readdirSync(view("reports"))).toEqual(["2026-11-02-Vector.md"]);
  });

  test("a report and a source summary render from their lane entries; a removed one goes", () => {
    seedLaneEntry(
      a,
      T0,
      "reports",
      "2026-11-02-vector-stores",
      { title: "Vector stores", report_date: "2026-11-02" },
      "# Vector stores\n\n## Findings\n\n- SQLite is enough (cites: [[notes/sqlite|SQLite notes]])\n",
    );
    seedLaneEntry(
      a,
      T0 + 1,
      "sources",
      "src-paper-abc123",
      { source_path: "Papers/hlc.pdf", updated_at: "2026-11-03T10:00:00Z" },
      "Hybrid logical clocks order events across machines.",
    );
    render();
    expect(page("reports/2026-11-02-vector-stores.md")).toBe(
      [
        "<!-- open-second-brain-view store=<store> page=reports/2026-11-02-vector-stores.md -->",
        "",
        "# Vector stores",
        "",
        "Research report of 2026-11-02.",
        "",
        "## Findings",
        "",
        "- SQLite is enough (cites: SQLite notes)",
        "",
      ].join("\n"),
    );
    expect(page("sources/src-paper-abc123.md")).toBe(
      [
        "<!-- open-second-brain-view store=<store> page=sources/src-paper-abc123.md -->",
        "",
        "# Source: Papers/hlc.pdf",
        "",
        "Summary of a source, updated 2026-11-03.",
        "",
        "Hybrid logical clocks order events across machines.",
        "",
      ].join("\n"),
    );
    clock += 1000;
    seedLaneRemove(a, clock, "reports", "2026-11-02-vector-stores");
    render(1);
    expect(existsSync(view("reports"))).toBe(false);
  });
});
