/**
 * Memory Observability Suite end-to-end flow (epic t_d75dc6a2).
 *
 * One scenario exercises the whole suite: gated telemetry emission
 * writes schema-stamped continuity records, the read-model serves them
 * to both trajectory exporters through the CLI, and a bench run over a
 * repo fixture reports quality / latency / context cost separately.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { packContext } from "../../src/core/brain/context-pack.ts";
import { CONTINUITY_SCHEMA_VERSION } from "../../src/core/brain/continuity/types.ts";
import { appendContinuityRecord } from "../../src/core/brain/continuity/store.ts";
import { runCli } from "../helpers/run-cli.ts";

let tmp: string;
let vault: string;
let configPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-mos-e2e-"));
  vault = join(tmp, "vault");
  configPath = join(tmp, "config.yaml");
  writeFileSync(configPath, `vault: ${vault}\nagent_name: e2e-agent\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const env = () => ({ OPEN_SECOND_BRAIN_CONFIG: configPath });

test("telemetry -> schema-stamped records -> ATOF/ATIF export -> bench report", async () => {
  // 1. Gated telemetry: a context pack with receipt+telemetry writes
  //    schema-stamped continuity records; without options it stays silent.
  writeFileSync(
    join(vault, "Brain", "preferences", "pref-e2e.md"),
    "---\nid: pref-e2e\ntopic: e2e\nstatus: confirmed\nprinciple: Keep e2e flows deterministic\ncreated_at: 2026-06-01T10:00:00\n---\n\nKeep e2e flows deterministic\n",
  );
  const report = packContext(vault, {
    maxTokens: 500,
    receipt: { host: "e2e", trigger: "context_pack", sessionId: "e2e-session" },
    telemetry: { host: "e2e", sessionId: "e2e-session" },
  });
  expect(report.receiptId).toBeDefined();
  expect(report.telemetryId).toBeDefined();

  // A session turn for the trajectory exporters.
  appendContinuityRecord(vault, {
    kind: "session_turn",
    createdAt: new Date().toISOString(),
    payload: { session_id: "e2e-session", turn_id: "t-1", role: "user", text: "ship the suite" },
  });

  // Every persisted record carries the contract-wide schema version.
  const continuityDir = join(vault, "Brain", "log", "continuity");
  const months = readdirSync(continuityDir).filter((name) => name.endsWith(".jsonl"));
  expect(months.length).toBeGreaterThan(0);
  for (const month of months) {
    for (const line of readFileSync(join(continuityDir, month), "utf8").split("\n")) {
      if (!line.trim()) continue;
      const record = JSON.parse(line) as { schema?: string };
      expect(record.schema).toBe(CONTINUITY_SCHEMA_VERSION);
    }
  }

  // 2. Export both trajectory formats through the CLI.
  const outDir = join(tmp, "export");
  const atof = await runCli(
    ["brain", "continuity", "export", "--format", "atof", "--out", outDir, "--json"],
    { env: env() },
  );
  expect(atof.returncode).toBe(0);
  const atofParsed = JSON.parse(atof.stdout) as { records: number; files: string[] };
  expect(atofParsed.records).toBeGreaterThanOrEqual(3);
  expect(readFileSync(atofParsed.files[0]!, "utf8")).toContain('"atof_version"');

  const atif = await runCli(
    [
      "brain",
      "continuity",
      "export",
      "--format",
      "atif",
      "--session",
      "e2e-session",
      "--out",
      outDir,
    ],
    { env: env() },
  );
  expect(atif.returncode).toBe(0);
  const trajectoryPath = join(outDir, "o2b-continuity-e2e-session.atif.json");
  expect(existsSync(trajectoryPath)).toBe(true);
  const trajectory = JSON.parse(readFileSync(trajectoryPath, "utf8")) as {
    schema_version: string;
    steps: Array<{ source: string; llm_call_count?: number }>;
  };
  expect(trajectory.schema_version).toBe("ATIF-v1.7");
  expect(trajectory.steps.some((s) => s.source === "system" && s.llm_call_count === 0)).toBe(true);

  // 3. Bench run over the repo fixture: separate metric families, green.
  const runsDir = join(tmp, "bench-runs");
  const bench = await runCli(
    ["brain", "bench", "memory", "--fixture", "core-recall", "--runs-dir", runsDir, "--json"],
    { env: env() },
  );
  expect(bench.returncode).toBe(0);
  const benchReport = JSON.parse(bench.stdout) as {
    quality: { passed: number; total: number };
    latency_ms: { avg: number };
    context_cost: { est_tokens: number };
  };
  expect(benchReport.quality.passed).toBe(benchReport.quality.total);
  expect(benchReport.latency_ms.avg).toBeGreaterThanOrEqual(0);
  expect(benchReport.context_cost.est_tokens).toBeGreaterThan(0);
  // The bench vault is disposable and separate from the operator vault.
  expect(existsSync(join(vault, "Brain", "notes", "coffee.md"))).toBe(false);
}, 120_000);
