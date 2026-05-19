import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendLogEvent,
  parseLogDay,
  type BrainLogEntry,
} from "../../src/core/brain/log.ts";
import { brainDirs, logJsonlPath, logPath } from "../../src/core/brain/paths.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-brain-log-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("appendLogEvent — create-on-first-event", () => {
  test("creates the file with a canonical header and the first event", () => {
    const event: BrainLogEntry = {
      timestamp: "2026-05-14T10:42:00Z",
      eventType: "dream",
      body: {
        run_id: "dream-2026-05-14-104200",
        input_signals: "7",
        new_unconfirmed: ["[[pref-no-internal-abbrev]] (signal_balance: -3)"],
        confirmed: "0",
        retired: "0",
      },
    };
    const res = appendLogEvent(tmp, event);
    expect(res.logPath).toBe(logPath(tmp, "2026-05-14"));
    expect(existsSync(res.logPath)).toBe(true);
    const bytes = readFileSync(res.logPath, "utf8");
    expect(bytes).toContain("---\nkind: brain-log\ndate: 2026-05-14");
    expect(bytes).toContain("tags: [brain, brain/log]");
    expect(bytes).toContain("# Brain log — 2026-05-14");
    expect(bytes).toContain("## 10:42:00Z — dream");
    expect(bytes).toContain("- run_id: dream-2026-05-14-104200");
    expect(bytes).toContain("- new_unconfirmed:");
    expect(bytes).toContain("  - [[pref-no-internal-abbrev]] (signal_balance: -3)");
  });

  test("parseLogDay returns the single event", () => {
    appendLogEvent(tmp, {
      timestamp: "2026-05-14T10:42:00Z",
      eventType: "dream",
      body: { run_id: "dream-2026-05-14-104200", confirmed: "0" },
    });
    const { entries, warnings } = parseLogDay(tmp, "2026-05-14");
    expect(warnings).toEqual([]);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.eventType).toBe("dream");
    expect(entries[0]!.timestamp).toBe("2026-05-14T10:42:00Z");
    expect(entries[0]!.body["run_id"]).toBe("dream-2026-05-14-104200");
  });

  test("parseLogDay returns [] for a missing file (no Brain log for that day)", () => {
    const { entries, warnings } = parseLogDay(tmp, "2099-01-01");
    expect(entries).toEqual([]);
    expect(warnings).toEqual([]);
  });
});

describe("appendLogEvent — multi-event same day", () => {
  test("two appends produce two parseable events in stable order", () => {
    appendLogEvent(tmp, {
      timestamp: "2026-05-14T10:42:00Z",
      eventType: "dream",
      body: { run_id: "dream-2026-05-14-104200" },
    });
    appendLogEvent(tmp, {
      timestamp: "2026-05-14T14:22:00Z",
      eventType: "apply-evidence",
      body: {
        preference: "[[pref-no-internal-abbrev]]",
        artifact: "[[Daily/2026.05.14#section-blog-post]]",
        agent: "claude",
        result: "applied",
        note: "Expanded OSB on first use.",
      },
    });
    const { entries, warnings } = parseLogDay(tmp, "2026-05-14");
    expect(warnings).toEqual([]);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.eventType).toBe("dream");
    expect(entries[1]!.eventType).toBe("apply-evidence");
    expect(entries[1]!.body["result"]).toBe("applied");
    expect(entries[1]!.body["preference"]).toBe("[[pref-no-internal-abbrev]]");
  });

  test("two events at the exact same UTC second land in order of call", () => {
    appendLogEvent(tmp, {
      timestamp: "2026-05-14T10:42:00Z",
      eventType: "feedback",
      body: { signal: "[[sig-a]]" },
    });
    appendLogEvent(tmp, {
      timestamp: "2026-05-14T10:42:00Z",
      eventType: "feedback",
      body: { signal: "[[sig-b]]" },
    });
    const { entries } = parseLogDay(tmp, "2026-05-14");
    expect(entries).toHaveLength(2);
    expect(entries[0]!.body["signal"]).toBe("[[sig-a]]");
    expect(entries[1]!.body["signal"]).toBe("[[sig-b]]");
  });

  test("the original file bytes are preserved verbatim across appends (append-only)", () => {
    const a = appendLogEvent(tmp, {
      timestamp: "2026-05-14T10:42:00Z",
      eventType: "dream",
      body: { run_id: "dream-2026-05-14-104200" },
    });
    const firstBytes = readFileSync(a.logPath, "utf8");
    appendLogEvent(tmp, {
      timestamp: "2026-05-14T14:22:00Z",
      eventType: "apply-evidence",
      body: {
        preference: "[[pref-foo]]",
        artifact: "[[bar]]",
        agent: "claude",
        result: "applied",
      },
    });
    const secondBytes = readFileSync(a.logPath, "utf8");
    // The second file must start with the first file's full content
    // (trailing whitespace tolerated) — i.e. nothing earlier was edited.
    const stripTrailing = (s: string): string => s.replace(/\s+$/, "");
    expect(secondBytes.startsWith(stripTrailing(firstBytes))).toBe(true);
    expect(secondBytes.length).toBeGreaterThan(firstBytes.length);
  });
});

