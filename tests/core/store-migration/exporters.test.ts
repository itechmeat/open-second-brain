/**
 * The rollback's log exporter on a resumed run: a row a killed run
 * appended but never journaled is not appended again, while two equal
 * events of a fresh run stay two rows.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { appendRecord } from "../../../src/core/store/appender.ts";
import type { StoreRecord } from "../../../src/core/store/envelope.ts";
import { openStore } from "../../../src/core/store/store-open.ts";
import {
  exportRecords,
  type ExportJournal,
  type StartMark,
} from "../../../src/core/store-migration/exporters.ts";
import { makeTestStore, type TestStore } from "../../helpers/test-store.ts";
import { tempDirs } from "../../helpers/temp-dir.ts";

const temp = tempDirs();
let store: TestStore;
let vault: string;
beforeEach(() => {
  store = makeTestStore("osb-exporters-");
  vault = temp("osb-exporters-vault-");
  mkdirSync(join(vault, "Brain", "log"), { recursive: true });
});
afterEach(() => store.cleanup());

function event(at: number): StoreRecord {
  return appendRecord(
    openStore({ root: store.root, device: "dev-a" }),
    {
      partition: "shared",
      stream: "log",
      kind: "log-event",
      agent: "t",
      body: { timestamp: new Date(at).toISOString(), event_type: "note", body: { text: "same" } },
    },
    { now: () => at },
  ).record;
}

function journal(
  started: ReadonlyMap<string, StartMark> = new Map(),
  done: ReadonlySet<string> = new Set(),
  onStart: ExportJournal["onStart"] = () => {},
): ExportJournal {
  return { done, started, onStart, onRecord: () => {} };
}

const SHARD = (): string => join(vault, "Brain", "log", "2026-11-08.dev-a.jsonl");
const rows = (): string[] => readFileSync(SHARD(), "utf8").split("\n").filter(Boolean);

describe("exportRecords, log events", () => {
  test("two equal events of a fresh run are two rows", () => {
    const records = [event(Date.UTC(2026, 10, 8, 9)), event(Date.UTC(2026, 10, 8, 9))];
    exportRecords(vault, "dev-a", { records, all: records }, journal());
    expect(rows()).toHaveLength(2);
  });

  test("a row a killed run appended but never journaled is not appended again", () => {
    const record = event(Date.UTC(2026, 10, 8, 9));
    const marks = new Map<string, StartMark>();
    exportRecords(
      vault,
      "dev-a",
      { records: [record], all: [record] },
      journal(new Map(), new Set(), (r, tail) => marks.set(r.id, { tail })),
    );
    expect(marks.get(record.id)).toEqual({ tail: null });
    // The kill came after the append, before the journal said it was done.
    exportRecords(vault, "dev-a", { records: [record], all: [record] }, journal(marks));
    expect(rows()).toHaveLength(1);
  });

  test("an equal row of an earlier done record does not stand in for a started one", () => {
    const first = event(Date.UTC(2026, 10, 8, 9));
    const second = event(Date.UTC(2026, 10, 8, 9));
    const marks = new Map<string, StartMark>();
    // The first run wrote and journaled `first`, journaled the start of
    // `second` and was killed before appending it.
    exportRecords(
      vault,
      "dev-a",
      { records: [first], all: [first, second] },
      journal(new Map(), new Set(), (r, tail) => marks.set(r.id, { tail })),
    );
    const tailAfterFirst = JSON.parse(rows()[0]!)["h"] as string;
    marks.set(second.id, { tail: tailAfterFirst });
    exportRecords(
      vault,
      "dev-a",
      { records: [first, second], all: [first, second] },
      journal(new Map([[second.id, marks.get(second.id)!]]), new Set([first.id])),
    );
    expect(rows()).toHaveLength(2);
  });
});

describe("exportRecords, signal pages", () => {
  test("never removes another signal's page that shares the file name", () => {
    const at = Date.UTC(2026, 10, 8, 9);
    const signal = appendRecord(
      openStore({ root: store.root, device: "dev-a" }),
      {
        partition: "shared",
        stream: "events",
        kind: "signal",
        agent: "t",
        body: {
          id: "sig-mine",
          path: "Brain/inbox/x.md",
          staged: false,
          frontmatter: { id: "sig-mine", topic: "mine", principle: "Mine" },
          raw: "Mine.",
        },
      },
      { now: () => at },
    ).record;
    // Another signal's page, already processed, with the same file name.
    const theirs = join(vault, "Brain", "inbox", "processed", "x.md");
    mkdirSync(join(theirs, ".."), { recursive: true });
    writeFileSync(theirs, "---\nid: sig-theirs\ntopic: theirs\nprinciple: Theirs\n---\n");
    exportRecords(vault, "dev-a", { records: [signal], all: [signal] }, journal());
    expect(readFileSync(join(vault, "Brain", "inbox", "x.md"), "utf8")).toContain("sig-mine");
    expect(existsSync(theirs)).toBe(true);
  });
});
