import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { emitRecallTelemetry, RECALL_CHANNEL } from "../../src/core/brain/recall-telemetry.ts";
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
    channel: RECALL_CHANNEL.cli,
    mode: "context_pack",
    status: "ok",
    durationMs: 8,
    resultCount: 2,
    topArtifacts: [{ id: "pref-alpha" }],
  });
  emitRecallTelemetry(vault, {
    createdAt: "2026-05-20T16:01:00.000Z",
    host: "cli-test",
    channel: RECALL_CHANNEL.cli,
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

test("brain recall-telemetry filters by channel and rejects one that does not exist", async () => {
  emitRecallTelemetry(vault, {
    createdAt: "2026-05-20T16:02:00.000Z",
    host: "cli-test",
    channel: RECALL_CHANNEL.hook,
    mode: "search",
    status: "empty",
    durationMs: 3,
    resultCount: 0,
  });
  emitRecallTelemetry(vault, {
    createdAt: "2026-05-20T16:03:00.000Z",
    host: "cli-test",
    channel: RECALL_CHANNEL.mcp,
    mode: "query",
    status: "ok",
    durationMs: 3,
    resultCount: 1,
  });

  const list = await runCli([
    "brain",
    "recall-telemetry",
    "list",
    "--vault",
    vault,
    "--channel",
    "hook",
    "--json",
  ]);
  expect(list.returncode).toBe(0);
  expect(JSON.parse(list.stdout).total).toBe(1);

  const summary = await runCli([
    "brain",
    "recall-telemetry",
    "summary",
    "--vault",
    vault,
    "--json",
  ]);
  expect(JSON.parse(summary.stdout).by_channel).toEqual({ hook: 1, mcp: 1 });

  const rejected = await runCli([
    "brain",
    "recall-telemetry",
    "list",
    "--vault",
    vault,
    "--channel",
    "hermes",
  ]);
  expect(rejected.returncode).not.toBe(0);
  // The message renders the closed set rather than restating it in prose.
  expect(rejected.stderr).toContain("mcp, cli, hook");
});

test("brain recall-telemetry accepts every recorded mode, `query` included", async () => {
  emitRecallTelemetry(vault, {
    createdAt: "2026-05-20T16:04:00.000Z",
    host: "cli-test",
    channel: RECALL_CHANNEL.mcp,
    mode: "query",
    status: "ok",
    durationMs: 2,
    resultCount: 1,
  });

  const list = await runCli([
    "brain",
    "recall-telemetry",
    "list",
    "--vault",
    vault,
    "--mode",
    "query",
    "--json",
  ]);
  expect(list.returncode).toBe(0);
  expect(JSON.parse(list.stdout).total).toBe(1);
});