describe("parseLogDay — malformed entry tolerance", () => {
  test("returns only the valid entries and reports warnings for the rest", () => {
    const dirs = brainDirs(tmp);
    mkdirSync(dirs.log, { recursive: true });
    const path = logPath(tmp, "2026-05-14");
    const content = [
      "---",
      "kind: brain-log",
      "date: 2026-05-14",
      "tags: [brain, brain/log]",
      "---",
      "",
      "# Brain log — 2026-05-14",
      "",
      "## 10:42:00Z — dream",
      "- run_id: dream-2026-05-14-104200",
      "- confirmed: 0",
      "",
      "## 11:00:00 NOT-A-VALID-HEADER",  // broken header
      "- this: should be ignored",
      "",
      "## 12:00:00Z — apply-evidence",
      "- preference: [[pref-foo]]",
      "- artifact: [[bar]]",
      "- agent: claude",
      "- result: applied",
      "",
      "## 13:00:00Z — totally-bogus-kind",  // unknown event kind
      "- foo: bar",
      "",
      "## 14:00:00Z — feedback",
      "- signal: [[sig-x]]",
      "garbage line that is not a bullet",  // malformed bullet inside a valid block
      "- topic: foo",
    ].join("\n");
    writeFileSync(path, content, "utf8");

    const { entries, warnings } = parseLogDay(tmp, "2026-05-14");
    // Only the three well-formed entries (dream, apply-evidence,
    // feedback) survive.
    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.eventType)).toEqual([
      "dream",
      "apply-evidence",
      "feedback",
    ]);
    // The broken header and bogus kind both produce warnings; the
    // stray bullet does too.
    expect(warnings.length).toBeGreaterThanOrEqual(2);
    const messages = warnings.map((w) => w.message).join("\n");
    expect(messages).toMatch(/malformed event header|unknown event kind/);
  });
});

describe("ISO timestamp round-trip", () => {
  test("appended timestamp parses back verbatim", () => {
    const ts = "2026-05-14T07:08:09Z";
    appendLogEvent(tmp, {
      timestamp: ts,
      eventType: "promote",
      body: { preference: "[[pref-foo]]" },
    });
    const { entries } = parseLogDay(tmp, "2026-05-14");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.timestamp).toBe(ts);
  });

  test("sub-second precision is truncated to seconds in the heading", () => {
    appendLogEvent(tmp, {
      timestamp: "2026-05-14T07:08:09.123Z",
      eventType: "promote",
      body: { preference: "[[pref-foo]]" },
    });
    const { entries } = parseLogDay(tmp, "2026-05-14");
    expect(entries).toHaveLength(1);
    // The serialised form drops sub-seconds; the parser reconstructs
    // a clean `HH:MM:SSZ`.
    expect(entries[0]!.timestamp).toBe("2026-05-14T07:08:09Z");
  });

  test("invalid timestamp shape is rejected at append time", () => {
    expect(() =>
      appendLogEvent(tmp, {
        timestamp: "2026-05-14 10:42:00",
        eventType: "promote",
        body: {},
      }),
    ).toThrow(/ISO-8601 UTC/);
  });

  test("unknown event kind is rejected at append time", () => {
    expect(() =>
      appendLogEvent(tmp, {
        timestamp: "2026-05-14T10:42:00Z",
        eventType: "totally-bogus" as unknown as "dream",
        body: {},
      }),
    ).toThrow(/unknown event kind/);
  });
});

