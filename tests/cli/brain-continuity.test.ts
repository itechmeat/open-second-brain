/**
 * `o2b brain continuity export` (Memory Observability Suite,
 * t_51959aeb): read-only ATOF/ATIF export of the continuity store.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { appendContinuityRecord } from "../../src/core/brain/continuity/store.ts";
import { runCli } from "../helpers/run-cli.ts";

let tmp: string;
let vault: string;
let configPath: string;
let outDir: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-continuity-cli-"));
  vault = join(tmp, "vault");
  configPath = join(tmp, "config.yaml");
  outDir = join(tmp, "out");
  writeFileSync(configPath, `vault: ${vault}\nagent_name: test-agent\n`);
  bootstrapBrain(vault, { configPath });
  appendContinuityRecord(vault, {
    kind: "session_turn",
    createdAt: "2026-06-03T10:00:00.000Z",
    payload: { session_id: "s-1", turn_id: "t-1", role: "user", text: "hello" },
  });
  appendContinuityRecord(vault, {
    kind: "gate_telemetry",
    createdAt: "2026-06-03T10:00:01.000Z",
    payload: { host: "mcp", session_id: "s-1", decision: "skip", reason: "smalltalk" },
  });
  // A private record must never reach an export file.
  appendContinuityRecord(vault, {
    kind: "session_turn",
    createdAt: "2026-06-03T10:00:02.000Z",
    payload: {
      session_id: "s-1",
      turn_id: "t-2",
      role: "user",
      text: "carries a <private>secret plan</private> region",
    },
  });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const env = () => ({ OPEN_SECOND_BRAIN_CONFIG: configPath });

describe("o2b brain continuity export", () => {
  test("atof export writes one JSONL stream and drops private records", async () => {
    const out = await runCli(
      ["brain", "continuity", "export", "--format", "atof", "--out", outDir, "--json"],
      { env: env() },
    );
    expect(out.returncode).toBe(0);
    const parsed = JSON.parse(out.stdout) as { records: number; files: string[] };
    expect(parsed.records).toBe(2);
    expect(parsed.files).toHaveLength(1);
    const content = readFileSync(parsed.files[0]!, "utf8");
    expect(content).toContain('"atof_version"');
    expect(content).not.toContain("secret plan");
  });

  test("atif export writes one trajectory per session", async () => {
    const out = await runCli(
      ["brain", "continuity", "export", "--format", "atif", "--out", outDir],
      { env: env() },
    );
    expect(out.returncode).toBe(0);
    const path = join(outDir, "o2b-continuity-s-1.atif.json");
    expect(existsSync(path)).toBe(true);
    const trajectory = JSON.parse(readFileSync(path, "utf8")) as {
      schema_version: string;
      steps: Array<{ source: string }>;
    };
    expect(trajectory.schema_version).toBe("ATIF-v1.7");
    expect(trajectory.steps).toHaveLength(2);
    expect(trajectory.steps.some((s) => s.source === "system")).toBe(true);
  });

  test("unknown format and bad month fail with usage errors", async () => {
    const bad = await runCli(
      ["brain", "continuity", "export", "--format", "csv", "--out", outDir],
      { env: env() },
    );
    expect(bad.returncode).not.toBe(0);
    const badMonth = await runCli(
      ["brain", "continuity", "export", "--format", "atof", "--month", "June", "--out", outDir],
      { env: env() },
    );
    expect(badMonth.returncode).not.toBe(0);
  });
});
