/**
 * The four-failure-mode conformance suite (t_72d6eb23).
 *
 * Each test drives shipped code over a controlled vault. What ships by
 * DEFAULT and what is measured here are not the same thing, and the
 * difference is asserted rather than assumed: `recall_inject_enabled` is
 * off by default (the bench calls the decision core directly), and
 * `integrity.owner_scope_delivery` is off by default (the fixture turns it
 * to `fail`, and a negative control below proves the gate is what does the
 * isolating).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadBenchFixture,
  materializeBenchVault,
  parseBenchFixture,
} from "../../../src/core/bench/fixture.ts";
import {
  benchRecallRetriever,
  classifyRecallDecision,
  isolationViolations,
  RECALL_FAILURE,
  scoreProactiveRecall,
  type RecallFailure,
} from "../../../src/core/bench/failure-modes.ts";
import { benchSearchConfig, runMemoryBench } from "../../../src/core/bench/phases.ts";
import type { BenchFixture } from "../../../src/core/bench/types.ts";
import {
  decideRecallInject,
  RECALL_INJECT_CONFIDENCE_FLOOR,
  type RecallResultSet,
} from "../../../src/core/brain/recall-inject.ts";
import { resolveSearchConfig, search } from "../../../src/core/search/index.ts";

const FIXTURE_PATH = join("tests", "fixtures", "bench", "failure-modes.json");

let runsDir: string;

beforeEach(() => {
  runsDir = mkdtempSync(join(tmpdir(), "o2b-bench-failure-modes-"));
});

afterEach(() => {
  rmSync(runsDir, { recursive: true, force: true });
});

function fixture(): BenchFixture {
  return loadBenchFixture(FIXTURE_PATH);
}

/**
 * The degenerate retriever a gaming implementation ships: hand back your
 * best note whatever was asked. Paired with a floor of 0 it is the
 * "always inject" arm - not a stub, but the real shape of the strategy
 * the scorer has to be able to rank below a selective one.
 */
async function alwaysConfident(): Promise<RecallResultSet> {
  return Object.freeze({
    candidates: Object.freeze([
      Object.freeze({
        path: "Brain/notes/pgbouncer.md",
        title: "Connection pooling",
        score: 1,
        searchType: "keyword",
        startLine: 1,
        endLine: 3,
      }),
    ]),
    total: 1,
  });
}

/** Both rates share one denominator, so their sum is what ranks strategies. */
function totalFailureRate(score: {
  know_to_ask_failure_rate: number;
  false_fire_rate: number;
}): number {
  return score.know_to_ask_failure_rate + score.false_fire_rate;
}

describe("the committed failure-mode fixture", () => {
  test("runs green and reports all four metrics", async () => {
    const report = await runMemoryBench({ fixture: fixture(), runsDir });
    expect(report.quality.passed).toBe(report.quality.total);
    expect(report.quality.by_category["proactive_recall"]).toEqual({ passed: 4, total: 4 });
    expect(report.quality.by_category["write_fidelity"]).toEqual({ passed: 2, total: 2 });
    expect(report.quality.by_category["source_isolation"]).toEqual({ passed: 1, total: 1 });
    expect(report.failure_modes.know_to_ask_failure_rate).toBe(0);
    expect(report.failure_modes.false_fire_rate).toBe(0);
    expect(report.failure_modes.source_isolation_violations).toBe(0);
    // The fourth metric is a COST, so it lives in the cost family.
    expect(report.context_cost.avg_injected_tokens).toBeGreaterThan(0);
  }, 60_000);

  test("is deterministic: two independent runs agree on every metric", async () => {
    // Separate run directories, so the second run genuinely redoes the
    // work instead of resuming the first one's checkpoints.
    const otherRunsDir = mkdtempSync(join(tmpdir(), "o2b-bench-failure-modes-b-"));
    const first = await runMemoryBench({ fixture: fixture(), runsDir });
    const second = await runMemoryBench({ fixture: fixture(), runsDir: otherRunsDir });
    rmSync(otherRunsDir, { recursive: true, force: true });
    expect(second.fixture_hash).toBe(first.fixture_hash);
    expect(second.quality).toEqual(first.quality);
    expect(second.failure_modes).toEqual(first.failure_modes);
    expect(second.context_cost).toEqual(first.context_cost);
  }, 60_000);
});

