/**
 * Sharded Brain log writer (Memory Integrity Suite, t_6d52641f).
 *
 * `appendLogEvent` writes `Brain/log/<date>.<deviceId>.jsonl` + `.md`
 * so two devices never touch the same file on the same day. The
 * device id comes from the device-local config; tests inject it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";
import { appendLogEvent } from "../../../src/core/brain/log.ts";
import { readLogDay } from "../../../src/core/brain/log-jsonl.ts";
import { brainDirs } from "../../../src/core/brain/paths.ts";

let vault: string;
let configHome: string;
let configPath: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-shard-write-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-shard-write-cfg-"));
  configPath = join(configHome, "config.yaml");
  savedEnv["OPEN_SECOND_BRAIN_CONFIG"] = process.env["OPEN_SECOND_BRAIN_CONFIG"];
  savedEnv["O2B_DEVICE_ID"] = process.env["O2B_DEVICE_ID"];
  process.env["OPEN_SECOND_BRAIN_CONFIG"] = configPath;
  delete process.env["O2B_DEVICE_ID"];
  atomicWriteFileSync(configPath, `vault: ${vault}\ndevice_id: "testdev1"\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
  for (const k of ["OPEN_SECOND_BRAIN_CONFIG", "O2B_DEVICE_ID"]) {
    const v = savedEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function note(ts: string, text: string) {
  return {
    timestamp: ts,
    eventType: "note",
    body: { text, agent: "test" },
  } as const;
}

describe("appendLogEvent shard writing", () => {
  test("writes the device shard pair, not the legacy files", () => {
    appendLogEvent(vault, note("2026-06-01T10:00:00Z", "row"));
    const dir = brainDirs(vault).log;
    expect(existsSync(join(dir, "2026-06-01.testdev1.jsonl"))).toBe(true);
    expect(existsSync(join(dir, "2026-06-01.testdev1.md"))).toBe(true);
    expect(existsSync(join(dir, "2026-06-01.jsonl"))).toBe(false);
    expect(existsSync(join(dir, "2026-06-01.md"))).toBe(false);
  });

  test("an explicit deviceId option overrides config resolution", () => {
    appendLogEvent(vault, note("2026-06-01T10:00:00Z", "row"), { deviceId: "otherdev" });
    const dir = brainDirs(vault).log;
    expect(existsSync(join(dir, "2026-06-01.otherdev.jsonl"))).toBe(true);
    expect(existsSync(join(dir, "2026-06-01.testdev1.jsonl"))).toBe(false);
  });

  test("two appends land in one shard in order and read back merged", () => {
    appendLogEvent(vault, note("2026-06-01T10:00:00Z", "one"));
    appendLogEvent(vault, note("2026-06-01T10:00:01Z", "two"));
    const dir = brainDirs(vault).log;
    const jsonl = readFileSync(join(dir, "2026-06-01.testdev1.jsonl"), "utf8");
    expect(jsonl.trim().split("\n")).toHaveLength(2);
    const out = readLogDay(vault, "2026-06-01");
    expect(out.entries.map((e) => e.body["text"])).toEqual(["one", "two"]);
  });

  test("new shard writes merge with a pre-existing legacy file on read", () => {
    // Legacy single-file day written before the shard layout shipped.
    const dir = brainDirs(vault).log;
    appendLogEvent(vault, note("2026-06-01T10:00:00Z", "legacy"), { deviceId: "" });
    expect(existsSync(join(dir, "2026-06-01.jsonl"))).toBe(true);
    appendLogEvent(vault, note("2026-06-01T10:00:01Z", "sharded"));
    const out = readLogDay(vault, "2026-06-01");
    expect(out.entries.map((e) => e.body["text"])).toEqual(["legacy", "sharded"]);
  });

  test("markdown shard carries the canonical header and the event block", () => {
    appendLogEvent(vault, note("2026-06-01T10:00:00Z", "row"));
    const md = readFileSync(join(brainDirs(vault).log, "2026-06-01.testdev1.md"), "utf8");
    expect(md).toContain("kind: brain-log");
    expect(md).toContain("## 10:00:00Z");
    expect(md).toContain("row");
  });

  test("rejects an invalid explicit deviceId", () => {
    expect(() =>
      appendLogEvent(vault, note("2026-06-01T10:00:00Z", "row"), { deviceId: "BAD/ID" }),
    ).toThrow(/device/i);
  });
});
