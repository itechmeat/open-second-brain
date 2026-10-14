/**
 * The `standing_instruction` bench category (recall-lane-latency):
 * the standing-instruction facet lane measured end to end over a
 * disposable fixture vault.
 *
 * The category's retrieve branch drives the shipped `standing_query`
 * attention action with the facet option on - the provenance join, not
 * the search pipeline, is the seam under test - and `evaluateQuestion`
 * asserts the preference id plus its origin turn. Reports without the
 * category serialize byte-identically, the default knob pin is
 * untouched, and the facet-lane pin marker is part of the run identity:
 * a resumed run whose pin changed fails the guard instead of mixing
 * identities.
 *
 * The fixture vault files below hand-write the same facts the live
 * writers emit, in a YAML form `parsePreference`/`parseSignal` and the
 * attention-flow reader `listAttentionFlows` read to identical values -
 * the bytes are not the writers' own output (the writers quote
 * `#`-bearing scalars and emit inline arrays where the fixture writes
 * unquoted scalars and block lists). The bench materializes its vault
 * from raw fixture notes, so the parsers are the seam under
 * measurement; the producer formats themselves are pinned at the unit
 * layer (tests/core/brain/standing-instruction-facets.test.ts)
 * against the live writers.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseBenchFixture } from "../../../src/core/bench/fixture.ts";
import { runMemoryBench } from "../../../src/core/bench/phases.ts";
import {
  DEFAULT_BENCH_KNOB_PIN,
  type BenchFixture,
  type BenchPinnedKnobs,
} from "../../../src/core/bench/types.ts";

let runsDir: string;

beforeEach(() => {
  runsDir = mkdtempSync(join(tmpdir(), "o2b-bench-standing-"));
});

afterEach(() => {
  rmSync(runsDir, { recursive: true, force: true });
});

/**
 * The vault files the surfacing lane reads, in the shapes the live
 * writers emit. The import-session signal carries the `<basename>#<turn>`
 * ref (kind `turn`); the auto-extract signal carries the bare
 * `session:<id>` ref that resolves to nothing.
 */
const FLOW_MD = [
  "---",
  "kind: brain-attention-flow",
  "id: open-loops",
  "title: Open loops",
  "actions:",
  "  - standing_query",
  "standing_queries:",
  "  - testing",
  "status: active",
  "---",
  "",
  "# Open loops",
  "",
].join("\n");

function preferenceMd(slug: string, topic: string, principle: string, evidence: string): string {
  return [
    "---",
    "kind: brain-preference",
    `id: pref-${slug}`,
    "created_at: 2026-06-01T00:00:00Z",
    "_confirmed_at: 2026-06-02T00:00:00Z",
    "unconfirmed_until: 2026-07-01T00:00:00Z",
    "tags:",
    "  - bench",
    `topic: ${topic}`,
    "_status: confirmed",
    `principle: ${principle}`,
    "_evidenced_by:",
    `  - "[[${evidence}]]"`,
    "_applied_count: 0",
    "_violated_count: 0",
    "_last_evidence_at: null",
    "_confidence: low",
    "_confidence_value: null",
    "pinned: false",
    "scope: testing",
    "---",
    "",
    principle,
    "",
  ].join("\n");
}

function signalMd(slug: string, topic: string, principle: string, sessionRef: string): string {
  return [
    "---",
    "kind: brain-signal",
    `id: ${slug}`,
    "created_at: 2026-06-01T00:00:00Z",
    "tags:",
    "  - bench",
    `topic: ${topic}`,
    "signal: positive",
    "agent: bench",
    `principle: ${principle}`,
    "scope: testing",
    `session_ref: ${sessionRef}`,
    "---",
    "",
    "recorded preference signal",
    "",
  ].join("\n");
}

/** Built per test, so a fixture parse refusal fails one test, not the file. */
function standingFixture(): BenchFixture {
  return parseBenchFixture({
    name: "standing-instruction-bench",
    notes: [
      { path: "Brain/attention/flows/open-loops.md", body: FLOW_MD },
      {
        path: "Brain/preferences/pref-tabs.md",
        body: preferenceMd("tabs", "tabs", "Use tabs for indentation", "sig-bench-turn"),
      },
      {
        path: "Brain/preferences/pref-commits.md",
        body: preferenceMd("commits", "commits", "Prefer small commits", "sig-bench-bare"),
      },
      {
        path: "Brain/inbox/sig-bench-turn.md",
        body: signalMd(
          "sig-bench-turn",
          "tabs",
          "use tabs for indentation",
          "bench-session.json#turn-2",
        ),
      },
      {
        path: "Brain/inbox/sig-bench-bare.md",
        body: signalMd("sig-bench-bare", "commits", "prefer small commits", "session:conv-9"),
      },
    ],
    continuity: [],
    questions: [
      {
        id: "q-standing",
        category: "standing_instruction",
        // The facet key (the preference id) that must be delivered ...
        expected_ids: ["pref:pref-tabs"],
        // ... and the origin turn that must annotate it. The kind word
        // is part of the expectation on purpose: an event-annotated
        // origin satisfies neither this string nor the gate.
        expected_text: "first mention turn bench-session.json#turn-2",
      },
      {
        // The auto-extract shape resolves to no origin, so its facet is
        // honestly absent and the expectation fails by name.
        id: "q-standing-unresolved",
        category: "standing_instruction",
        expected_ids: ["pref:pref-commits"],
      },
    ],
  });
}

