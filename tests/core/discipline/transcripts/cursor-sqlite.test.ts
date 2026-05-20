import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cursorTranscript } from "../../../../src/core/discipline/transcripts/cursor.ts";

describe("cursorTranscript collectDetail", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "osb-cursor-"));
  });

  afterEach(() => {
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      // ignore cleanup failures
    }
  });

  test("returns null when no Cursor data exists", () => {
    const dayStart = Date.now() - 24 * 60 * 60 * 1000;
    const dayEnd = Date.now();
    const detail = cursorTranscript.collectDetail!(dayStart, dayEnd, home);
    expect(detail).toBeNull();
  });

  test("falls back gracefully when SQLite is unavailable", () => {
    const wsRoot = join(home, ".config", "Cursor", "User", "workspaceStorage", "fake-hash");
    mkdirSync(wsRoot, { recursive: true });
    writeFileSync(join(wsRoot, "state.vscdb"), "not a sqlite database");

    const dayStart = Date.now() - 24 * 60 * 60 * 1000;
    const dayEnd = Date.now();
    const detail = cursorTranscript.collectDetail!(dayStart, dayEnd, home);
    expect(detail).toBeNull();
  });

  test("counts sessions and messages from Cursor sqlite state", () => {
    const wsRoot = join(home, ".config", "Cursor", "User", "workspaceStorage", "hash-1");
    mkdirSync(wsRoot, { recursive: true });
    const dbPath = join(wsRoot, "state.vscdb");
    const db = new Database(dbPath);
    db.run("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)");
    db.run("INSERT INTO ItemTable (key, value) VALUES (?, ?)", [
      "sessionData.1",
      JSON.stringify({
        messages: [
          { timestamp: "2026-05-19T10:00:00Z", content: "hi" },
          { timestamp: "2026-05-19T10:05:00Z", content: "there" },
        ],
      }),
    ]);
    db.run("INSERT INTO ItemTable (key, value) VALUES (?, ?)", [
      "sessionData.2",
      JSON.stringify({
        messages: [{ timestamp: "2026-05-16T10:00:00Z", content: "old" }],
      }),
    ]);
    db.close();

    const dayStart = new Date("2026-05-19T00:00:00Z").getTime();
    const dayEnd = new Date("2026-05-20T00:00:00Z").getTime();
    const detail = cursorTranscript.collectDetail!(dayStart, dayEnd, home);
    expect(detail).toEqual({ sessionCount: 1, messageCount: 2 });
  });
});
