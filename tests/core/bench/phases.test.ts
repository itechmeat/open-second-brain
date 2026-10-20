/**
 * Bench phase pipeline (Memory Observability Suite, t_882c396a):
 * ingest -> index -> retrieve -> evaluate -> report over a disposable
 * fixture vault. Deterministic, no network; quality / latency /
 * context cost stay separate numbers; resume skips completed phases;
 * a stale-fact fixture catches superseded-recall regressions.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  benchEmbeddingSignature,
  benchVectorCacheKey,
} from "../../../src/core/bench/embedding-cache.ts";
import { parseBenchFixture } from "../../../src/core/bench/fixture.ts";
import { countQuestionResults } from "../../../src/core/bench/guards.ts";
import { loadLongMemEvalFixture } from "../../../src/core/bench/longmemeval.ts";
import { FAKE_PROVIDER_KEY } from "../../helpers/fake-credentials.ts";
import { benchSearchConfig, runMemoryBench } from "../../../src/core/bench/phases.ts";
import { completeBenchPhase, createBenchRun } from "../../../src/core/bench/run-store.ts";
import {
  BENCH_REPORT_SCHEMA,
  DEFAULT_BENCH_KNOB_PIN,
  type BenchPinnedKnobs,
} from "../../../src/core/bench/types.ts";
import { cmdBrainBench } from "../../../src/cli/brain/verbs/bench.ts";
import { LOCAL_DEFAULT_DIMENSION } from "../../../src/core/search/embeddings/local-provider.ts";
import { LOCAL_EMBEDDING_MODEL } from "../../../src/core/search/embeddings/signature.ts";

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

/**
 * One minimal LongMemEval dataset entry: a single-hop question over one
 * one-turn haystack session, shaped the way the suite parser reads it.
 */
function longMemEvalEntry(id: string) {
  return {
    q_id: id,
    question_type: "single-hop",
    question: `what does note ${id} say`,
    haystack_session_id: [`s-${id}`],
    haystack_session: [[{ role: "user", content: `note ${id} body` }]],
    haystack_dates: ["2023-05-20"],
    answer_session_ids: [`s-${id}`],
  };
}

