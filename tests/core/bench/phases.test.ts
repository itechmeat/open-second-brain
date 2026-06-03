/**
 * Bench phase pipeline (Memory Observability Suite, t_882c396a):
 * ingest -> index -> retrieve -> evaluate -> report over a disposable
 * fixture vault. Deterministic, no network; quality / latency /
 * context cost stay separate numbers; resume skips completed phases;
 * a stale-fact fixture catches superseded-recall regressions.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseBenchFixture } from "../../../src/core/bench/fixture.ts";
import { runMemoryBench } from "../../../src/core/bench/phases.ts";
import { BENCH_REPORT_SCHEMA } from "../../../src/core/bench/types.ts";

let runsDir: string;

beforeEach(() => {
  runsDir = mkdtempSync(join(tmpdir(), "o2b-bench-phases-"));
});

afterEach(() => {
  rmSync(runsDir, { recursive: true, force: true });
});

const FIXTURE = parseBenchFixture({
  name: "phase-suite",
  notes: [
    {
      path: "Brain/notes/coffee.md",
      body: "# Coffee preference\n\nCoffee preference of the operator: flat white every morning. The coffee preference is stable.\n",
    },
    {
      path: "Brain/notes/coffee-old.md",
      body: "# Superseded note\n\nOld coffee preference: espresso. Replaced by the flat white note.\n",
    },
    {
      path: "Brain/notes/deploy-a.md",
      body: "# Deploy step A\n\nDeployment requires the staging gate to pass first.\n",
    },
    {
      path: "Brain/notes/deploy-b.md",
      body: "# Deploy step B\n\nDeployment finishes with the production smoke checklist.\n",
    },
    {
      path: "Brain/preferences/pref-tabs.md",
      body: "---\nid: pref-tabs\ntopic: tabs\nstatus: confirmed\nprinciple: Use tabs for indentation in Go files\ncreated_at: 2026-05-01T10:00:00\n---\n\nUse tabs for indentation in Go files\n",
    },
  ],
  continuity: [
    {
      kind: "session_turn",
      created_at: "2026-06-01T10:00:00.000Z",
      payload: { session_id: "s-1", turn_id: "t-1", role: "user", text: "handoff: flat white" },
    },
    {
      kind: "session_turn",
      created_at: "2026-06-01T10:01:00.000Z",
      payload: { session_id: "s-1", turn_id: "t-2", role: "assistant", text: "noted" },
    },
  ],
  questions: [
    {
      id: "q-single",
      category: "single_hop",
      query: "flat white",
      top_k: 5,
      expected_paths: ["Brain/notes/coffee.md"],
    },
    {
      id: "q-stale",
      category: "temporal",
      query: "coffee preference",
      top_k: 5,
      expected_paths: ["Brain/notes/coffee.md"],
      not_expected_above: ["Brain/notes/coffee-old.md"],
    },
    {
      id: "q-multi",
      category: "multi_evidence",
      query: "deployment",
      top_k: 5,
      expected_paths: ["Brain/notes/deploy-a.md", "Brain/notes/deploy-b.md"],
    },
    {
      id: "q-handoff",
      category: "session_handoff",
      session_id: "s-1",
      expected_turns: 2,
      expected_text: "flat white",
    },
    {
      id: "q-budget",
      category: "budget",
      expected_ids: ["pref-tabs"],
      max_tokens: 500,
    },
  ],
});

describe("runMemoryBench", () => {
  test("full pipeline produces a diffable report with separate metric families", async () => {
    const report = await runMemoryBench({ fixture: FIXTURE, runsDir });
    expect(report.schema).toBe(BENCH_REPORT_SCHEMA);
    expect(report.fixture).toBe("phase-suite");
    expect(report.quality.total).toBe(5);
    expect(report.quality.passed).toBe(5);
    expect(report.quality.pass_rate).toBe(1);
    expect(report.quality.by_category["single_hop"]).toEqual({ passed: 1, total: 1 });
    // Metric families stay separate - never one collapsed score.
    expect(report.latency_ms.avg).toBeGreaterThanOrEqual(0);
    expect(report.latency_ms.max).toBeGreaterThanOrEqual(report.latency_ms.avg);
    expect(report.context_cost.avg_chars).toBeGreaterThan(0);
    expect(report.context_cost.est_tokens).toBeGreaterThan(0);
    expect(report.judge.status).toBe("skipped");
    // Stable question order by id for diffability.
    expect(report.questions.map((q) => q.id)).toEqual(report.questions.map((q) => q.id).toSorted());
    // report.json lands in the run directory.
    const onDisk = JSON.parse(
      readFileSync(join(runsDir, report.run_id, "report.json"), "utf8"),
    ) as {
      schema: string;
    };
    expect(onDisk.schema).toBe(BENCH_REPORT_SCHEMA);
  }, 30_000);

  test("a stale-fact regression is caught: superseded note ranking above fails the question", async () => {
    const regression = parseBenchFixture({
      name: "stale-regression",
      notes: [
        {
          path: "Brain/notes/new.md",
          body: "# Current\n\nThe coffee preference today is flat white, replacing every older note about it.\n",
        },
        {
          path: "Brain/notes/old.md",
          body: "# Old\n\nCoffee preference coffee preference coffee preference: espresso coffee preference, morning coffee preference.\n",
        },
      ],
      questions: [
        {
          id: "q-stale",
          category: "temporal",
          query: "coffee preference",
          top_k: 5,
          expected_paths: ["Brain/notes/new.md"],
          not_expected_above: ["Brain/notes/old.md"],
        },
      ],
    });
    const report = await runMemoryBench({ fixture: regression, runsDir });
    expect(report.quality.passed).toBe(0);
    const q = report.questions.find((entry) => entry.id === "q-stale")!;
    expect(q.pass).toBe(false);
    expect(q.failure).toContain("Brain/notes/old.md");
  }, 30_000);

  test("resume by run id skips completed phases and reuses stored results", async () => {
    const first = await runMemoryBench({ fixture: FIXTURE, runsDir });
    // Remove the disposable vault: a resumed run must NOT need to
    // re-ingest or re-search - evaluation reuses stored results.
    rmSync(join(runsDir, first.run_id, "vault"), { recursive: true, force: true });
    const resumed = await runMemoryBench({
      fixture: FIXTURE,
      runsDir,
      resume: first.run_id,
    });
    expect(resumed.run_id).toBe(first.run_id);
    expect(resumed.quality).toEqual(first.quality);
    expect(existsSync(join(runsDir, first.run_id, "vault"))).toBe(false);
  }, 30_000);

  test("resume with a changed fixture fails fast on the hash guard", async () => {
    const first = await runMemoryBench({ fixture: FIXTURE, runsDir });
    const changed = parseBenchFixture({
      ...JSON.parse(JSON.stringify(FIXTURE)),
      name: "phase-suite",
      notes: [{ path: "Brain/notes/x.md", body: "different" }],
    });
    await expect(
      runMemoryBench({ fixture: changed, runsDir, resume: first.run_id }),
    ).rejects.toThrow("hash");
  }, 30_000);
});
