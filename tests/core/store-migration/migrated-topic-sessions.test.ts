/**
 * A migrated history forms topics by the ordinary thresholds. Topic
 * planning counts sessions by the record's `session`, else its
 * `session_ref`, else the device, agent and UTC day that wrote it; a
 * migrated record's clock is the migration's and its envelope device the
 * migrating machine, so the fallback is built from when and where the
 * legacy item was written instead (`candidates.ts` `originOf`): a log
 * event's `timestamp` and its shard's `legacy_device`, a signal's
 * `created_at`, else the date in the legacy file name. The record itself
 * is unchanged, so the same item is still imported once and a rollback
 * restores the legacy tree as it was.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { appendRecord } from "../../../src/core/store/appender.ts";
import {
  SETTING_TOPIC_MIN_RECORDS,
  SETTING_TOPIC_MIN_SESSIONS,
  SETTING_TOPIC_QUIET_DAYS,
} from "../../../src/core/store/constants.ts";
import type { StoreRecord } from "../../../src/core/store/envelope.ts";
import { foldSettings, settingValue } from "../../../src/core/store/fold-settings.ts";
import { parseHlc } from "../../../src/core/store/hlc.ts";
import { readPartition } from "../../../src/core/store/state-digest.ts";
import { runMigration } from "../../../src/core/store-migration/migrate.ts";
import { migratedMark } from "../../../src/core/store-migration/migration-records.ts";
import { rollback } from "../../../src/core/store-migration/outcome.ts";
import { topicCandidates, type TopicCandidate } from "../../../src/core/topics/candidates.ts";
import { foldTopics } from "../../../src/core/topics/fold.ts";
import { planTopics } from "../../../src/core/topics/plan.ts";
import { CLI_SPAWN_BUDGET_MS } from "../../helpers/cli-timeout.ts";
import { makeFleet, type Fleet, type Machine } from "./fixtures/fleet.ts";

setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

const FAST = { settleMs: 0 } as const;
/** Every member shares these subject words, and no fixture record does. */
const SUBJECT = "Shard compaction keeps monthly shard files small";
const DAYS = ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05"] as const;

let fleet: Fleet | null = null;
afterEach(() => {
  fleet?.cleanup();
  fleet = null;
});

function machine(): Machine {
  fleet = makeFleet(["dev-a"]);
  const a = fleet.machine("dev-a");
  a.use();
  return a;
}

function logLine(ts: string, text: string): string {
  const payload = { text, project: "o2b", agent: "solo" };
  return JSON.stringify({ ts, kind: "note", payload, prev: null, h: "0".repeat(64) }) + "\n";
}

/** One note per legacy log row, written by `solo` on the legacy device `dev-z`. */
function writeNotes(a: Machine, days: ReadonlyArray<string>): void {
  const byDay = new Map<string, string>();
  days.forEach((day, i) => {
    byDay.set(day, (byDay.get(day) ?? "") + logLine(`${day}T10:0${i}:00Z`, `${SUBJECT} ${i}`));
  });
  for (const [day, text] of byDay) a.write(`Brain/log/${day}.dev-z.jsonl`, text);
}

function signalPage(fields: Record<string, string>, body = "Raw."): string {
  const lines = Object.entries(fields).map(([k, v]) => `${k}: ${v}`);
  return `---\n${lines.join("\n")}\n---\n${body}\n`;
}

/** The topic candidates of the migrated store, as topic planning reads them. */
function candidates(a: Machine): TopicCandidate[] {
  const records = a.records();
  const privateIds = new Set(
    readPartition(join(a.storeRoot, "private")).flatMap((s) => s.all.map((r) => r.id)),
  );
  return topicCandidates(records, privateIds).filter((c) => c.text.startsWith("Shard"));
}

/** The topics a first planning pass creates, with the shipped thresholds. */
function created(found: ReadonlyArray<TopicCandidate>): number {
  const settings = foldSettings([]);
  const plan = planTopics(
    foldTopics([]),
    found,
    {
      minRecords: settingValue(settings, SETTING_TOPIC_MIN_RECORDS) as number,
      minSessions: settingValue(settings, SETTING_TOPIC_MIN_SESSIONS) as number,
      quietDays: settingValue(settings, SETTING_TOPIC_QUIET_DAYS) as number,
    },
    Date.UTC(2026, 10, 18),
  );
  return plan.creates.length;
}

function migrated(a: Machine): StoreRecord[] {
  return a.records().filter((r) => migratedMark(r) !== null);
}