/** A keyword-only fixture: no standing_instruction questions anywhere. */
function keywordFixture(): BenchFixture {
  return parseBenchFixture({
    name: "standing-keyword-control",
    notes: [
      {
        path: "Brain/notes/coffee.md",
        body: "# Coffee\n\nThe coffee preference is a flat white every morning.\n",
      },
    ],
    continuity: [],
    questions: [
      {
        id: "q-coffee",
        category: "single_hop",
        query: "coffee preference",
        top_k: 5,
        expected_paths: ["Brain/notes/coffee.md"],
      },
    ],
  });
}

describe("bench standing_instruction category", () => {
  test("reports without the new category serialize byte-identically", async () => {
    const report = await runMemoryBench({ fixture: keywordFixture(), runsDir });
    const serialized = JSON.stringify(report, null, 2);
    // No standing_instruction key anywhere: the category is absent from
    // the quality buckets, the questions and every other family, so a
    // pre-category consumer reads the same bytes.
    expect(serialized).not.toContain("standing_instruction");
    expect(Object.keys(report)).toEqual([
      "schema",
      "run_id",
      "fixture",
      "fixture_hash",
      "created_at",
      "quality",
      "latency_ms",
      "context_cost",
      "failure_modes",
      "judge",
      "questions",
    ]);
    expect(Object.keys(report.quality.by_category)).toEqual(["single_hop"]);
    expect(report.quality.passed).toBe(report.quality.total);
  }, 30_000);

  test("the standing_instruction question asserts the preference id plus origin turn", async () => {
    const report = await runMemoryBench({ fixture: standingFixture(), runsDir });
    expect(report.quality.by_category["standing_instruction"]).toEqual({ passed: 1, total: 2 });
    const passing = report.questions.find((question) => question.id === "q-standing")!;
    expect(passing.category).toBe("standing_instruction");
    expect(passing.pass).toBe(true);
    // A standing result adds no metric fields: its shape is the shared
    // id/category/latency/pass core, nothing else.
    expect(Object.keys(passing).toSorted()).toEqual(["category", "id", "latency_ms", "pass"]);
  }, 30_000);

  test("an unresolved preference fails its question by name", async () => {
    const report = await runMemoryBench({ fixture: standingFixture(), runsDir });
    const unresolved = report.questions.find(
      (question) => question.id === "q-standing-unresolved",
    )!;
    expect(unresolved.pass).toBe(false);
    // The bare auto-extract ref resolves to no origin, so the facet is
    // absent - a named failure, never an implied provenance.
    expect(unresolved.failure).toContain("pref:pref-commits");
  }, 30_000);

  test("the default knob pin serializes byte-for-byte unchanged", () => {
    expect(JSON.stringify(DEFAULT_BENCH_KNOB_PIN)).toBe('{"semantic":{"enabled":false}}');
  });

  test("the facet-lane pin marker is part of the run identity", async () => {
    const laneOnPin: BenchPinnedKnobs = {
      semantic: { enabled: false },
      standingInstructionFacets: true,
    };
    const first = await runMemoryBench({
      fixture: standingFixture(),
      runsDir,
      pinnedKnobs: laneOnPin,
    });
    // The marker rides the checkpoint verbatim ...
    const checkpoint = JSON.parse(
      readFileSync(join(runsDir, first.run_id, "checkpoint.json"), "utf8"),
    ) as { pinned_knobs?: Record<string, unknown> };
    expect(checkpoint.pinned_knobs).toEqual({
      semantic: { enabled: false },
      standingInstructionFacets: true,
    });
    // ... so a resumed run under the plain pin fails the identity guard ...
    await expect(
      runMemoryBench({ fixture: standingFixture(), runsDir, resume: first.run_id }),
    ).rejects.toThrow(/run identity mismatch/);
    // ... and resuming under the same marker reuses the run.
    const resumed = await runMemoryBench({
      fixture: standingFixture(),
      runsDir,
      resume: first.run_id,
      pinnedKnobs: laneOnPin,
    });
    expect(resumed.run_id).toBe(first.run_id);
    expect(resumed.quality).toEqual(first.quality);
  }, 30_000);
});
