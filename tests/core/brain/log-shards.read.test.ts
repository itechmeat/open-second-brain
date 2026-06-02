/**
 * Shard-merging log readers (Memory Integrity Suite, t_6d52641f).
 *
 * `Brain/log/<date>.<deviceId>.jsonl` (+ `.md`) shards join the legacy
 * `<date>.jsonl` / `<date>.md` pair as equal sources of one day's
 * events. `readLogDay` merges every shard sorted by (ts, shardId, line)
 * and `listLogDates` is the single date-discovery helper every
 * directory-scanning reader routes through.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";
import { appendLogEvent } from "../../../src/core/brain/log.ts";
import { listLogDates, readLogDay } from "../../../src/core/brain/log-jsonl.ts";
import { brainDirs } from "../../../src/core/brain/paths.ts";
import { runDoctor } from "../../../src/core/brain/doctor.ts";

let vault: string;
let configHome: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-log-shards-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-log-shards-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

function logDir(): string {
  return brainDirs(vault).log;
}

function jsonlRow(ts: string, text: string): string {
  return JSON.stringify({ ts, kind: "note", payload: { text, agent: "test" } });
}

function writeShard(name: string, rows: string[]): void {
  mkdirSync(logDir(), { recursive: true });
  writeFileSync(join(logDir(), name), rows.join("\n") + "\n");
}

describe("readLogDay shard merge", () => {
  test("legacy-only day reads exactly as before", () => {
    appendLogEvent(vault, {
      timestamp: "2026-06-01T10:00:00Z",
      eventType: "note",
      body: { text: "legacy row", agent: "test" },
    });
    const out = readLogDay(vault, "2026-06-01");
    expect(out.entries).toHaveLength(1);
    expect(out.entries[0]!.body["text"]).toBe("legacy row");
    expect(out.source).toBe("jsonl");
  });

  test("merges legacy file and device shards sorted by timestamp", () => {
    writeShard("2026-06-01.jsonl", [jsonlRow("2026-06-01T10:00:02Z", "legacy")]);
    writeShard("2026-06-01.mac1234.jsonl", [
      jsonlRow("2026-06-01T10:00:01Z", "mac-early"),
      jsonlRow("2026-06-01T10:00:03Z", "mac-late"),
    ]);
    writeShard("2026-06-01.vps5678.jsonl", [jsonlRow("2026-06-01T10:00:02Z", "vps")]);
    const out = readLogDay(vault, "2026-06-01");
    expect(out.entries.map((e) => e.body["text"])).toEqual([
      "mac-early",
      "legacy", // ts tie with vps: legacy shard ("") sorts before "vps5678"
      "vps",
      "mac-late",
    ]);
  });

  test("same-timestamp rows within one shard keep line order", () => {
    writeShard("2026-06-01.mac1234.jsonl", [
      jsonlRow("2026-06-01T10:00:00Z", "first"),
      jsonlRow("2026-06-01T10:00:00Z", "second"),
    ]);
    const out = readLogDay(vault, "2026-06-01");
    expect(out.entries.map((e) => e.body["text"])).toEqual(["first", "second"]);
  });

  test("a malformed shard row surfaces as a warning without dropping other shards", () => {
    writeShard("2026-06-01.mac1234.jsonl", ["{not json"]);
    writeShard("2026-06-01.vps5678.jsonl", [jsonlRow("2026-06-01T10:00:00Z", "good")]);
    const out = readLogDay(vault, "2026-06-01");
    expect(out.entries).toHaveLength(1);
    expect(out.warnings.length).toBeGreaterThanOrEqual(1);
  });

  test("markdown-only shards fall back to markdown parsing", () => {
    // No JSONL at all; one legacy md + one shard md.
    mkdirSync(logDir(), { recursive: true });
    writeFileSync(
      join(logDir(), "2026-06-01.md"),
      "---\nkind: brain-log\ndate: 2026-06-01\ntags: [brain, brain/log]\n---\n\n# Brain log — 2026-06-01\n\n## 10:00:02Z — note\n\n- text: legacy md\n- agent: test\n",
    );
    writeFileSync(
      join(logDir(), "2026-06-01.mac1234.md"),
      "---\nkind: brain-log\ndate: 2026-06-01\ntags: [brain, brain/log]\n---\n\n# Brain log — 2026-06-01\n\n## 10:00:01Z — note\n\n- text: shard md\n- agent: test\n",
    );
    const out = readLogDay(vault, "2026-06-01");
    expect(out.source).toBe("markdown-fallback");
    expect(out.entries.map((e) => e.body["text"])).toEqual(["shard md", "legacy md"]);
  });
});

describe("listLogDates", () => {
  test("collects unique dates across legacy and shard file names", () => {
    writeShard("2026-06-01.jsonl", [jsonlRow("2026-06-01T10:00:00Z", "a")]);
    writeShard("2026-06-01.mac1234.jsonl", [jsonlRow("2026-06-01T10:00:01Z", "b")]);
    writeShard("2026-06-02.vps5678.jsonl", [jsonlRow("2026-06-02T10:00:00Z", "c")]);
    mkdirSync(logDir(), { recursive: true });
    writeFileSync(join(logDir(), "2026-06-03.md"), "---\nkind: brain-log\n---\n");
    writeFileSync(join(logDir(), "not-a-date.md"), "junk");
    writeFileSync(join(logDir(), "2026-06-04.sync-conflict-x.jsonl"), "junk");
    expect(listLogDates(vault)).toEqual(["2026-06-01", "2026-06-02", "2026-06-03"]);
  });

  test("empty or absent log dir lists nothing", () => {
    expect(listLogDates(vault)).toEqual([]);
  });
});

describe("doctor sync-conflict lint", () => {
  test("flags .sync-conflict-* files under Brain/log", () => {
    mkdirSync(logDir(), { recursive: true });
    writeFileSync(join(logDir(), "2026-06-01.sync-conflict-20260601-120000-ABCDEF.jsonl"), "{}");
    const issues = runDoctor(vault).warnings.filter((i) => i.code === "sync-conflict-log");
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain("sync-conflict");
  });
});
