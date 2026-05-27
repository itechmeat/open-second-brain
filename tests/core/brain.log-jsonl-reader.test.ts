import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendLogEvent } from "../../src/core/brain/log.ts";
import { readLogDay } from "../../src/core/brain/log-jsonl.ts";
import { brainDirs, logJsonlPath, logPath } from "../../src/core/brain/paths.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-brain-log-jsonl-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("readLogDay — JSONL-preferred", () => {
  test("returns entries from JSONL when sidecar exists", () => {
    appendLogEvent(tmp, {
      timestamp: "2026-05-19T10:00:00Z",
      eventType: "feedback",
      body: { signal: "[[sig-x]]", topic: "x", sign: "positive" },
    });
    const res = readLogDay(tmp, "2026-05-19");
    expect(res.source).toBe("jsonl");
    expect(res.entries).toHaveLength(1);
    expect(res.entries[0]!.eventType).toBe("feedback");
    expect(res.entries[0]!.body["topic"]).toBe("x");
  });

  test("falls back to markdown when only markdown exists", () => {
    const dir = brainDirs(tmp).log;
    mkdirSync(dir, { recursive: true });
    const md = `---
kind: brain-log
date: 2026-05-10
tags: [brain, brain/log]
---

# Brain log — 2026-05-10

## 09:00:00Z — feedback
- signal: [[sig-old]]
- topic: old
- sign: positive
`;
    writeFileSync(logPath(tmp, "2026-05-10"), md, "utf8");

    const res = readLogDay(tmp, "2026-05-10");
    expect(res.source).toBe("markdown-fallback");
    expect(res.entries).toHaveLength(1);
    expect(res.entries[0]!.body["topic"]).toBe("old");
  });

  test("returns empty result when neither file exists", () => {
    const res = readLogDay(tmp, "2026-01-01");
    expect(res.entries).toHaveLength(0);
    expect(res.warnings).toHaveLength(0);
  });

  test("prefers JSONL even when markdown is also present", () => {
    appendLogEvent(tmp, {
      timestamp: "2026-05-19T10:00:00Z",
      eventType: "feedback",
      body: { signal: "[[sig-x]]", topic: "from-jsonl", sign: "positive" },
    });
    // Hand-edit markdown to a different topic — readLogDay must trust
    // the JSONL sidecar.
    const md = `---
kind: brain-log
date: 2026-05-19
tags: [brain, brain/log]
---

# Brain log — 2026-05-19

## 10:00:00Z — feedback
- signal: [[sig-x]]
- topic: from-md-handedit
- sign: positive
`;
    writeFileSync(logPath(tmp, "2026-05-19"), md, "utf8");

    const res = readLogDay(tmp, "2026-05-19");
    expect(res.source).toBe("jsonl");
    expect(res.entries[0]!.body["topic"]).toBe("from-jsonl");
  });

  test("surfaces malformed JSONL lines as warnings, keeps the rest", () => {
    const dir = brainDirs(tmp).log;
    mkdirSync(dir, { recursive: true });
    const lines = [
      JSON.stringify({
        ts: "2026-05-19T10:00:00Z",
        kind: "feedback",
        payload: { topic: "ok" },
      }),
      "not-valid-json",
      JSON.stringify({
        ts: "2026-05-19T10:00:02Z",
        kind: "feedback",
        payload: { topic: "also-ok" },
      }),
    ].join("\n");
    writeFileSync(logJsonlPath(tmp, "2026-05-19"), lines + "\n", "utf8");

    const res = readLogDay(tmp, "2026-05-19");
    expect(res.source).toBe("jsonl");
    expect(res.entries).toHaveLength(2);
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]!.message).toMatch(/malformed/i);
    expect(res.warnings[0]!.lineNumber).toBe(2);
  });

  test("skips rows with malformed ts and surfaces a warning", () => {
    const dir = brainDirs(tmp).log;
    mkdirSync(dir, { recursive: true });
    const lines = [
      JSON.stringify({
        ts: "2026-05-19 10:00:00",
        kind: "feedback",
        payload: { topic: "bad-ts" },
      }),
      JSON.stringify({
        ts: "2026-05-19T10:00:01Z",
        kind: "feedback",
        payload: { topic: "ok" },
      }),
    ].join("\n");
    writeFileSync(logJsonlPath(tmp, "2026-05-19"), lines + "\n", "utf8");

    const res = readLogDay(tmp, "2026-05-19");
    expect(res.entries).toHaveLength(1);
    expect(res.entries[0]!.body["topic"]).toBe("ok");
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]!.message).toMatch(/invalid ts format/i);
  });

  test("skips rows with unknown event kinds and surfaces a warning", () => {
    const dir = brainDirs(tmp).log;
    mkdirSync(dir, { recursive: true });
    const lines = [
      JSON.stringify({
        ts: "2026-05-19T10:00:00Z",
        kind: "totally-bogus",
        payload: {},
      }),
      JSON.stringify({
        ts: "2026-05-19T10:00:01Z",
        kind: "feedback",
        payload: { topic: "ok" },
      }),
    ].join("\n");
    writeFileSync(logJsonlPath(tmp, "2026-05-19"), lines + "\n", "utf8");

    const res = readLogDay(tmp, "2026-05-19");
    expect(res.entries).toHaveLength(1);
    expect(res.entries[0]!.eventType).toBe("feedback");
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]!.message).toMatch(/unknown event kind/i);
  });

  test("ignores blank lines in JSONL", () => {
    const dir = brainDirs(tmp).log;
    mkdirSync(dir, { recursive: true });
    const lines = [
      "",
      JSON.stringify({
        ts: "2026-05-19T10:00:00Z",
        kind: "feedback",
        payload: { topic: "x" },
      }),
      "",
      "",
    ].join("\n");
    writeFileSync(logJsonlPath(tmp, "2026-05-19"), lines, "utf8");

    const res = readLogDay(tmp, "2026-05-19");
    expect(res.entries).toHaveLength(1);
    expect(res.warnings).toHaveLength(0);
  });
});

describe("readLogDay — invariants", () => {
  test("validates the date format (rejects loose input)", () => {
    expect(() => readLogDay(tmp, "2026/05/19")).toThrow();
  });

  test("does not create files on a read", () => {
    readLogDay(tmp, "2026-05-19");
    expect(existsSync(logPath(tmp, "2026-05-19"))).toBe(false);
    expect(existsSync(logJsonlPath(tmp, "2026-05-19"))).toBe(false);
  });
});
