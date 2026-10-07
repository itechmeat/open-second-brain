import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  REGROUND_PART_CHARS_DEFAULT,
  resolveRecallInjectCaps,
  resolveRecallInjectDedupe,
  resolveRegroundPartChars,
  resolveRegroundPartsEnabled,
} from "../../src/core/config.ts";

/** Env keys these tests own outright, whatever the outer shell set. */
const OWNED_ENV = [
  "OPEN_SECOND_BRAIN_RECALL_INJECT_MAX_NOTES",
  "OPEN_SECOND_BRAIN_RECALL_INJECT_MAX_CHARS",
  "OPEN_SECOND_BRAIN_RECALL_INJECT_TIME_BUDGET_MS",
  "OPEN_SECOND_BRAIN_RECALL_INJECT_CONFIDENCE_FLOOR",
  "OPEN_SECOND_BRAIN_RECALL_INJECT_DEDUPE",
  "OPEN_SECOND_BRAIN_REGROUND_PARTS_ENABLED",
  "OPEN_SECOND_BRAIN_REGROUND_PART_CHARS",
  "OPEN_SECOND_BRAIN_REGROUND_PART_CHARS_CLAUDECODE",
  "OPEN_SECOND_BRAIN_REGROUND_PART_CHARS_CODEX",
] as const;

let tmp: string;
let configPath: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-config-recall-"));
  configPath = join(tmp, "config.yaml");
  for (const key of OWNED_ENV) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of OWNED_ENV) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  rmSync(tmp, { recursive: true, force: true });
});

function writeConfig(entries: Record<string, string>): void {
  const body = Object.entries(entries)
    .map(([k, v]) => `${k}: "${v}"`)
    .join("\n");
  writeFileSync(configPath, body + "\n");
}

describe("resolveRecallInjectCaps", () => {
  test("unset keys produce empty caps and empty invalid", () => {
    expect(resolveRecallInjectCaps(configPath)).toEqual({ caps: {}, invalid: [] });
  });

  test("every key resolves from config", () => {
    writeConfig({
      recall_inject_max_notes: "4",
      recall_inject_max_chars: "1500",
      recall_inject_time_budget_ms: "800",
      recall_inject_confidence_floor: "0.35",
    });
    expect(resolveRecallInjectCaps(configPath)).toEqual({
      caps: { maxNotes: 4, maxChars: 1500, timeBudgetMs: 800, confidenceFloor: 0.35 },
      invalid: [],
    });
  });

  test("every key resolves from env, and env wins over config", () => {
    writeConfig({
      recall_inject_max_notes: "4",
      recall_inject_max_chars: "1500",
      recall_inject_time_budget_ms: "800",
      recall_inject_confidence_floor: "0.35",
    });
    process.env["OPEN_SECOND_BRAIN_RECALL_INJECT_MAX_NOTES"] = "7";
    process.env["OPEN_SECOND_BRAIN_RECALL_INJECT_MAX_CHARS"] = "200";
    process.env["OPEN_SECOND_BRAIN_RECALL_INJECT_TIME_BUDGET_MS"] = "6000";
    process.env["OPEN_SECOND_BRAIN_RECALL_INJECT_CONFIDENCE_FLOOR"] = "1";
    expect(resolveRecallInjectCaps(configPath)).toEqual({
      caps: { maxNotes: 7, maxChars: 200, timeBudgetMs: 6000, confidenceFloor: 1 },
      invalid: [],
    });
  });

  test("range edges are inclusive", () => {
    writeConfig({
      recall_inject_max_notes: "1",
      recall_inject_max_chars: "8000",
      recall_inject_time_budget_ms: "250",
      recall_inject_confidence_floor: "0",
    });
    expect(resolveRecallInjectCaps(configPath).caps).toEqual({
      maxNotes: 1,
      maxChars: 8000,
      timeBudgetMs: 250,
      confidenceFloor: 0,
    });
  });

  test("out-of-range, non-numeric and non-integer values land in invalid", () => {
    writeConfig({
      recall_inject_max_notes: "11",
      recall_inject_max_chars: "lots",
      recall_inject_time_budget_ms: "300.5",
      recall_inject_confidence_floor: "1.2",
    });
    const res = resolveRecallInjectCaps(configPath);
    expect(res.caps).toEqual({});
    expect([...res.invalid]).toEqual([
      "recall_inject_max_notes",
      "recall_inject_max_chars",
      "recall_inject_time_budget_ms",
      "recall_inject_confidence_floor",
    ]);
  });

  test("one past the upper edge lands in invalid", () => {
    writeConfig({ recall_inject_max_chars: "8001", recall_inject_time_budget_ms: "6001" });
    expect(resolveRecallInjectCaps(configPath)).toEqual({
      caps: {},
      invalid: ["recall_inject_max_chars", "recall_inject_time_budget_ms"],
    });
  });

  test("an invalid env value is rejected even when config holds a valid one, and named by its env variable", () => {
    writeConfig({ recall_inject_max_notes: "3" });
    process.env["OPEN_SECOND_BRAIN_RECALL_INJECT_MAX_NOTES"] = "0";
    expect(resolveRecallInjectCaps(configPath)).toEqual({
      caps: {},
      invalid: ["OPEN_SECOND_BRAIN_RECALL_INJECT_MAX_NOTES"],
    });
  });

  test("valid and invalid keys mix", () => {
    writeConfig({ recall_inject_max_notes: "2", recall_inject_confidence_floor: "-0.1" });
    expect(resolveRecallInjectCaps(configPath)).toEqual({
      caps: { maxNotes: 2 },
      invalid: ["recall_inject_confidence_floor"],
    });
  });
});

