/**
 * Which emptiness a transcript scan found (U7 of "nothing runs unwatched").
 *
 * The resolvers used to answer with a bare `[]` for three unrelated
 * conditions: the runtime is not installed, its store is there but could not
 * be read, and the agent genuinely did nothing. That count feeds the
 * discipline alert, where the middle case - an unreadable home - was
 * indistinguishable from a confirmed quiet day.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { claudeCodeTranscript } from "../../../../src/core/discipline/transcripts/claude-code.ts";
import { codexTranscript } from "../../../../src/core/discipline/transcripts/codex.ts";
import { cursorTranscript } from "../../../../src/core/discipline/transcripts/cursor.ts";
import { collectTranscriptActivity } from "../../../../src/core/discipline/transcripts/index.ts";
import { TRANSCRIPT_SCAN } from "../../../../src/core/discipline/transcripts/types.ts";

const DAY_START = new Date("2026-05-19T00:00:00Z").getTime();
const DAY_END = new Date("2026-05-20T00:00:00Z").getTime();
const IN_DAY = new Date("2026-05-19T12:00:00Z");

/** Restored in afterEach so the temp tree can be removed. */
const lockedDirs: string[] = [];

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "osb-transcript-scan-"));
});

afterEach(() => {
  for (const dir of lockedDirs) {
    try {
      chmodSync(dir, 0o755);
    } catch {
      // already gone
    }
  }
  lockedDirs.length = 0;
  rmSync(home, { recursive: true, force: true });
});

function writeInDay(path: string): void {
  writeFileSync(path, "{}");
  utimesSync(path, IN_DAY, IN_DAY);
}

/** Make a directory exist but refuse enumeration. */
function makeUnreadable(dir: string): string {
  chmodSync(dir, 0o000);
  lockedDirs.push(dir);
  return dir;
}

describe("claude-code — the three emptinesses are three answers", () => {
  test("an absent store is root_absent, not an empty day", () => {
    const scan = claudeCodeTranscript.scan(DAY_START, DAY_END, home);
    expect(scan.state).toBe(TRANSCRIPT_SCAN.rootAbsent);
    expect(scan.files).toEqual([]);
    expect(scan.unreadable).toEqual([]);
  });

  test("a store that exists and cannot be read is unreadable, and names the path", () => {
    const base = join(home, ".claude", "projects");
    mkdirSync(base, { recursive: true });
    makeUnreadable(base);
    const scan = claudeCodeTranscript.scan(DAY_START, DAY_END, home);
    expect(scan.state).toBe(TRANSCRIPT_SCAN.unreadable);
    expect(scan.unreadable).toContain(base);
  });

  test("a readable store with nothing in the window is idle", () => {
    mkdirSync(join(home, ".claude", "projects", "proj"), { recursive: true });
    const scan = claudeCodeTranscript.scan(DAY_START, DAY_END, home);
    expect(scan.state).toBe(TRANSCRIPT_SCAN.idle);
    expect(scan.files).toEqual([]);
    expect(scan.unreadable).toEqual([]);
  });

  test("files in the window are collected", () => {
    const proj = join(home, ".claude", "projects", "proj");
    mkdirSync(proj, { recursive: true });
    writeInDay(join(proj, "s.jsonl"));
    const scan = claudeCodeTranscript.scan(DAY_START, DAY_END, home);
    expect(scan.state).toBe(TRANSCRIPT_SCAN.collected);
    expect(scan.files).toHaveLength(1);
  });

  test("a partial read reports the files it found AND the directory it could not", () => {
    const good = join(home, ".claude", "projects", "good");
    const bad = join(home, ".claude", "projects", "bad");
    mkdirSync(good, { recursive: true });
    mkdirSync(bad, { recursive: true });
    writeInDay(join(good, "s.jsonl"));
    makeUnreadable(bad);
    const scan = claudeCodeTranscript.scan(DAY_START, DAY_END, home);
    expect(scan.state).toBe(TRANSCRIPT_SCAN.collected);
    expect(scan.files).toHaveLength(1);
    expect(scan.unreadable).toContain(bad);
  });
});

describe("codex and cursor answer the same three ways", () => {
  test("codex: absent store, unreadable store, idle store", () => {
    expect(codexTranscript.scan(DAY_START, DAY_END, home).state).toBe(TRANSCRIPT_SCAN.rootAbsent);

    const sessions = join(home, ".codex", "sessions");
    mkdirSync(sessions, { recursive: true });
    expect(codexTranscript.scan(DAY_START, DAY_END, home).state).toBe(TRANSCRIPT_SCAN.idle);

    makeUnreadable(sessions);
    const scan = codexTranscript.scan(DAY_START, DAY_END, home);
    expect(scan.state).toBe(TRANSCRIPT_SCAN.unreadable);
    expect(scan.unreadable).toContain(sessions);
  });

  test("cursor: absent store, unreadable store, idle store", () => {
    expect(cursorTranscript.scan(DAY_START, DAY_END, home).state).toBe(TRANSCRIPT_SCAN.rootAbsent);

    const root = join(home, ".config", "Cursor", "User", "workspaceStorage");
    mkdirSync(join(root, "ws"), { recursive: true });
    expect(cursorTranscript.scan(DAY_START, DAY_END, home).state).toBe(TRANSCRIPT_SCAN.idle);

    makeUnreadable(root);
    const scan = cursorTranscript.scan(DAY_START, DAY_END, home);
    expect(scan.state).toBe(TRANSCRIPT_SCAN.unreadable);
    expect(scan.unreadable).toContain(root);
  });
});

describe("the aggregator carries the reason, not just the count", () => {
  test("an unreadable runtime is not reported as a quiet one", () => {
    const base = join(home, ".claude", "projects");
    mkdirSync(base, { recursive: true });
    makeUnreadable(base);

    const activity = collectTranscriptActivity({
      dayStartMs: DAY_START,
      dayEndMs: DAY_END,
      home,
    });
    expect(activity.totalFiles).toBe(0);
    const claude = activity.byRuntime.find((r) => r.runtime === "claudecode");
    expect(claude?.scan).toBe(TRANSCRIPT_SCAN.unreadable);
    expect(activity.unreadableRuntimes).toContain("claudecode");
    // The runtimes that are simply not installed say so instead.
    const codex = activity.byRuntime.find((r) => r.runtime === "codex");
    expect(codex?.scan).toBe(TRANSCRIPT_SCAN.rootAbsent);
  });

  test("every runtime absent is zero files with nothing unreadable", () => {
    const activity = collectTranscriptActivity({
      dayStartMs: DAY_START,
      dayEndMs: DAY_END,
      home,
    });
    expect(activity.totalFiles).toBe(0);
    expect(activity.unreadableRuntimes).toEqual([]);
    expect(activity.byRuntime.every((r) => r.scan === TRANSCRIPT_SCAN.rootAbsent)).toBe(true);
  });
});
