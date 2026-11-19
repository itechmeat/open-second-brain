/**
 * The one place that knows a sync tool's leftover names
 * (`ledger-shards.ts`): conflict copies (Syncthing, and the
 * "conflicted copy" form Dropbox and Nextcloud write), the original name
 * a copy stands for, and the in-flight temp files a sync tool writes
 * while it downloads (Syncthing, Nextcloud). Real-world names, and names
 * that merely contain the word "conflict", which must not match.
 */

import { describe, expect, test } from "bun:test";

import {
  isSyncConflictName,
  isSyncTempName,
  syncConflictOriginalName,
} from "../../../src/core/brain/ledger-shards.ts";

/** [name, the original it is a copy of, or null when it is no conflict copy]. */
const CONFLICT_TABLE: ReadonlyArray<readonly [string, string | null]> = [
  // Syncthing: `<stem>.sync-conflict-<YYYYMMDD>-<HHMMSS>-<device>.<ext>`.
  ["freshen-state.sync-conflict-20261105-220819-QFQZVF3.json", "freshen-state.json"],
  ["self-heal-upgrade.sync-conflict-20261118-225721-QFQZVF3.lock", "self-heal-upgrade.lock"],
  [
    "sig-2026-08-05-fact-url-3.sync-conflict-20260805-091313-PYXV73G.md",
    "sig-2026-08-05-fact-url-3.md",
  ],
  ["2026-10-28.c6e87fd7.sync-conflict-20261028-211616-QFQZVF3.jsonl", "2026-10-28.c6e87fd7.jsonl"],
  ["2026-W44.c6e87fd7.sync-conflict-20261028-211617-QFQZVF3.jsonl", "2026-W44.c6e87fd7.jsonl"],
  ["pinned.sync-conflict-20260827-105124-PYXV73G.md", "pinned.md"],
  ["Makefile.sync-conflict-20260910-000000-ABCDEFG", "Makefile"],
  ["archive.tar.sync-conflict-20260910-000000-ABCDEFG.gz", "archive.tar.gz"],
  // Dropbox: `<stem> (<who>'s conflicted copy <date>).<ext>`.
  ["pinned (Serg's conflicted copy 2026-08-27).md", "pinned.md"],
  ["about me (conflicted copy 2026-08-27).md", "about me.md"],
  // Nextcloud: `<stem> (conflicted copy <date> <time>).<ext>`.
  ["2026-W40 (conflicted copy 2026-09-30 151733).jsonl", "2026-W40.jsonl"],
  ["notes (conflicted copy 2026-09-30 151733)", "notes"],
  // Names that merely contain the word: never a copy.
  ["conflict.md", null],
  ["conflict-resolution.md", null],
  ["sync-conflict.jsonl", null],
  ["sync-conflict-notes.md", null],
  ["sig-2026-11-02-fact-sync-conflict-in-notes.md", null],
  ["notes (conflict).md", null],
  ["my conflicted copy notes.md", null],
  ["2026-08.jsonl", null],
];

/** [name, whether it is a sync tool's in-flight temp file]. */
const TEMP_TABLE: ReadonlyArray<readonly [string, boolean]> = [
  // Syncthing, current and older releases.
  [".syncthing.sig-2026-11-18-fact-url-597.md.tmp", true],
  ["~syncthing~sig-2026-11-18-fact-url-597.md.tmp", true],
  // Nextcloud desktop client download: `.<name>.~<hex>`.
  [".2026-W40.jsonl.~1d5e3a", true],
  // Not temp files of a sync tool.
  ["sig-2026-11-18-fact-url-597.md", false],
  ["syncthing.md", false],
  [".syncthing.md", false],
  ["notes.tmp", false],
  [".stfolder", false],
  [".2026-W40.jsonl.~draft", false],
  // An atomic write of Open Second Brain itself is its own kind, not a sync tool's.
  [".pinned.md.123.456.abc.tmp", false],
];

describe("sync conflict copies", () => {
  test.each(CONFLICT_TABLE)("%s", (name, original) => {
    expect(isSyncConflictName(name)).toBe(original !== null);
    expect(syncConflictOriginalName(name)).toBe(original);
  });
});

describe("sync temp files", () => {
  test.each(TEMP_TABLE)("%s", (name, temp) => {
    expect(isSyncTempName(name)).toBe(temp);
  });
});
