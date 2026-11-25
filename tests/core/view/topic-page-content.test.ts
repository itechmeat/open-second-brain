/**
 * What a topic page shows of the knowledge it groups (spec `topics` "Topic
 * page"): the held notes and signals listed one line each with their event
 * day and kind, newest first, capped with a count of the rest; never a
 * private record or region; the goal in the description's place; no scope
 * line for a personal topic; long text cut at a word with an ellipsis; and
 * days taken from when things happened, not from when a pass filed them.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join, relative } from "node:path";

import { appendRecord } from "../../../src/core/store/appender.ts";
import type { StorePartition } from "../../../src/core/store/constants.ts";
import { addQuarantine } from "../../../src/core/store/shard-quarantine-write.ts";
import { lineSha256At } from "../../../src/core/store/shard-quarantine.ts";
import type { StoreHandle } from "../../../src/core/store/store-open.ts";
import { partitionDir } from "../../../src/core/store/store-paths.ts";
import { newUlid } from "../../../src/core/store/ulid.ts";
import { runViewPass } from "../../../src/core/view/render.ts";
import { TOPIC_HELD_SHOWN } from "../../../src/core/view/topic-pages.ts";
import { claimViewWriter } from "../../../src/core/view/writer.ts";
import { makeMachines, type Machines } from "./fixtures/machines.ts";
import { seedTopicRecord } from "./fixtures/seed.ts";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 2, 9, 0, 0);
let clock = T0;
const now = () => clock;

let m: Machines;
let a: StoreHandle;
let topic: string;
let seq = 0;

beforeEach(() => {
  clock = T0;
  seq = 0;
  m = makeMachines(["dev-a"]);
  a = m.open("dev-a");
  topic = newUlid(T0);
});
afterEach(() => m.cleanup());

function rec(kind: string, body: Record<string, unknown>): string {
  clock += 60_000;
  return seedTopicRecord(a, clock, kind, topic, body, { authority: "agent" });
}

function createTopic(body: Record<string, unknown> = {}): void {
  rec("topic-create", {
    title: "Release media",
    scope: "personal",
    goal: "Ship clear media",
    ...body,
  });
}

function note(text: string, at: number, partition: StorePartition = "shared"): string {
  return appendRecord(
    a,
    {
      partition,
      stream: "log",
      kind: "log-event",
      agent: "seed",
      body: { timestamp: new Date(at).toISOString(), event_type: "note", body: { text } },
    },
    { now: () => at },
  ).record.id;
}

/** A capture of a signal: a new one, or another capture of `opts.id`. */
function signal(
  text: string,
  at: number,
  frontmatter: Record<string, unknown> = {},
  opts: { id?: string } = {},
): string {
  seq += 1;
  return appendRecord(
    a,
    {
      partition: "shared",
      stream: "events",
      kind: "signal",
      agent: "agent-1",
      body: {
        id: opts.id ?? `sig-2026-06-01-x${seq}`,
        path: `Brain/inbox/x${seq}.md`,
        staged: false,
        frontmatter: { principle: text, session: "s1", ...frontmatter },
        raw: null,
        raw_shape: "bare",
      },
    },
    { now: () => at },
  ).record.id;
}

const hold = (record: string): string => rec("assign", { record });

function render(): string {
  claimViewWriter(a, { agent: "t", now });
  for (let i = 0; i < 2; i++) {
    clock += 1000;
    runViewPass(a, { target: m.view("dev-a"), vault: null, agent: "t", now });
  }
  const dir = join(m.view("dev-a"), "topics");
  const [folder] = readdirSync(dir);
  return readFileSync(join(dir, folder!, "topic.md"), "utf8");
}

const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