describe("runMemoryBench", () => {
  test("the default bench config pins the semantic lane off", () => {
    // The resolved config is where network-freedom is real: the pin must
    // hold whatever the surrounding environment configures.
    const config = benchSearchConfig(runsDir);
    expect(config.semantic.enabled).toBe(false);
  });

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
    expect(report.context_cost.avg_injected_tokens).toBeGreaterThan(0);
    expect(report.judge.status).toBe("skipped");
    // No suite is named, so no suite report family may appear: the
    // default path stays byte-identical.
    expect(report.longmemeval).toBeUndefined();
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

  test("resume with a changed fixture is refused as a named fixture mismatch", async () => {
    const first = await runMemoryBench({ fixture: FIXTURE, runsDir });
    // Change the fixture CONTENT while keeping every referenced note path:
    // the preflight's cross-reference guard (P7) must stay out of the way
    // so the fixture mismatch is the refusal this pin is about.
    const raw = JSON.parse(JSON.stringify(FIXTURE)) as {
      notes: Array<{ path: string; body: string }>;
    };
    raw.notes[0]!.body = "# Coffee preference\n\nA different body under the same path.\n";
    const changed = parseBenchFixture(raw);
    await expect(
      runMemoryBench({ fixture: changed, runsDir, resume: first.run_id }),
    ).rejects.toThrow(/refused \(checkpoint_fixture_mismatch\).*same fixture, seed and cap/s);
  }, 30_000);

  test("a LongMemEval resume under a different sample seed is a named fixture mismatch", async () => {
    // The seeded sampler selects a different subset per seed, so the
    // fixture a different `--sample-seed` loads is a DIFFERENT fixture
    // under the same dataset. The resume must be refused by name with the
    // seed-aware repair - never misread as a tampered run directory and
    // never as the raw load error the verb does not render.
    const datasetPath = join(runsDir, "dataset.json");
    writeFileSync(
      datasetPath,
      JSON.stringify({
        name: "seeded",
        questions: [
          longMemEvalEntry("a"),
          longMemEvalEntry("b"),
          longMemEvalEntry("c"),
          longMemEvalEntry("d"),
        ],
      }),
    );
    const seedA = loadLongMemEvalFixture(datasetPath, { sample: { seed: "seed-a", cap: 2 } });
    const seedB = loadLongMemEvalFixture(datasetPath, { sample: { seed: "seed-b", cap: 2 } });
    // The seeds select different questions, so the resumed fixture's
    // CONTENT differs - not just the sampling options.
    expect(seedA.fixture.questions.map((q) => q.id)).not.toEqual(
      seedB.fixture.questions.map((q) => q.id),
    );
    const first = await runMemoryBench({ fixture: seedA.fixture, runsDir });
    await expect(
      runMemoryBench({ fixture: seedB.fixture, runsDir, resume: first.run_id }),
    ).rejects.toThrow(/refused \(checkpoint_fixture_mismatch\)/);
  }, 30_000);

  test("the default knob pin equals today's hardcoded semantic-off override", () => {
    expect(DEFAULT_BENCH_KNOB_PIN).toEqual({ semantic: { enabled: false } });
  });

  test("pinned knobs are applied last and win over env and config", () => {
    const pin: BenchPinnedKnobs = {
      keywordWeight: 0.6,
      semantic: { enabled: false, provider: "local" },
    };
    const config = benchSearchConfig(runsDir, pin);
    expect(config.keywordWeight).toBe(0.6);
    expect(config.semantic.enabled).toBe(false);
    expect(config.semantic.provider).toBe("local");
  });

  test("two runs with different knob pins get different run ids", async () => {
    const first = await runMemoryBench({
      fixture: FIXTURE,
      runsDir,
      pinnedKnobs: { semantic: { enabled: false }, keywordWeight: 0.6 },
    });
    const second = await runMemoryBench({
      fixture: FIXTURE,
      runsDir,
      pinnedKnobs: { semantic: { enabled: false }, keywordWeight: 0.5 },
    });
    expect(first.run_id).not.toBe(second.run_id);
  }, 30_000);

  test("resume with a changed knob pin fails fast on the identity guard", async () => {
    const first = await runMemoryBench({ fixture: FIXTURE, runsDir });
    await expect(
      runMemoryBench({
        fixture: FIXTURE,
        runsDir,
        resume: first.run_id,
        pinnedKnobs: { semantic: { enabled: false }, keywordWeight: 0.6 },
      }),
    ).rejects.toThrow(/run identity mismatch/);
  }, 30_000);

  test("resume with the same explicit pin reuses the run", async () => {
    const pin: BenchPinnedKnobs = { semantic: { enabled: false }, keywordWeight: 0.6 };
    const first = await runMemoryBench({ fixture: FIXTURE, runsDir, pinnedKnobs: pin });
    const resumed = await runMemoryBench({
      fixture: FIXTURE,
      runsDir,
      resume: first.run_id,
      pinnedKnobs: pin,
    });
    expect(resumed.run_id).toBe(first.run_id);
    expect(resumed.quality).toEqual(first.quality);
  }, 30_000);

  test("an out-of-range recallFloor is refused by name before any run starts", async () => {
    // Each of these used to finish a FULL run: the floor routes into the
    // shared surfacing calculator, whose own contract refuses out-of-range
    // values per question, so the report came back complete with a
    // retrievalError on every proactive decision - paid after ingest and
    // index, instead of one named error up front (pr-250 review, L9).
    for (const floor of [-1, 1.5, Number.POSITIVE_INFINITY, Number.NaN]) {
      await expect(
        runMemoryBench({ fixture: FIXTURE, runsDir, recallFloor: floor }),
      ).rejects.toThrow(/recallFloor .* is outside \[0, 1\]/);
    }
    // Refused before any run state exists.
    expect(readdirSync(runsDir)).toHaveLength(0);
    // The interval's ends are legal calibration points: zero is the
    // maximally permissive sweep arm, one admits only a perfect match.
    await expect(
      runMemoryBench({ fixture: FIXTURE, runsDir, recallFloor: 1 }),
    ).resolves.toBeDefined();
  }, 60_000);

  test("an invalid sampling request is refused by name before any run state exists", async () => {
    // The sampling options are part of the run identity, so a malformed
    // one is refused up front rather than after a full run pays for a
    // configuration that never existed.
    for (const sample of [
      { seed: "seed-1", cap: 0 },
      { seed: "seed-1", cap: -2 },
      { seed: "seed-1", cap: 1.5 },
      { seed: "", cap: 2 },
      { seed: "   ", cap: 2 },
    ]) {
      await expect(runMemoryBench({ fixture: FIXTURE, runsDir, sample })).rejects.toThrow(
        /bench run refused/,
      );
    }
    expect(readdirSync(runsDir)).toHaveLength(0);
  }, 30_000);

  test("sampling options fold into the run identity end to end", async () => {
    // Cap 5 sits above the five-question fixture's population, so both
    // runs would materialize the identical fixture - the OPTIONS alone
    // must split the run ids.
    const first = await runMemoryBench({
      fixture: FIXTURE,
      runsDir,
      sample: { seed: "seed-1", cap: 5 },
    });
    const second = await runMemoryBench({
      fixture: FIXTURE,
      runsDir,
      sample: { seed: "seed-2", cap: 5 },
    });
    expect(first.run_id).not.toBe(second.run_id);
    // Resuming with the same sampling options reuses the run.
    const resumed = await runMemoryBench({
      fixture: FIXTURE,
      runsDir,
      resume: first.run_id,
      sample: { seed: "seed-1", cap: 5 },
    });
    expect(resumed.run_id).toBe(first.run_id);
    expect(readdirSync(runsDir)).toHaveLength(2);
  }, 30_000);

  test("resume with changed sampling options fails fast on the identity guard", async () => {
    const first = await runMemoryBench({
      fixture: FIXTURE,
      runsDir,
      sample: { seed: "seed-1", cap: 5 },
    });
    await expect(
      runMemoryBench({
        fixture: FIXTURE,
        runsDir,
        resume: first.run_id,
        sample: { seed: "seed-1", cap: 3 },
      }),
    ).rejects.toThrow(/run identity mismatch/);
    // And so does resuming a sampled run with no sampling options.
    await expect(
      runMemoryBench({ fixture: FIXTURE, runsDir, resume: first.run_id }),
    ).rejects.toThrow(/run identity mismatch/);
  }, 30_000);

  test("a passing run publishes exactly the report shape it always had", async () => {
    const report = await runMemoryBench({ fixture: FIXTURE, runsDir });
    // The guards add no field: the serialized top-level key order IS the
    // published shape a baseline diffs.
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
    // The quality family is the shared aggregation, by construction.
    const counts = countQuestionResults(report.questions);
    expect(report.quality.passed).toBe(counts.passed);
    expect(report.quality.total).toBe(counts.total);
    expect(report.quality.by_category).toEqual(counts.byCategory);
    // The published file equals the returned report, JSON for JSON.
    const onDisk = JSON.parse(
      readFileSync(join(runsDir, report.run_id, "report.json"), "utf8"),
    ) as unknown;
    expect(onDisk).toEqual(JSON.parse(JSON.stringify(report)));
  }, 30_000);

  test("a passing run writes zero stdout from the guards", async () => {
    const writes: string[] = [];
    const original = process.stdout.write;
    process.stdout.write = ((chunk?: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      await runMemoryBench({ fixture: FIXTURE, runsDir });
    } finally {
      process.stdout.write = original;
    }
    expect(writes).toEqual([]);
  }, 30_000);
});

/**
 * The integrity guards wired into the pipeline (t_d7ce8baf): refusals
 * fire BEFORE a run directory can exist (config/capability ordering),
 * a fresh-run collision preserves the prior run, a tampered run dir is
 * refused by name before any scoring, and the verb renders the refusal
 * contract `refused (<kind>): <detail>` on stderr with a nonzero exit.
 */
describe("the integrity guards wired in", () => {
  test("a traversal --resume id is refused before any run state exists", async () => {
    // Findings 30 + 31 end to end: the raw `--resume ..` value must be
    // refused by name by the preflight's run-id guard, never answered by
    // whatever the parent directory happens to hold, and no run state may
    // exist when it is.
    await expect(runMemoryBench({ fixture: FIXTURE, runsDir, resume: ".." })).rejects.toThrow(
      /all dots/,
    );
    expect(readdirSync(runsDir)).toEqual([]);
  });

  test("an env-garbage provider refusal leaves no run dir behind", async () => {
    const envKey = "OPEN_SECOND_BRAIN_EMBEDDING_PROVIDER";
    process.env[envKey] = "no-such-provider";
    try {
      await expect(runMemoryBench({ fixture: FIXTURE, runsDir })).rejects.toThrow(
        /embedding_provider must be/,
      );
    } finally {
      delete process.env[envKey];
    }
    expect(readdirSync(runsDir)).toEqual([]);
  }, 30_000);

  test("a capability-gate refusal leaves no run dir behind", async () => {
    await expect(
      runMemoryBench({
        fixture: FIXTURE,
        runsDir,
        pinnedKnobs: { semantic: { enabled: true, provider: "local" } },
      }),
    ).rejects.toThrow(/embeddings capability/);
    expect(readdirSync(runsDir)).toEqual([]);
  }, 30_000);

  test("a fresh-run collision is refused by name and the prior checkpoint survives", async () => {
    // The injected clock is the point: run ids are second-precision
    // timestamp + identity hex, so a wall-clock pair of back-to-back runs
    // collides only when both mint inside the same second - a race this
    // test lost about one full-suite run in fifty. One fixed instant for
    // both runs makes the collision a fact of the fixture, not of the
    // wall clock.
    const now = new Date("2026-06-03T12:00:00Z");
    const first = await runMemoryBench({ fixture: FIXTURE, runsDir, now });
    const checkpointBefore = readFileSync(join(runsDir, first.run_id, "checkpoint.json"), "utf8");
    await expect(runMemoryBench({ fixture: FIXTURE, runsDir, now })).rejects.toThrow(
      new RegExp(`refused \\(run_dir_exists\\).*--resume ${first.run_id}`),
    );
    expect(readFileSync(join(runsDir, first.run_id, "checkpoint.json"), "utf8")).toBe(
      checkpointBefore,
    );
    // The refused second run left no run dir of its own.
    expect(readdirSync(runsDir)).toEqual([first.run_id]);
    // And resuming the very same run keeps working.
    const resumed = await runMemoryBench({ fixture: FIXTURE, runsDir, resume: first.run_id, now });
    expect(resumed.run_id).toBe(first.run_id);
  }, 60_000);

  test("ingest-done with the vault deleted is refused before any scoring", async () => {
    // A partial run: only ingest is checkpointed, then the disposable
    // vault disappears. Retrieval against the emptied vault would score
    // an empty corpus and publish ordinary FAILs - refused by name.
    const run = createBenchRun(runsDir, FIXTURE, { now: new Date("2026-06-03T12:00:00Z") });
    completeBenchPhase(run.runDir, run.checkpoint, "ingest");
    rmSync(join(run.runDir, "vault"), { recursive: true, force: true });
    await expect(runMemoryBench({ fixture: FIXTURE, runsDir, resume: run.runId })).rejects.toThrow(
      /refused \(run_artifact_missing\)/,
    );
    // Refused before scoring: no results and no report exist.
    expect(existsSync(join(run.runDir, "results"))).toBe(false);
    expect(existsSync(join(run.runDir, "report.json"))).toBe(false);
  }, 30_000);

  test("retrieve-done with a result file deleted is refused naming the file", async () => {
    const first = await runMemoryBench({ fixture: FIXTURE, runsDir });
    rmSync(join(runsDir, first.run_id, "results", "q-multi.json"));
    await expect(
      runMemoryBench({ fixture: FIXTURE, runsDir, resume: first.run_id }),
    ).rejects.toThrow(/refused \(run_artifact_missing\).*q-multi\.json/s);
  }, 60_000);

  test("the bench verb renders the refusal contract and exits nonzero", async () => {
    // Deterministic refusal #1: the runs dir is a FILE, so the preflight's
    // usability probe refuses before anything is created.
    const fixturePath = join(runsDir, "fixture.json");
    writeFileSync(
      fixturePath,
      JSON.stringify({
        name: "refusal-render",
        notes: [{ path: "Brain/notes/a.md", body: "alpha note body" }],
        questions: [
          {
            id: "q1",
            category: "single_hop",
            query: "alpha",
            expected_paths: ["Brain/notes/a.md"],
          },
        ],
      }),
    );
    const blockedRunsDir = join(runsDir, "blocked-runs");
    writeFileSync(blockedRunsDir, "not a directory");
    const stderr: string[] = [];
    const stdout: string[] = [];
    const originalErr = process.stderr.write;
    const originalOut = process.stdout.write;
    process.stderr.write = ((chunk?: unknown) => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    process.stdout.write = ((chunk?: unknown) => {
      stdout.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      const code = await cmdBrainBench([
        "memory",
        "--fixture",
        fixturePath,
        "--runs-dir",
        blockedRunsDir,
      ]);
      expect(code).not.toBe(0);
      // Scenario #1's render is asserted before the buffer is reused.
      expect(stderr.join("")).toContain("refused (runs_dir_unusable)");
      // Deterministic refusal #2: resuming a run whose checkpoint is corrupt.
      const brokenDir = join(runsDir, "broken-runs");
      const { createBenchRun: create } = await import("../../../src/core/bench/run-store.ts");
      const broken = create(
        brokenDir,
        parseBenchFixture(JSON.parse(readFileSync(fixturePath, "utf8"))),
        {
          now: new Date("2026-06-03T12:00:00Z"),
        },
      );
      writeFileSync(join(broken.runDir, "checkpoint.json"), "{not json");
      stderr.length = 0;
      const corruptCode = await cmdBrainBench([
        "memory",
        "--fixture",
        fixturePath,
        "--runs-dir",
        brokenDir,
        "--resume",
        broken.runId,
      ]);
      expect(corruptCode).not.toBe(0);
    } finally {
      process.stderr.write = originalErr;
      process.stdout.write = originalOut;
    }
    expect(stderr.join("")).toContain("refused (checkpoint_unparseable)");
    // Refusals are stderr-only: stdout stays byte-empty for both.
    expect(stdout.join("")).toBe("");
  }, 30_000);
});

describe("the embeddings capability path", () => {
  // Lexically disjoint notes, so the semantic lane cannot reorder a gold
  // path below an unrelated one and the assertions stay about the
  // capability machinery, not about fusion tuning.
  const SEMANTIC_FIXTURE = parseBenchFixture({
    name: "embedding-capability",
    notes: [
      {
        path: "Brain/notes/rust.md",
        body: "# Systems language\n\nThe systems team standardized on Rust for the new ingest service. Rust ownership keeps the parser safe.\n",
      },
      {
        path: "Brain/notes/piano.md",
        body: "# Evening hobby\n\nThe operator practices piano on weekends and prefers nocturnes. Piano practice happens after dinner.\n",
      },
    ],
    continuity: [],
    questions: [
      {
        id: "q-rust",
        category: "single_hop",
        query: "systems programming language for the ingest service",
        top_k: 5,
        expected_paths: ["Brain/notes/rust.md"],
      },
      {
        id: "q-piano",
        category: "single_hop",
        query: "weekend instrument hobby",
        top_k: 5,
        expected_paths: ["Brain/notes/piano.md"],
      },
    ],
  });
  const CAPABILITIES = { embeddings: true } as const;
  const SEMANTIC_PIN: BenchPinnedKnobs = { semantic: { enabled: true, provider: "local" } };

  test("a semantic pin without the embeddings capability is a named error", async () => {
    await expect(
      runMemoryBench({ fixture: SEMANTIC_FIXTURE, runsDir, pinnedKnobs: SEMANTIC_PIN }),
    ).rejects.toThrow(/embeddings capability/);
  }, 30_000);

  test("a blocked embedding spend gate is refused by name, never bypassed", async () => {
    const pin: BenchPinnedKnobs = {
      semantic: {
        enabled: true,
        provider: "openai-compat",
        baseUrl: "http://127.0.0.1:9",
        model: "bench-unpriced-model",
        apiKey: FAKE_PROVIDER_KEY,
        costGateUsd: 1,
      },
    };
    // The unpriced model under a positive gate is refused before any
    // provider contact: the run fails loudly instead of embedding anyway.
    await expect(
      runMemoryBench({
        fixture: SEMANTIC_FIXTURE,
        runsDir,
        capabilities: CAPABILITIES,
        pinnedKnobs: pin,
      }),
    ).rejects.toThrow(/spend gate/);
  }, 30_000);

  test("the capability builds the index through the apply gate and surfaces the spend plan", async () => {
    const report = await runMemoryBench({
      fixture: SEMANTIC_FIXTURE,
      runsDir,
      capabilities: CAPABILITIES,
      pinnedKnobs: SEMANTIC_PIN,
    });
    expect(report.quality.passed).toBe(report.quality.total);
    const receipt = report.embeddings;
    expect(receipt).toBeDefined();
    expect(receipt!.provider).toBe("local");
    expect(receipt!.model).toBe(LOCAL_EMBEDDING_MODEL);
    expect(receipt!.signature).toBe(`local:${LOCAL_EMBEDDING_MODEL}:${LOCAL_DEFAULT_DIMENSION}::`);
    expect(receipt!.planned).toBeGreaterThan(0);
    expect(receipt!.cache_hits).toBe(0);
    expect(receipt!.cache_misses).toBe(receipt!.planned);
    expect(receipt!.gate).toEqual({ blocked: false, reason: null });
    // The surfaced plan lands as a run artifact beside report.json.
    const receiptOnDisk = JSON.parse(
      readFileSync(join(runsDir, report.run_id, "embeddings.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(receiptOnDisk).toEqual(receipt as unknown as Record<string, unknown>);
    // The shared cache lives under the runs dir, entries keyed by
    // provider, model, dimension and text hash.
    const cache = JSON.parse(readFileSync(join(runsDir, "embedding-cache.json"), "utf8")) as {
      entries: Record<string, ReadonlyArray<number>>;
    };
    const keys = Object.keys(cache.entries);
    expect(keys.length).toBeGreaterThan(0);
    const keyPattern = new RegExp(`^${receipt!.signature}\\|[0-9a-f]{64}$`);
    for (const key of keys) {
      expect(key).toMatch(keyPattern);
      expect(cache.entries[key]!.length).toBe(LOCAL_DEFAULT_DIMENSION);
    }
  }, 30_000);

  test("vector cache keys differ when only the prefix pins differ", () => {
    // The stored bytes depend on the prefixes the provider prepends, so
    // two arms that differ only in prefix pins must never share an entry.
    const base = benchEmbeddingSignature("local", "m", 384, "", "");
    const prefixed = benchEmbeddingSignature("local", "m", 384, "search: ", "passage: ");
    expect(base).not.toBe(prefixed);
    expect(benchVectorCacheKey(base, "same text")).not.toBe(
      benchVectorCacheKey(prefixed, "same text"),
    );
    // Case and surrounding whitespace canonicalize away, as everywhere
    // else the signature tokens are compared.
    expect(benchEmbeddingSignature("Local", "m", 384, "", "")).toBe(base);
  });

  test("a second arm reuses the shared cache and stores byte-identical vectors", async () => {
    const t0 = new Date("2026-06-01T00:00:00.000Z");
    const first = await runMemoryBench({
      fixture: SEMANTIC_FIXTURE,
      runsDir,
      capabilities: CAPABILITIES,
      pinnedKnobs: SEMANTIC_PIN,
      now: t0,
    });
    const cacheAfterFirst = readFileSync(join(runsDir, "embedding-cache.json"), "utf8");
    const second = await runMemoryBench({
      fixture: SEMANTIC_FIXTURE,
      runsDir,
      capabilities: CAPABILITIES,
      pinnedKnobs: SEMANTIC_PIN,
      now: new Date(t0.getTime() + 60_000),
    });
    expect(second.run_id).not.toBe(first.run_id);
    expect(second.embeddings!.cache_misses).toBe(0);
    expect(second.embeddings!.cache_hits).toBe(first.embeddings!.planned);
    // Arm 2 rewrote the cache from its own store read-back: identical
    // bytes prove the stored vectors equal arm 1's, element for element.
    expect(readFileSync(join(runsDir, "embedding-cache.json"), "utf8")).toBe(cacheAfterFirst);
  }, 30_000);

  test("a shared cache written under another schema is refused, never honored", async () => {
    const cachePath = join(runsDir, "embedding-cache.json");
    // Each attempt takes its own minute: run ids are second-precision, so
    // two fresh same-identity runs in one second are a collision refusal
    // now (P2) - the days of silently resetting an existing run dir.
    let attempt = 0;
    const run = () => {
      const now = new Date(Date.UTC(2026, 5, 1, 0, attempt++, 0));
      return runMemoryBench({
        fixture: SEMANTIC_FIXTURE,
        runsDir,
        capabilities: CAPABILITIES,
        pinnedKnobs: SEMANTIC_PIN,
        now,
      });
    };
    writeFileSync(
      cachePath,
      `${JSON.stringify({ schema: "some.other.vectors.v9", entries: {} }, null, 2)}\n`,
      "utf8",
    );
    await expect(run()).rejects.toThrow(
      /schema 'some\.other\.vectors\.v9', expected 'o2b\.bench\.vectors\.v1'/,
    );
    // Every writer stamps the schema, so a missing one is foreign state
    // too - not an older generation to silently adopt.
    writeFileSync(cachePath, `${JSON.stringify({ entries: {} }, null, 2)}\n`, "utf8");
    await expect(run()).rejects.toThrow(/schema 'undefined'/);
  }, 30_000);

  test("the latency family reports overlapped_ms when questions attempted the semantic lane", async () => {
    const report = await runMemoryBench({
      fixture: SEMANTIC_FIXTURE,
      runsDir,
      capabilities: CAPABILITIES,
      pinnedKnobs: SEMANTIC_PIN,
    });
    expect(report.quality.passed).toBe(report.quality.total);
    const semanticQuestions = report.questions.filter((q) => q.category === "single_hop");
    expect(semanticQuestions.length).toBeGreaterThan(0);
    for (const question of semanticQuestions) {
      expect(question.overlapped_ms).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(question.overlapped_ms)).toBe(true);
    }
    expect(report.latency_ms.overlapped_ms).toBeGreaterThanOrEqual(0);
  }, 30_000);

  test("a keyword-only run adds no overlapped_ms keys to the report", async () => {
    const report = await runMemoryBench({ fixture: FIXTURE, runsDir });
    // No question attempted the semantic lane, so no question carries the
    // figure - the latency block keeps exactly the keys it always had.
    expect(report.questions.every((q) => q.overlapped_ms === undefined)).toBe(true);
    expect(JSON.parse(JSON.stringify(report.latency_ms))).toEqual(
      expect.objectContaining({ avg: expect.any(Number), max: expect.any(Number) }),
    );
    expect(Object.keys(report.latency_ms).toSorted()).toEqual(["avg", "max"]);
  }, 30_000);
});
