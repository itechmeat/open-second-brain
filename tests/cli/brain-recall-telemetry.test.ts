import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { emitRecallTelemetry } from "../../src/core/brain/recall-telemetry.ts";
import { runCli } from "../helpers/run-cli.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-recall-telemetry-cli-"));
  mkdirSync(join(vault, "Brain"), { recursive: true });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

test("brain recall-telemetry lists records and summarizes gaps", async () => {
  emitRecallTelemetry(vault, {
    createdAt: "2026-05-20T16:00:00.000Z",
    host: "cli-test",
    mode: "context_pack",
    status: "ok",
    durationMs: 8,
    resultCount: 2,
    topArtifacts: [{ id: "pref-alpha" }],
  });
  emitRecallTelemetry(vault, {
    createdAt: "2026-05-20T16:01:00.000Z",
    host: "cli-test",
    mode: "search",
    status: "empty",
    durationMs: 12,
    resultCount: 0,
    gaps: ["no_matching_context"],
  });

  const list = await runCli([
    "brain",
    "recall-telemetry",
    "list",
    "--vault",
    vault,
    "--mode",
    "context_pack",
    "--json",
  ]);
  expect(list.returncode).toBe(0);
  const listJson = JSON.parse(list.stdout);
  expect(listJson.total).toBe(1);
  expect(listJson.records[0].payload).toMatchObject({
    mode: "context_pack",
    result_count: 2,
  });

  const summary = await runCli([
    "brain",
    "recall-telemetry",
    "summary",
    "--vault",
    vault,
    "--host",
    "cli-test",
    "--json",
  ]);
  expect(summary.returncode).toBe(0);
  const summaryJson = JSON.parse(summary.stdout);
  expect(summaryJson).toMatchObject({
    total: 2,
    by_mode: { context_pack: 1, search: 1 },
    by_status: { ok: 1, empty: 1 },
    total_results: 2,
    empty_runs: 1,
    gap_counts: { no_matching_context: 1 },
  });
});
