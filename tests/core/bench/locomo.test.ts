import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadLocomoFixture,
  locomoToBenchFixture,
  parseLocomoDataset,
} from "../../../src/core/bench/locomo.ts";
import { parseBenchFixture } from "../../../src/core/bench/fixture.ts";
import { runMemoryBench } from "../../../src/core/bench/phases.ts";
import { BENCH_REPORT_SCHEMA } from "../../../src/core/bench/types.ts";

const SAMPLE = join("tests", "fixtures", "bench", "locomo-sample.json");

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

test("the loader converts a LoCoMo dataset into a valid BenchFixture", () => {
  const fixture = loadLocomoFixture(SAMPLE);
  // Round-trips through the canonical parser (so the harness accepts it).
  expect(() => parseBenchFixture(fixture)).not.toThrow();
  expect(fixture.name).toBe("locomo-sample");
  expect(fixture.notes.map((n) => n.path).toSorted()).toEqual(["sessions/s1.md", "sessions/s2.md"]);
  // Continuity holds one session_turn per turn (4 total).
  expect(fixture.continuity.length).toBe(4);
  for (const c of fixture.continuity) expect(c.kind).toBe("session_turn");
});

test("QA categories map onto OSB's canonical categories", () => {
  const fixture = loadLocomoFixture(SAMPLE);
  const byId = new Map(fixture.questions.map((q) => [q.id, q]));
  expect(byId.get("locomo-q1")!.category).toBe("single_hop");
  expect(byId.get("locomo-q3")!.category).toBe("temporal");
  expect(byId.get("locomo-q1")!.expected_paths).toEqual(["sessions/s1.md"]);
  expect(byId.get("locomo-q1")!.expected_text).toBe("Friday");
});

test("running the LoCoMo suite produces an o2b.bench.v1 report deterministically", async () => {
  const fixture = loadLocomoFixture(SAMPLE);
  const runsDir = mkdtempSync(join(tmpdir(), "o2b-locomo-runs-"));
  dirs.push(runsDir);
  const report = await runMemoryBench({ fixture, runsDir });
  expect(report.schema).toBe(BENCH_REPORT_SCHEMA);
  expect(report.fixture).toBe("locomo-sample");
  // Deterministic offline run: the judge stays skipped by default.
  expect(report.judge.status).toBe("skipped");
  // Every query's evidence session is keyword-distinctive, so all pass.
  expect(report.quality.passed).toBe(report.quality.total);
  expect(report.quality.total).toBe(3);
}, 30_000);

test("parseLocomoDataset rejects a QA with no evidence sessions", () => {
  expect(() =>
    locomoToBenchFixture(
      parseLocomoDataset({
        sessions: [
          {
            session_id: "s1",
            turns: [{ speaker: "A", text: "hi there", timestamp: "2026-01-01T00:00:00Z" }],
          },
        ],
        qa: [{ id: "q", question: "what", evidence_sessions: [] }],
      }),
    ),
  ).toThrow(/evidence_sessions/);
});
