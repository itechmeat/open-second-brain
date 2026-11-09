/**
 * Paths carried by store records are untrusted (FORMAT.md, Trust): a synced
 * peer can write any body. The shape check refuses traversal, absolute,
 * Windows-style and malformed paths; the containment helper refuses
 * anything that lands outside its root, including through a link, and
 * Windows device names on Windows. Lane entry ids and the `migrated.key`
 * of imported records go through the same check.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  containedRecordPath,
  isRecordRelPath,
  recordRelPathProblem,
} from "../../../src/core/record-path.ts";
import { foldLaneEntries, isLaneEntryId } from "../../../src/core/store/lane-records.ts";
import { migratedMark } from "../../../src/core/store-migration/migration-records.ts";
import type { StoreRecord } from "../../../src/core/store/envelope.ts";
import { authored, rec } from "./fixtures/fold-records.ts";

const HOSTILE = [
  "../x",
  "a/../../x",
  "a/..",
  "./x",
  "a/./b",
  "/etc/passwd",
  "//server/share/x",
  "a//b",
  "a/",
  "..\\..\\x",
  "a\\b",
  "C:/Windows/x",
  "c:x",
  "a/\u0000b",
  "a/.. /b",
  "a/... /b",
  "",
];

let parent = "";
beforeEach(() => {
  parent = mkdtempSync(join(tmpdir(), "osb-record-path-"));
});
afterEach(() => {
  rmSync(parent, { recursive: true, force: true });
});

function laneRecord(entry: string, physical: number): StoreRecord {
  return rec({
    physical,
    device: "dev-b",
    kind: "lane-entry",
    body: authored("agent", { lane: "obligations", entry, fields: {}, text: "x" }),
  });
}

function mark(key: string): StoreRecord {
  return { body: { migrated: { key, sum: "s", part: 0, parts: 1 } } } as unknown as StoreRecord;
}

describe("record paths", () => {
  test("the shape check refuses traversal, absolute, Windows-style and malformed paths", () => {
    for (const rel of HOSTILE) {
      expect({ rel, problem: recordRelPathProblem(rel) === null }).toEqual({ rel, problem: false });
    }
    for (const rel of ["Brain/inbox/sig-a.md", "archive/de-x", "lexicon.json", "a..b/c.d"]) {
      expect(isRecordRelPath(rel)).toBe(true);
    }
  });

  test("lane entry ids refuse the same paths, and the fold reports the records", () => {
    for (const rel of HOSTILE) expect(isLaneEntryId(rel)).toBe(false);
    expect(isLaneEntryId("archive/de-x")).toBe(true);
    const hostile = laneRecord("../../escape", 1);
    const fold = foldLaneEntries([hostile, laneRecord("ok", 2)]);
    expect([...fold.entries.keys()]).toEqual(["obligations/ok"]);
    expect(fold.rejected.map((r) => r.id)).toEqual([hostile.id]);
  });

  test("a migrated mark whose key is no record path is not a mark", () => {
    expect(migratedMark(mark("../../outside.md"))).toBeNull();
    expect(migratedMark(mark("/abs/x.md"))).toBeNull();
    expect(migratedMark(mark("Brain\\x.md"))).toBeNull();
    expect(migratedMark(mark("Brain/log/2026-11-01.dev-a.jsonl#3"))?.key).toBe(
      "Brain/log/2026-11-01.dev-a.jsonl#3",
    );
  });

  test("containment refuses a path outside the root, the root itself and a link out", () => {
    const root = join(parent, "vault", "Brain");
    const outside = join(parent, "outside");
    mkdirSync(root, { recursive: true });
    mkdirSync(outside, { recursive: true });
    expect(containedRecordPath(root, "inbox/a.md")).toBe(join(root, "inbox", "a.md"));
    for (const rel of HOSTILE) expect(containedRecordPath(root, rel)).toBeNull();
    symlinkSync(outside, join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
    expect(containedRecordPath(root, "linked/a.md")).toBeNull();
  });

  test("on Windows a device name is refused as any segment, whatever its extension", () => {
    const root = join(parent, "Brain");
    for (const rel of ["con.md", "a/NUL", "a/com1.txt", "lpt9.md", "aux .md"]) {
      expect(containedRecordPath(root, rel, "win32")).toBeNull();
      expect(containedRecordPath(root, rel, "linux")).not.toBeNull();
    }
    expect(containedRecordPath(root, "console.md", "win32")).not.toBeNull();
  });

  test("on Windows a stream, a trailing dot or space, a refused character or a console name is refused", () => {
    const root = join(parent, "Brain");
    for (const rel of [
      "inbox/a.md:evil",
      "inbox/a.md.",
      "inbox/a.md ",
      "inbox/a?.md",
      'inbox/"a".md',
      "inbox/a|b.md",
      "CONIN$",
      "a/conout$.md",
    ]) {
      expect(containedRecordPath(root, rel, "win32")).toBeNull();
    }
    expect(containedRecordPath(root, "inbox/a.md", "win32")).not.toBeNull();
    expect(containedRecordPath(root, "inbox/a.md:evil", "linux")).not.toBeNull();
  });
});