describe("topic page content", () => {
  test("held notes and signals are listed with their day and kind, newest first; private ones never", () => {
    // Written when they happened, before the topic grouped them.
    const held = [
      note("Recorded the launch film voice-over", T0 - 150 * DAY),
      signal("Name the models under the hood in every release post", T0 - 140 * DAY),
      note("Picked the soundtrack for the update film", T0 - 120 * DAY),
      note("A private plan for the teaser", T0 - 100 * DAY, "private"),
      note("Cut <private>the secret cut</private> of the trailer", T0 - 90 * DAY),
      signal("A private rule", T0 - 80 * DAY, { visibility: "private" }),
    ];
    createTopic();
    held.forEach(hold);
    const text = render();
    expect(text).toContain(
      [
        "## Rules and facts",
        "",
        `- ${day(T0 - 140 * DAY)}, rule: Name the models under the hood in every release post`,
        "",
        "## Log",
        "",
        `- ${day(T0 - 120 * DAY)}, note: Picked the soundtrack for the update film`,
        `- ${day(T0 - 150 * DAY)}, note: Recorded the launch film voice-over`,
        "",
      ].join("\n"),
    );
    expect(text).not.toContain("private");
    expect(text).not.toContain("secret");
    expect(text).not.toContain("Holds ");
  });

  test("every held capture of one signal is listed", () => {
    const first = signal("Name the models in the release post", T0 - 140 * DAY);
    const id = "sig-2026-06-01-x1";
    const second = signal("Name the models in every release post", T0 - 60 * DAY, {}, { id });
    createTopic();
    hold(first);
    hold(second);
    const text = render();
    expect(text).toContain(
      [
        `- ${day(T0 - 60 * DAY)}, rule: Name the models in every release post`,
        `- ${day(T0 - 140 * DAY)}, rule: Name the models in the release post`,
      ].join("\n"),
    );
  });

  test("held signals are withheld while a signal record's body has not arrived", () => {
    const plain = note("Recorded the launch film voice-over", T0 - 150 * DAY);
    const held = signal("A rule whose private capture is still syncing", T0 - 140 * DAY);
    // A private capture of the same signal, large enough to live in a blob,
    // whose blob has not arrived: the read counts it pending, with no body
    // to say which signal it belongs to.
    const pending = appendRecord(
      a,
      {
        partition: "private",
        stream: "events",
        kind: "signal",
        agent: "agent-1",
        body: {
          id: "sig-2026-06-01-x1",
          path: "Brain/inbox/x1.md",
          staged: false,
          frontmatter: { principle: "A rule whose private capture is still syncing" },
          raw: "x".repeat(300_000),
          raw_shape: "bare",
        },
      },
      { now: () => T0 - 130 * DAY },
    );
    const dir = partitionDir(a.root, "private");
    rmSync(join(dir, "blobs"), { recursive: true, force: true });
    const lines = readFileSync(pending.path, "utf8").split("\n");
    const at = lines.findIndex((l) => l.includes(pending.record.id));
    const offset = Buffer.byteLength(
      lines
        .slice(0, at)
        .map((l) => `${l}\n`)
        .join(""),
      "utf8",
    );
    addQuarantine(a.root, {
      partition: "private",
      shard: relative(dir, pending.path).split("\\").join("/"),
      offset,
      sha256: lineSha256At(pending.path, offset, dir)!,
      kind: "blob-pending",
      reason: "test",
    });
    createTopic();
    hold(held);
    hold(plain);
    const text = render();
    expect(text).not.toContain("A rule whose private capture is still syncing");
    // A note's own record decides, so it is still listed.
    expect(text).toContain(`- ${day(T0 - 150 * DAY)}, note: Recorded the launch film voice-over`);
  });

  test("a very large topic lists the newest records and counts the rest", () => {
    const extra = 4;
    const held = Array.from({ length: TOPIC_HELD_SHOWN + extra }, (_, i) =>
      note(`Note number ${i}`, T0 - (200 - i) * DAY),
    );
    createTopic();
    held.forEach(hold);
    const text = render();
    const listed = text.split("\n").filter((l) => /^- \d{4}-\d{2}-\d{2}, note: /.test(l));
    expect(listed).toHaveLength(TOPIC_HELD_SHOWN);
    expect(listed[0]).toContain(`Note number ${TOPIC_HELD_SHOWN + extra - 1}`);
    expect(listed).not.toContainEqual(expect.stringContaining("Note number 0"));
    expect(text).toContain(
      `- ${extra} more record(s) not shown: \`o2b topic show ${topic} --held\``,
    );
  });

  test("the goal stands in for a missing description; with neither, no placeholder", () => {
    createTopic();
    const withGoal = render();
    expect(withGoal).toContain("# Release media\n\nShip clear media\n\nStatus: Active\n");
    expect(withGoal).not.toContain("No description yet.");
    expect(withGoal).not.toContain("## Goal");
  });

  test("a topic with neither description nor goal shows no placeholder", () => {
    rec("topic-create", { title: "Release media", scope: "personal" });
    const text = render();
    expect(text).toContain("# Release media\n\nStatus: Active\n");
    expect(text).not.toContain("No description yet.");
  });

  test("a personal topic names no scope in Related", () => {
    createTopic();
    hold(note("Recorded the launch film voice-over", T0 - 150 * DAY));
    const text = render();
    expect(text).not.toContain("Personal matter");
    expect(text).not.toContain("## Related");
  });

  test("a long text is cut at a word boundary with an ellipsis", () => {
    createTopic();
    const words = Array.from({ length: 120 }, (_, i) => `word${i}`).join(" ");
    const cut = words.slice(0, 512);
    rec("decision", { item: "d1", text: cut });
    const text = render();
    const line = text.split("\n").find((l) => l.startsWith("- word0 "))!;
    expect(line.endsWith("…")).toBe(true);
    expect(line).toMatch(/ word\d+…$/);
    expect([...line].length).toBeLessThan(512);
  });

  test("a log entry is dated by the record it names, and the folder by the topic's own time", () => {
    // A pass judged two days before it ran minted the topic id at that time.
    topic = newUlid(T0 - 2 * DAY);
    const happened = T0 - 180 * DAY;
    const id = note("Shipped the launch film", happened);
    createTopic();
    hold(id);
    rec("log-entry", { item: id, text: "Shipped the launch film", class: "decision" });
    const text = render();
    expect(text).toContain(`- ${day(happened)}, decision: Shipped the launch film`);
    expect(text).not.toContain(`${day(clock)}, decision`);
    expect(readdirSync(join(m.view("dev-a"), "topics"))).toEqual([
      `${day(T0 - 2 * DAY)}-release-media`,
    ]);
  });
});