describe("appendLogEvent — JSONL sidecar (§23, v0.10.8)", () => {
  test("writes the same event to both .md and .jsonl", () => {
    const entry: BrainLogEntry = {
      timestamp: "2026-05-19T10:00:00Z",
      eventType: "feedback",
      body: { signal: "[[sig-x]]", topic: "x", sign: "positive" },
    };
    const res = appendLogEvent(tmp, entry);
    const jsonlPath = logJsonlPath(tmp, "2026-05-19");

    expect(existsSync(res.logPath)).toBe(true);
    expect(existsSync(jsonlPath)).toBe(true);

    const jsonl = readFileSync(jsonlPath, "utf8");
    const lines = jsonl.trim().split("\n");
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed).toEqual({
      ts: "2026-05-19T10:00:00Z",
      kind: "feedback",
      payload: { signal: "[[sig-x]]", topic: "x", sign: "positive" },
    });
  });

  test("appends a second event to both files", () => {
    appendLogEvent(tmp, {
      timestamp: "2026-05-19T10:00:00Z",
      eventType: "feedback",
      body: { signal: "[[sig-a]]", topic: "a", sign: "positive" },
    });
    appendLogEvent(tmp, {
      timestamp: "2026-05-19T10:00:01Z",
      eventType: "apply-evidence",
      body: {
        preference: "[[pref-a]]",
        artifact: "[[file.ts]]",
        agent: "@x",
        result: "applied",
      },
    });
    const jsonlPath = logJsonlPath(tmp, "2026-05-19");
    const jsonl = readFileSync(jsonlPath, "utf8");
    const lines = jsonl.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).kind).toBe("feedback");
    expect(JSON.parse(lines[1]!).kind).toBe("apply-evidence");
  });

  test("encodes array payloads as JSON arrays", () => {
    appendLogEvent(tmp, {
      timestamp: "2026-05-19T10:00:00Z",
      eventType: "dream",
      body: {
        run_id: "dream-1",
        new_unconfirmed: ["[[pref-a]]", "[[pref-b]]"],
      },
    });
    const jsonlPath = logJsonlPath(tmp, "2026-05-19");
    const jsonl = readFileSync(jsonlPath, "utf8");
    const parsed = JSON.parse(jsonl.trim());
    expect(parsed.payload.new_unconfirmed).toEqual(["[[pref-a]]", "[[pref-b]]"]);
    expect(parsed.payload.run_id).toBe("dream-1");
  });

  test("creates the JSONL sidecar even when the .md already exists by hand", () => {
    // Simulate a pre-v0.10.8 day: markdown present, sidecar absent.
    const mdPath = logPath(tmp, "2026-05-10");
    mkdirSync(brainDirs(tmp).log, { recursive: true });
    writeFileSync(
      mdPath,
      `---
kind: brain-log
date: 2026-05-10
tags: [brain, brain/log]
---

# Brain log — 2026-05-10

## 09:00:00Z — feedback
- signal: [[sig-old]]
- topic: old
- sign: positive
`,
      "utf8",
    );

    appendLogEvent(tmp, {
      timestamp: "2026-05-10T10:00:00Z",
      eventType: "feedback",
      body: { signal: "[[sig-new]]", topic: "new", sign: "positive" },
    });

    const jsonlPath = logJsonlPath(tmp, "2026-05-10");
    expect(existsSync(jsonlPath)).toBe(true);
    const lines = readFileSync(jsonlPath, "utf8").trim().split("\n");
    // Only the new event lands in JSONL — backfill of the pre-existing
    // markdown block is intentionally out of scope (lazy fallback in
    // readLogDay handles historical markdown).
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).payload.topic).toBe("new");
  });
});