describe("the harness holds its own determinism", () => {
  test("a shell configured for semantic search still resolves the CI lane", () => {
    // `resolveSearchConfig` reads `process.env`, so before the override
    // the harness's "deterministic and network-free" claim was a property
    // of an unset developer shell: a configured semantic lane is a second
    // ranking signal, and on a remote provider a network call.
    const previous = {
      semantic: process.env["OPEN_SECOND_BRAIN_SEARCH_SEMANTIC"],
      provider: process.env["OPEN_SECOND_BRAIN_EMBEDDING_PROVIDER"],
    };
    try {
      process.env["OPEN_SECOND_BRAIN_SEARCH_SEMANTIC"] = "1";
      process.env["OPEN_SECOND_BRAIN_EMBEDDING_PROVIDER"] = "openai-compat";
      expect(resolveSearchConfig({ vault: runsDir }).semantic.enabled).toBe(true);
      // Same shell, same vault - the harness refuses the lane anyway.
      expect(benchSearchConfig(runsDir).semantic.enabled).toBe(false);
    } finally {
      for (const [key, value] of [
        ["OPEN_SECOND_BRAIN_SEARCH_SEMANTIC", previous.semantic],
        ["OPEN_SECOND_BRAIN_EMBEDDING_PROVIDER", previous.provider],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

describe("metric 1: proactive know-to-ask, with the anti-gaming term", () => {
  test("an always-inject strategy scores worse than one that abstains correctly", async () => {
    // Both arms run the SAME shipped decision core over the SAME prompts
    // and are scored by the SAME scorer. Only the retriever and the
    // confidence floor differ, which is exactly what separates a memory
    // that knows when to speak from one that always speaks.
    const vault = join(runsDir, "vault");
    const loaded = fixture();
    materializeBenchVault(loaded, vault);
    const config = resolveSearchConfig({
      vault,
      overrides: { semantic: { enabled: false } },
    });
    await search(config, { query: "warmup", limit: 1 });

    const prompts = loaded.questions.filter((q) => q.category === "proactive_recall");
    expect(prompts.length).toBeGreaterThan(0);

    const shipped: Array<RecallFailure | null> = [];
    const always: Array<RecallFailure | null> = [];
    for (const question of prompts) {
      const expectInject = question.expect_inject === true;
      // oxlint-disable-next-line no-await-in-loop
      shipped.push(
        classifyRecallDecision(
          expectInject,
          // oxlint-disable-next-line no-await-in-loop
          await decideRecallInject(question.prompt ?? "", benchRecallRetriever(config, 4)),
        ),
      );
      always.push(
        classifyRecallDecision(
          expectInject,
          // oxlint-disable-next-line no-await-in-loop
          await decideRecallInject(question.prompt ?? "", alwaysConfident, {
            confidenceFloor: 0,
          }),
        ),
      );
    }

    const shippedScore = scoreProactiveRecall(shipped);
    const alwaysScore = scoreProactiveRecall(always);

    // The shipped strategy is right on both halves of the fixture.
    expect(shippedScore.know_to_ask_failure_rate).toBe(0);
    expect(shippedScore.false_fire_rate).toBe(0);
    // The gaming strategy buys a perfect know-to-ask rate and pays for it
    // in false fires - which is the whole point of carrying that term.
    expect(alwaysScore.know_to_ask_failure_rate).toBe(0);
    expect(alwaysScore.false_fire_rate).toBeGreaterThan(0);
    // Shared denominator, so the total failure rate is what ranks them.
    expect(totalFailureRate(alwaysScore)).toBeGreaterThan(totalFailureRate(shippedScore));
  }, 60_000);

  test("the anti-gaming pressure is on the confidence floor, not on the gate", () => {
    // `evaluateSurfacingGate` fails open by design, so it can carry no
    // pressure; the floor is the only discriminating bound the decision
    // core exposes, and the scorer is denominated so that using it wrong
    // costs something.
    expect(RECALL_INJECT_CONFIDENCE_FLOOR).toBeGreaterThan(0);
    const allWrong = scoreProactiveRecall([RECALL_FAILURE.falseFire, RECALL_FAILURE.falseFire]);
    expect(allWrong.false_fire_rate).toBe(1);
    // A fault is charged to neither rate: a broken retriever is not a
    // cautious one, and folding it in would report a number about the
    // harness under a name that promises a number about memory.
    const faulted = scoreProactiveRecall([RECALL_FAILURE.faulted, null]);
    expect(faulted.know_to_ask_failure_rate).toBe(0);
    expect(faulted.false_fire_rate).toBe(0);
    expect(faulted.faults).toBe(1);
  });
});

describe("metric 2: write-back fidelity on the shipped path", () => {
  test("grades provenance with no model call, and a lost field fails", async () => {
    const loaded = fixture();
    const broken = parseBenchFixture({
      ...(JSON.parse(JSON.stringify(loaded)) as Record<string, unknown>),
      name: "write-fidelity-missing-provenance",
      questions: [
        {
          id: "q-fidelity-demands-a-field-the-path-does-not-write",
          category: "write_fidelity",
          intake_text: "Decision: Cap the pool at ninety connections.",
          expected_labels: ["decision"],
          expected_provenance: ["dedupe_key", "confidence_score"],
        },
      ],
    });
    const report = await runMemoryBench({ fixture: broken, runsDir });
    expect(report.quality.passed).toBe(0);
    expect(report.questions[0]!.failure).toContain("confidence_score");
  }, 60_000);

  test("a non-Latin fixture scores on structure, not on a word list", async () => {
    const report = await runMemoryBench({ fixture: fixture(), runsDir });
    const nonLatin = report.questions.find((q) => q.id === "q-fidelity-non-latin")!;
    expect(nonLatin.pass).toBe(true);
    // And it really did extract - a pass over zero records would be a lie.
    const raw = JSON.parse(
      readFileSync(join(runsDir, report.run_id, "results", "q-fidelity-non-latin.json"), "utf8"),
    ) as { labels: string[]; dedup_stable: boolean };
    expect(raw.labels).toEqual(["решение", "открытый_вопрос"]);
    expect(raw.dedup_stable).toBe(true);
  }, 60_000);
});

describe("metric 3: cross-source isolation gates at zero, non-vacuously", () => {
  test("the strict gate is what isolates: without it the same fixture leaks", async () => {
    const loaded = JSON.parse(JSON.stringify(fixture())) as {
      notes: Array<{ path: string }>;
      questions: Array<{ category: string }>;
    };
    const defaultGate = parseBenchFixture({
      ...loaded,
      name: "failure-modes-shipped-default-gate",
      notes: loaded.notes.filter((note) => note.path !== "Brain/_brain.yaml"),
      questions: loaded.questions.filter((q) => q.category === "source_isolation"),
    });
    const report = await runMemoryBench({ fixture: defaultGate, runsDir });
    // Under the shipped `off` default no scope is evaluated at all, so the
    // other agent's memory is delivered. A gate asserted under that
    // default would pass for a reason that has nothing to do with
    // isolation, which is why the fixture sets `fail`.
    expect(report.failure_modes.source_isolation_violations).toBe(1);
    expect(report.questions[0]!.failure).toContain("pref-other");
  }, 60_000);

  test("the assertion reads delivered contents, never the hidden counter", () => {
    // `hiddenByOwnerScope` counts DELIVERED items under `warn` and is
    // withheld entirely under `fail`, so it cannot serve as a violation
    // numerator. The scorer takes ids that came back.
    expect(isolationViolations(["a", "b"], ["b", "c"])).toEqual(["b"]);
    expect(isolationViolations(["a"], ["b"])).toEqual([]);
  });

  test("isolation that withholds the caller's own memory is also a failure", async () => {
    const loaded = JSON.parse(JSON.stringify(fixture())) as Record<string, unknown>;
    const overreaching = parseBenchFixture({
      ...loaded,
      name: "failure-modes-overreaching-scope",
      questions: [
        {
          id: "q-isolation-must-not-narrow",
          category: "source_isolation",
          // Nobody owns this scope, so `pref-own` is correctly withheld -
          // and demanding it back proves the converse invariant is armed.
          agent_scope: "agent-z",
          expected_ids: ["pref-own"],
          forbidden_ids: ["pref-other"],
          max_tokens: 500,
        },
      ],
    });
    const report = await runMemoryBench({ fixture: overreaching, runsDir });
    expect(report.quality.passed).toBe(0);
    expect(report.questions[0]!.failure).toContain("pref-own");
    expect(report.failure_modes.source_isolation_violations).toBe(0);
  }, 60_000);
});

describe("metric 4: exactly one token estimator is reachable from the bench", () => {
  const BENCH_DIR = join("src", "core", "bench");

  function benchSources(): ReadonlyArray<{ file: string; code: string }> {
    return readdirSync(BENCH_DIR)
      .filter((file) => file.endsWith(".ts"))
      .map((file) => ({
        file,
        code: readFileSync(join(BENCH_DIR, file), "utf8")
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/^\s*\/\/.*$/gm, ""),
      }));
  }

  test("the one estimator is imported once, from the shared tokenizer", () => {
    const importers = benchSources().filter(({ code }) => code.includes("estimateTokens"));
    expect(importers.map(({ file }) => file)).toEqual(["failure-modes.ts"]);
    expect(importers[0]!.code).toContain('from "../brain/text/tokenizer.ts"');
  });

  test("no second estimator survives anywhere in the bench", () => {
    // This repo carries five disagreeing estimators, two of which export
    // the SAME name from different modules - so the check is on the import
    // path and on the arithmetic, never on the identifier alone.
    for (const { file, code } of benchSources()) {
      expect(`${file}: ${code}`).not.toContain("embeddings/signature.ts");
      expect(`${file}: ${code}`).not.toContain("CHARS_PER_ESTIMATED_TOKEN");
      expect(`${file}: ${code}`).not.toContain("countTokens");
      // The inline `ceil(chars / 4)` the report used to carry.
      expect(code).not.toMatch(/\/\s*4\s*[);]/);
    }
  });
});
