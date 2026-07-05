import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { recordQueryDemand } from "../../src/core/brain/query-demand.ts";
import { runCli } from "../helpers/run-cli.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-knowledge-gaps-cli-"));
  mkdirSync(join(vault, "Brain"), { recursive: true });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

test("brain knowledge-gaps ranks recurring poorly-answered queries as JSON", async () => {
  for (let i = 0; i < 3; i++) {
    recordQueryDemand(vault, {
      query: "incident response runbook",
      resultCount: 0,
      coverage: 0.0,
      at: `2026-07-0${i + 1}T00:00:00.000Z`,
    });
  }
  recordQueryDemand(vault, {
    query: "deployment pipeline overview",
    resultCount: 4,
    coverage: 0.9,
    at: "2026-07-01T02:00:00.000Z",
  });
  recordQueryDemand(vault, {
    query: "deployment pipeline overview",
    resultCount: 4,
    coverage: 0.9,
    at: "2026-07-02T02:00:00.000Z",
  });

  const result = await runCli(["brain", "knowledge-gaps", "--vault", vault, "--json"]);
  expect(result.returncode).toBe(0);
  const report = JSON.parse(result.stdout);
  expect(report.total_records).toBe(5);
  expect(report.gaps).toHaveLength(1);
  expect(report.gaps[0].terms).toEqual(["incident", "response", "runbook"]);
  expect(report.gaps[0].occurrences).toBe(3);
  expect(report.gaps[0].empty_count).toBe(3);
});

test("brain knowledge-gaps renders a human summary", async () => {
  recordQueryDemand(vault, {
    query: "cron secret rotation",
    resultCount: 0,
    at: "2026-07-01T00:00:00Z",
  });
  recordQueryDemand(vault, {
    query: "cron secret rotation",
    resultCount: 0,
    at: "2026-07-02T00:00:00Z",
  });

  const result = await runCli(["brain", "knowledge-gaps", "--vault", vault]);
  expect(result.returncode).toBe(0);
  expect(result.stdout).toContain("gap(s)");
  expect(result.stdout).toContain("cron rotation secret");
});

test("brain knowledge-gaps rejects a bad --max-satisfaction", async () => {
  const result = await runCli([
    "brain",
    "knowledge-gaps",
    "--vault",
    vault,
    "--max-satisfaction",
    "5",
  ]);
  expect(result.returncode).not.toBe(0);
  expect(result.stderr).toContain("--max-satisfaction");
});