describe("resolveRecallInjectDedupe", () => {
  test("defaults to true", () => {
    expect(resolveRecallInjectDedupe(configPath)).toBe(true);
  });

  test("an explicit false turns it off, from config or env", () => {
    writeConfig({ recall_inject_dedupe: "false" });
    expect(resolveRecallInjectDedupe(configPath)).toBe(false);
    writeConfig({ recall_inject_dedupe: "true" });
    process.env["OPEN_SECOND_BRAIN_RECALL_INJECT_DEDUPE"] = "false";
    expect(resolveRecallInjectDedupe(configPath)).toBe(false);
    process.env["OPEN_SECOND_BRAIN_RECALL_INJECT_DEDUPE"] = "0";
    expect(resolveRecallInjectDedupe(configPath)).toBe(false);
  });

  test("anything other than a falsy literal keeps it on", () => {
    writeConfig({ recall_inject_dedupe: "maybe" });
    expect(resolveRecallInjectDedupe(configPath)).toBe(true);
  });
});

describe("resolveRegroundPartsEnabled", () => {
  test("defaults to false", () => {
    expect(resolveRegroundPartsEnabled(configPath)).toBe(false);
  });

  test("turns on from config or env", () => {
    writeConfig({ reground_parts_enabled: "true" });
    expect(resolveRegroundPartsEnabled(configPath)).toBe(true);
    writeConfig({});
    process.env["OPEN_SECOND_BRAIN_REGROUND_PARTS_ENABLED"] = "1";
    expect(resolveRegroundPartsEnabled(configPath)).toBe(true);
  });
});

describe("resolveRegroundPartChars", () => {
  test("defaults to 9000", () => {
    expect(REGROUND_PART_CHARS_DEFAULT).toBe(9000);
    expect(resolveRegroundPartChars("claudecode", configPath).chars).toBe(9000);
    expect(resolveRegroundPartChars("codex", configPath).chars).toBe(9000);
  });

  test("the runtime key wins over the shared key, which wins over the default", () => {
    writeConfig({ reground_part_chars: "5000", reground_part_chars_codex: "3000" });
    expect(resolveRegroundPartChars("codex", configPath).chars).toBe(3000);
    expect(resolveRegroundPartChars("claudecode", configPath).chars).toBe(5000);
  });

  test("env wins at each level", () => {
    writeConfig({ reground_part_chars: "5000", reground_part_chars_claudecode: "4000" });
    process.env["OPEN_SECOND_BRAIN_REGROUND_PART_CHARS_CLAUDECODE"] = "2500";
    expect(resolveRegroundPartChars("claudecode", configPath).chars).toBe(2500);
    process.env["OPEN_SECOND_BRAIN_REGROUND_PART_CHARS"] = "6000";
    expect(resolveRegroundPartChars("codex", configPath).chars).toBe(6000);
  });

  test("an invalid value falls through to the next level", () => {
    writeConfig({ reground_part_chars: "5000", reground_part_chars_claudecode: "1999" });
    expect(resolveRegroundPartChars("claudecode", configPath).chars).toBe(5000);
    writeConfig({ reground_part_chars: "100001", reground_part_chars_codex: "abc" });
    expect(resolveRegroundPartChars("codex", configPath).chars).toBe(9000);
    writeConfig({ reground_part_chars: "2000.5" });
    expect(resolveRegroundPartChars("codex", configPath).chars).toBe(9000);
  });

  test("a rejected value is named by its config key", () => {
    writeConfig({ reground_part_chars: "5000", reground_part_chars_claudecode: "1999" });
    expect(resolveRegroundPartChars("claudecode", configPath)).toEqual({
      chars: 5000,
      invalid: ["reground_part_chars_claudecode"],
    });
    writeConfig({ reground_part_chars: "100001", reground_part_chars_codex: "abc" });
    expect(resolveRegroundPartChars("codex", configPath).invalid).toEqual([
      "reground_part_chars_codex",
      "reground_part_chars",
    ]);
    writeConfig({ reground_part_chars: "4000" });
    expect(resolveRegroundPartChars("codex", configPath).invalid).toEqual([]);
  });

  test("a rejected environment value is named by its environment variable", () => {
    writeConfig({ reground_part_chars: "5000", reground_part_chars_claudecode: "4000" });
    process.env["OPEN_SECOND_BRAIN_REGROUND_PART_CHARS_CLAUDECODE"] = "1999";
    expect(resolveRegroundPartChars("claudecode", configPath)).toEqual({
      chars: 5000,
      invalid: ["OPEN_SECOND_BRAIN_REGROUND_PART_CHARS_CLAUDECODE"],
    });
  });

  test("range edges are inclusive", () => {
    writeConfig({ reground_part_chars_claudecode: "2000", reground_part_chars_codex: "100000" });
    expect(resolveRegroundPartChars("claudecode", configPath).chars).toBe(2000);
    expect(resolveRegroundPartChars("codex", configPath).chars).toBe(100000);
  });
});

describe("malformed config", () => {
  test("no resolver throws on a malformed config file", () => {
    writeFileSync(configPath, "{{{ not: [yaml\n:::\n\trecall_inject_max_notes\n");
    expect(resolveRecallInjectCaps(configPath)).toEqual({ caps: {}, invalid: [] });
    expect(resolveRecallInjectDedupe(configPath)).toBe(true);
    expect(resolveRegroundPartsEnabled(configPath)).toBe(false);
    expect(resolveRegroundPartChars("codex", configPath).chars).toBe(9000);
  });
});