describe("topics from a migrated history", () => {
  test("notes of one agent written on several days form a topic after the migration", () => {
    const a = machine();
    writeNotes(a, DAYS);
    expect(runMigration(a.vault, FAST).ok).toBe(true);
    const found = candidates(a);
    expect(found).toHaveLength(5);
    // When and where each note was written, not the migration's moment and machine.
    expect(found.map((c) => c.session).toSorted()).toEqual(DAYS.map((d) => `dev-z/solo/${d}`));
    expect(found.map((c) => new Date(c.at).toISOString()).toSorted()).toEqual(
      DAYS.map((d, i) => `${d}T10:0${i}:00.000Z`),
    );
    expect(created(found)).toBe(1);
  });

  test("notes of one agent written on one day stay one session and form no topic", () => {
    const a = machine();
    writeNotes(
      a,
      Array.from({ length: 5 }, () => "2026-09-01"),
    );
    expect(runMigration(a.vault, FAST).ok).toBe(true);
    const found = candidates(a);
    expect(found).toHaveLength(5);
    expect(new Set(found.map((c) => c.session))).toEqual(new Set(["dev-z/solo/2026-09-01"]));
    expect(created(found)).toBe(0);
  });

  test("signals of one agent captured on several days form a topic after the migration", () => {
    const a = machine();
    DAYS.forEach((day, i) => {
      a.write(
        `Brain/inbox/${day}-shard-${i}.md`,
        signalPage({
          kind: "brain-signal",
          id: `sig-${day}-shard-${i}`,
          created_at: `${day}T08:00:00.000Z`,
          topic: "shards",
          signal: "positive",
          agent: "solo",
          principle: `${SUBJECT} ${i}`,
          project: "o2b",
        }),
      );
    });
    expect(runMigration(a.vault, FAST).ok).toBe(true);
    const found = candidates(a);
    expect(found).toHaveLength(5);
    // A signal page names no device: the migrating machine stands in for it.
    expect(found.map((c) => c.session).toSorted()).toEqual(DAYS.map((d) => `dev-a/solo/${d}`));
    expect(found.map((c) => new Date(c.at).toISOString()).toSorted()).toEqual(
      DAYS.map((d) => `${d}T08:00:00.000Z`),
    );
    expect(created(found)).toBe(1);
  });

  test("an item with no readable time of its own takes the date of its file name, else the migration's", () => {
    const a = machine();
    a.write("Brain/log/2026-08-15.dev-z.jsonl", logLine("not a time", `${SUBJECT} log`));
    // A time without a zone reads differently on each machine: left out too.
    a.write(
      "Brain/log/2026-08-17.dev-z.jsonl",
      logLine("2026-08-01T10:00:00", `${SUBJECT} zoneless`),
    );
    a.write(
      "Brain/inbox/2026-08-16-undated.md",
      signalPage({
        id: "sig-undated",
        agent: "solo",
        principle: `${SUBJECT} page`,
        project: "o2b",
      }),
    );
    a.write(
      "Brain/inbox/no-date.md",
      signalPage({
        id: "sig-no-date",
        agent: "solo",
        principle: `${SUBJECT} bare`,
        project: "o2b",
      }),
    );
    expect(runMigration(a.vault, FAST).ok).toBe(true);
    const byText = new Map(candidates(a).map((c) => [c.text, c]));
    expect(byText.get(`${SUBJECT} log`)!.session).toBe("dev-z/solo/2026-08-15");
    expect(byText.get(`${SUBJECT} log`)!.at).toBe(Date.UTC(2026, 7, 15));
    expect(byText.get(`${SUBJECT} zoneless`)!.session).toBe("dev-z/solo/2026-08-17");
    expect(byText.get(`${SUBJECT} page`)!.session).toBe("dev-a/solo/2026-08-16");
    const bare = byText.get(`${SUBJECT} bare`)!;
    const record = a.records().find((r) => r.id === bare.id)!;
    expect(bare.at).toBe(parseHlc(record.hlc)!.physical);
    expect(bare.session).toBe(
      `dev-a/solo/${new Date(parseHlc(record.hlc)!.physical).toISOString().slice(0, 10)}`,
    );
  });

  test("a record written in the store keeps its own clock whatever time its body names", () => {
    const a = machine();
    expect(runMigration(a.vault, FAST).ok).toBe(true);
    // After the migration: the store clock never runs backwards, so the
    // record's own time is set past the newest stamp the migration wrote
    // (which is the wall clock of this run), a day on so its date differs.
    const newest = Math.max(...a.records().map((r) => parseHlc(r.hlc)!.physical));
    const at = newest + 86_400_000;
    const { record } = appendRecord(
      a.store(),
      {
        partition: "shared",
        stream: "events",
        kind: "signal",
        agent: "solo",
        body: {
          id: "sig-2026-11-10-native",
          path: "Brain/inbox/2026-01-01-native.md",
          staged: false,
          frontmatter: { principle: `${SUBJECT} native`, created_at: "2026-01-01T00:00:00Z" },
          raw: null,
          raw_shape: "bare",
        },
      },
      { now: () => at },
    );
    const native = candidates(a).find((c) => c.id === record.id)!;
    expect(native.at).toBe(at);
    expect(native.session).toBe(`dev-a/solo/${new Date(at).toISOString().slice(0, 10)}`);
  });

  test("guard: the migrated record carries no field beyond the import's own and keeps the migration's envelope", () => {
    const a = machine();
    writeNotes(a, DAYS);
    expect(runMigration(a.vault, FAST).ok).toBe(true);
    const notes = migrated(a).filter((r) => String(migratedMark(r)!.key).includes(".dev-z."));
    expect(notes).toHaveLength(5);
    for (const note of notes) {
      expect(Object.keys(note.body).toSorted()).toEqual(
        ["body", "event_type", "legacy_device", "migrated", "timestamp", "vault_id"].toSorted(),
      );
      // The envelope stays the migration's: the store orders by it.
      expect(note.device).toBe("dev-a");
    }
  });

  test("guard: a rollback restores the multi-day history as it was", () => {
    const a = machine();
    writeNotes(a, DAYS);
    const files = DAYS.map((d) => join(a.vault, "Brain", "log", `${d}.dev-z.jsonl`));
    const before = files.map((f) => readFileSync(f, "utf8"));
    expect(runMigration(a.vault, FAST).ok).toBe(true);
    rollback(a.vault);
    expect(files.map((f) => readFileSync(f, "utf8"))).toEqual(before);
  });
});
