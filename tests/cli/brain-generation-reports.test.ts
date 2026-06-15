import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listGenerationReports } from "../../src/core/brain/generation-reports.ts";
import { runCli } from "../helpers/run-cli.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-generation-reports-cli-"));
  mkdirSync(join(vault, "Brain"), { recursive: true });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

test("record is gated: without --enable nothing is written", async () => {
  const res = await runCli([
    "brain",
    "generation-reports",
    "record",
    "write_session",
    "--ref",
    "ws-1",
    "--agent",
    "tester",
    "--prompt",
    "do the thing",
    "--vault",
    vault,
    "--json",
  ]);
  expect(res.returncode).toBe(0);
  expect(JSON.parse(res.stdout)).toMatchObject({ recorded: false, reason: "disabled" });
  expect(listGenerationReports(vault)).toHaveLength(0);
});

test("record --enable writes one report; list and summary read it back", async () => {
  const rec = await runCli([
    "brain",
    "generation-reports",
    "record",
    "write_session",
    "--enable",
    "--ref",
    "ws-7",
    "--agent",
    "tester",
    "--provider",
    "anthropic",
    "--model",
    "claude-opus-4-7",
    "--prompt",
    "synthesize secret token=sk-keep-out",
    "--input-tokens",
    "100",
    "--total-tokens",
    "150",
    "--source",
    "pref-foo=Brain/preferences/pref-foo.md",
    "--created-at",
    "2026-06-15T09:00:00Z",
    "--vault",
    vault,
    "--json",
  ]);
  expect(rec.returncode).toBe(0);
  const recJson = JSON.parse(rec.stdout);
  expect(recJson.recorded).toBe(true);
  expect(recJson.id).toStartWith("ctn_");
  // The raw prompt must not leak into CLI output.
  expect(rec.stdout).not.toContain("sk-keep-out");

  const list = await runCli([
    "brain",
    "generation-reports",
    "list",
    "--handoff",
    "write_session",
    "--vault",
    vault,
    "--json",
  ]);
  expect(list.returncode).toBe(0);
  const listJson = JSON.parse(list.stdout);
  expect(listJson.total).toBe(1);
  expect(listJson.reports[0].payload).toMatchObject({
    handoff: { kind: "write_session", ref: "ws-7" },
    agent: "tester",
    provider: "anthropic",
    usage: { input_tokens: 100, total_tokens: 150 },
  });
  expect(JSON.stringify(listJson)).not.toContain("sk-keep-out");

  const summary = await runCli([
    "brain",
    "generation-reports",
    "summary",
    "--vault",
    vault,
    "--json",
  ]);
  expect(summary.returncode).toBe(0);
  const summaryJson = JSON.parse(summary.stdout);
  expect(summaryJson).toMatchObject({
    total: 1,
    by_handoff_kind: { write_session: 1 },
    reported_count: 1,
  });
  expect(summaryJson.by_path["Brain/preferences/pref-foo.md"]).toEqual([listJson.reports[0].id]);
});

test("record rejects an unknown handoff kind", async () => {
  const res = await runCli([
    "brain",
    "generation-reports",
    "record",
    "not_a_kind",
    "--enable",
    "--ref",
    "x",
    "--agent",
    "a",
    "--prompt",
    "p",
    "--vault",
    vault,
  ]);
  expect(res.returncode).not.toBe(0);
});
