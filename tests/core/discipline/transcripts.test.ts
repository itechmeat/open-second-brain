/**
 * Per-runtime session-transcript resolvers (v0.10.11).
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { claudeCodeTranscript } from "../../../src/core/discipline/transcripts/claude-code.ts";
import { codexTranscript } from "../../../src/core/discipline/transcripts/codex.ts";
import { cursorTranscript } from "../../../src/core/discipline/transcripts/cursor.ts";
import { collectTranscriptActivity } from "../../../src/core/discipline/transcripts/index.ts";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "osb-transcripts-h-"));
});
afterEach(() => {
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {}
});

const DAY_START = new Date("2026-05-19T00:00:00Z").getTime();
const DAY_END = new Date("2026-05-20T00:00:00Z").getTime();
const IN_DAY = new Date("2026-05-19T12:00:00Z");
const OUT_OF_DAY = new Date("2026-05-17T12:00:00Z");

function writeWithMtime(path: string, contents: string, when: Date): void {
  writeFileSync(path, contents);
  utimesSync(path, when, when);
}

describe("claude-code transcript resolver", () => {
  test("returns nothing when ~/.claude/projects is missing", () => {
    expect(claudeCodeTranscript.collect(DAY_START, DAY_END, home)).toEqual([]);
  });

  test("returns sessions modified within the window", () => {
    const projDir = join(home, ".claude", "projects", "my-proj");
    mkdirSync(projDir, { recursive: true });
    writeWithMtime(join(projDir, "sess-a.jsonl"), "{}", IN_DAY);
    writeWithMtime(join(projDir, "sess-b.jsonl"), "{}", OUT_OF_DAY);
    const out = claudeCodeTranscript.collect(DAY_START, DAY_END, home);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("sess-a.jsonl");
  });

  test("non-jsonl files are ignored", () => {
    const projDir = join(home, ".claude", "projects", "p");
    mkdirSync(projDir, { recursive: true });
    writeWithMtime(join(projDir, "readme.md"), "ok", IN_DAY);
    expect(claudeCodeTranscript.collect(DAY_START, DAY_END, home)).toEqual([]);
  });
});

describe("codex transcript resolver", () => {
  test("returns nothing when ~/.codex is missing", () => {
    expect(codexTranscript.collect(DAY_START, DAY_END, home)).toEqual([]);
  });

  test("walks sessions/ subdir for .json files", () => {
    const dir = join(home, ".codex", "sessions");
    mkdirSync(dir, { recursive: true });
    writeWithMtime(join(dir, "a.json"), "{}", IN_DAY);
    writeWithMtime(join(dir, "b.json"), "{}", OUT_OF_DAY);
    const out = codexTranscript.collect(DAY_START, DAY_END, home);
    expect(out).toHaveLength(1);
  });

  test("walks nested subdirs", () => {
    const dir = join(home, ".codex", ".tmp", "marketplaces", "x");
    mkdirSync(dir, { recursive: true });
    writeWithMtime(join(dir, "trace.json"), "{}", IN_DAY);
    const out = codexTranscript.collect(DAY_START, DAY_END, home);
    expect(out).toHaveLength(1);
  });
});

describe("cursor transcript resolver", () => {
  test("returns nothing when no Cursor workspace storage exists", () => {
    expect(cursorTranscript.collect(DAY_START, DAY_END, home)).toEqual([]);
  });

  test("returns state.vscdb files modified within the window", () => {
    const dir = join(home, ".config", "Cursor", "User", "workspaceStorage", "abc123");
    mkdirSync(dir, { recursive: true });
    writeWithMtime(join(dir, "state.vscdb"), "binary", IN_DAY);
    const out = cursorTranscript.collect(DAY_START, DAY_END, home);
    expect(out).toHaveLength(1);
  });

  test("excludes state.vscdb modified outside the window", () => {
    const dir = join(home, ".config", "Cursor", "User", "workspaceStorage", "abc");
    mkdirSync(dir, { recursive: true });
    writeWithMtime(join(dir, "state.vscdb"), "binary", OUT_OF_DAY);
    expect(cursorTranscript.collect(DAY_START, DAY_END, home)).toEqual([]);
  });
});

describe("collectTranscriptActivity aggregator", () => {
  test("sums file counts across all registered runtimes", () => {
    // Claude
    const cdir = join(home, ".claude", "projects", "p");
    mkdirSync(cdir, { recursive: true });
    writeWithMtime(join(cdir, "s.jsonl"), "{}", IN_DAY);
    // Codex
    const xdir = join(home, ".codex", "sessions");
    mkdirSync(xdir, { recursive: true });
    writeWithMtime(join(xdir, "a.json"), "{}", IN_DAY);
    writeWithMtime(join(xdir, "b.json"), "{}", IN_DAY);
    // Cursor
    const wdir = join(home, ".config", "Cursor", "User", "workspaceStorage", "ws");
    mkdirSync(wdir, { recursive: true });
    writeWithMtime(join(wdir, "state.vscdb"), "x", IN_DAY);

    const out = collectTranscriptActivity({
      dayStartMs: DAY_START,
      dayEndMs: DAY_END,
      home,
    });
    expect(out.totalFiles).toBe(4);
    expect(out.byRuntime.map((b) => `${b.runtime}=${b.fileCount}`).toSorted()).toEqual([
      "claudecode=1",
      "codex=2",
      "cursor=1",
    ]);
  });

  test("totalFiles is zero when no runtime found anything", () => {
    const out = collectTranscriptActivity({
      dayStartMs: DAY_START,
      dayEndMs: DAY_END,
      home,
    });
    expect(out.totalFiles).toBe(0);
  });
});
