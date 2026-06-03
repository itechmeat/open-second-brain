/**
 * Bench phase pipeline (Memory Observability Suite, t_882c396a):
 * ingest -> index -> retrieve -> evaluate -> report.
 *
 * Each phase checkpoints on completion, so a resumed run (same run id,
 * same fixture hash) skips finished work - including the searches:
 * the retrieve phase persists per-question raw results to disk and the
 * evaluate phase works ONLY from those files, never from the live
 * vault. The pipeline drives the public `search` / `packContext` APIs
 * against a disposable vault inside the run directory and never
 * resolves the operator's configured vault. Deterministic and
 * network-free: keyword-only search, no embedding providers, judge
 * optional and external.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { packContext } from "../brain/context-pack.ts";
import { loadNormalizedContinuityRecords } from "../brain/continuity/read-model.ts";
import { resolveSearchConfig, search } from "../search/index.ts";
import { fixtureHash, materializeBenchVault } from "./fixture.ts";
import { runJudge } from "./judge.ts";
import {
  benchResultsDir,
  benchVaultDir,
  completeBenchPhase,
  createBenchRun,
  loadBenchRun,
  phaseDone,
  type BenchRunHandle,
} from "./run-store.ts";
import {
  BENCH_REPORT_SCHEMA,
  RETRIEVAL_CATEGORIES,
  type BenchFixture,
  type BenchQuestion,
  type BenchQuestionResult,
  type BenchReport,
} from "./types.ts";

export interface BenchRunOptions {
  readonly fixture: BenchFixture;
  readonly runsDir: string;
  /** Resume an existing run id; validates the fixture hash first. */
  readonly resume?: string;
  /** Optional external judge command (config bench_judge_cmd). */
  readonly judgeCmd?: string;
  readonly now?: Date;
}

/** Raw per-question record persisted by the retrieve phase. */
interface RetrievedQuestion {
  readonly id: string;
  readonly latency_ms: number;
  /** Result paths in rank order (retrieval categories). */
  readonly paths?: ReadonlyArray<string>;
  /** Normalized turn texts (session_handoff). */
  readonly turn_texts?: ReadonlyArray<string>;
  /** Pack item ids and character count (budget). */
  readonly item_ids?: ReadonlyArray<string>;
  readonly context_chars?: number;
}

export async function runMemoryBench(opts: BenchRunOptions): Promise<BenchReport> {
  const run: BenchRunHandle =
    opts.resume !== undefined
      ? loadBenchRun(opts.runsDir, opts.resume, { expectFixture: opts.fixture })
      : createBenchRun(opts.runsDir, opts.fixture, opts.now ? { now: opts.now } : {});
  let checkpoint = run.checkpoint;
  const vault = benchVaultDir(run.runDir);

  // Phase: ingest - materialize the disposable vault.
  if (!phaseDone(checkpoint, "ingest")) {
    materializeBenchVault(opts.fixture, vault);
    checkpoint = completeBenchPhase(run.runDir, checkpoint, "ingest");
  }

  // Phase: index - one warmup search triggers the store self-heal so
  // the FTS index exists before any timed retrieval.
  if (!phaseDone(checkpoint, "index")) {
    const config = resolveSearchConfig({ vault });
    await search(config, { query: "warmup", limit: 1 });
    checkpoint = completeBenchPhase(run.runDir, checkpoint, "index");
  }

  // Phase: retrieve - run every question once, persist raw results.
  if (!phaseDone(checkpoint, "retrieve")) {
    const config = resolveSearchConfig({ vault });
    mkdirSync(benchResultsDir(run.runDir), { recursive: true });
    // Deliberately sequential: per-question latency_ms must not include
    // contention from sibling searches running on the same store.
    // oxlint-disable-next-line no-await-in-loop
    for (const question of opts.fixture.questions) {
      // oxlint-disable-next-line no-await-in-loop
      const retrieved = await retrieveQuestion(vault, config, question);
      writeFileSync(
        join(benchResultsDir(run.runDir), `${question.id}.json`),
        `${JSON.stringify(retrieved, null, 2)}\n`,
        "utf8",
      );
    }
    checkpoint = completeBenchPhase(run.runDir, checkpoint, "retrieve");
  }

  // Phase: evaluate - pure over the persisted results; no vault access.
  const results = opts.fixture.questions
    .map((question) => evaluateQuestion(question, readRetrieved(run.runDir, question.id)))
    .toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (!phaseDone(checkpoint, "evaluate")) {
    checkpoint = completeBenchPhase(run.runDir, checkpoint, "evaluate");
  }

  // Optional judge (advisory, fail-open), then report.
  const judge = runJudge(opts.judgeCmd, results);
  const report = buildReport(run, opts.fixture, results, judge);
  writeFileSync(join(run.runDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  if (!phaseDone(checkpoint, "report")) {
    completeBenchPhase(run.runDir, checkpoint, "report");
  }
  return report;
}

async function retrieveQuestion(
  vault: string,
  config: ReturnType<typeof resolveSearchConfig>,
  question: BenchQuestion,
): Promise<RetrievedQuestion> {
  const startedAt = Date.now();
  if (RETRIEVAL_CATEGORIES.has(question.category)) {
    const outcome = await search(config, {
      query: question.query ?? "",
      limit: question.top_k ?? 5,
    });
    return {
      id: question.id,
      latency_ms: Date.now() - startedAt,
      paths: outcome.results.map((result) => result.path),
    };
  }
  if (question.category === "session_handoff") {
    const turns = loadNormalizedContinuityRecords(vault, {
      kind: "session_turn",
      ...(question.session_id !== undefined ? { sessionId: question.session_id } : {}),
    });
    return {
      id: question.id,
      latency_ms: Date.now() - startedAt,
      turn_texts: turns.map((turn) =>
        typeof turn.payload["text"] === "string" ? turn.payload["text"] : "",
      ),
    };
  }
  // budget
  const pack = packContext(vault, {
    maxTokens: question.max_tokens ?? 1000,
    ...(question.max_total_chars !== undefined ? { maxTotalChars: question.max_total_chars } : {}),
  });
  return {
    id: question.id,
    latency_ms: Date.now() - startedAt,
    item_ids: pack.items.map((item) => item.id),
    context_chars: pack.items.reduce((sum, item) => sum + item.body.length, 0),
  };
}

function readRetrieved(runDir: string, questionId: string): RetrievedQuestion {
  const path = join(benchResultsDir(runDir), `${questionId}.json`);
  if (!existsSync(path)) {
    throw new Error(`bench run is missing retrieve results for question ${questionId}`);
  }
  return JSON.parse(readFileSync(path, "utf8")) as RetrievedQuestion;
}

function evaluateQuestion(
  question: BenchQuestion,
  retrieved: RetrievedQuestion,
): BenchQuestionResult {
  const base = {
    id: question.id,
    category: question.category,
    latency_ms: retrieved.latency_ms,
    ...(retrieved.context_chars !== undefined ? { context_chars: retrieved.context_chars } : {}),
  };
  if (RETRIEVAL_CATEGORIES.has(question.category)) {
    const paths = retrieved.paths ?? [];
    const missing = (question.expected_paths ?? []).filter((path) => !paths.includes(path));
    if (missing.length > 0) {
      return Object.freeze({
        ...base,
        pass: false,
        failure: `missing expected: ${missing.join(", ")}`,
      });
    }
    const bestExpected = Math.min(
      ...(question.expected_paths ?? []).map((path) => paths.indexOf(path)),
    );
    for (const stale of question.not_expected_above ?? []) {
      const rank = paths.indexOf(stale);
      if (rank !== -1 && rank < bestExpected) {
        return Object.freeze({
          ...base,
          pass: false,
          failure: `stale path ranked above expected: ${stale}`,
        });
      }
    }
    return Object.freeze({ ...base, pass: true });
  }
  if (question.category === "session_handoff") {
    const texts = retrieved.turn_texts ?? [];
    if (question.expected_turns !== undefined && texts.length < question.expected_turns) {
      return Object.freeze({
        ...base,
        pass: false,
        failure: `expected ${question.expected_turns} turns, found ${texts.length}`,
      });
    }
    if (
      question.expected_text !== undefined &&
      !texts.some((text) => text.includes(question.expected_text ?? ""))
    ) {
      return Object.freeze({
        ...base,
        pass: false,
        failure: `expected text not found in session turns: ${question.expected_text}`,
      });
    }
    return Object.freeze({ ...base, pass: true });
  }
  // budget
  const ids = retrieved.item_ids ?? [];
  const missingIds = (question.expected_ids ?? []).filter((id) => !ids.includes(id));
  if (missingIds.length > 0) {
    return Object.freeze({
      ...base,
      pass: false,
      failure: `expected evidence missing from budgeted pack: ${missingIds.join(", ")}`,
    });
  }
  return Object.freeze({ ...base, pass: true });
}

function buildReport(
  run: BenchRunHandle,
  fixture: BenchFixture,
  results: ReadonlyArray<BenchQuestionResult>,
  judge: ReturnType<typeof runJudge>,
): BenchReport {
  const byCategory: Record<string, { passed: number; total: number }> = {};
  let passed = 0;
  for (const result of results) {
    const bucket = (byCategory[result.category] ??= { passed: 0, total: 0 });
    bucket.total += 1;
    if (result.pass) {
      bucket.passed += 1;
      passed += 1;
    }
  }
  const latencies = results.map((result) => result.latency_ms);
  const contextChars = results
    .map((result) => result.context_chars)
    .filter((value): value is number => typeof value === "number");
  const avgChars =
    contextChars.length > 0
      ? Math.round(contextChars.reduce((sum, value) => sum + value, 0) / contextChars.length)
      : 0;
  return Object.freeze({
    schema: BENCH_REPORT_SCHEMA,
    run_id: run.runId,
    fixture: fixture.name,
    fixture_hash: fixtureHash(fixture),
    created_at: run.checkpoint.created_at,
    quality: Object.freeze({
      passed,
      total: results.length,
      pass_rate: results.length > 0 ? round3(passed / results.length) : 0,
      by_category: Object.freeze(
        Object.fromEntries(Object.entries(byCategory).toSorted(([a], [b]) => (a < b ? -1 : 1))),
      ),
    }),
    latency_ms: Object.freeze({
      avg:
        latencies.length > 0
          ? Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length)
          : 0,
      max: latencies.length > 0 ? Math.max(...latencies) : 0,
    }),
    context_cost: Object.freeze({
      avg_chars: avgChars,
      est_tokens: Math.ceil(avgChars / 4),
    }),
    judge: Object.freeze({
      status: judge.status,
      ...(judge.detail !== undefined ? { detail: judge.detail } : {}),
    }),
    questions: Object.freeze(
      results.map((result) =>
        Object.freeze({
          ...result,
          ...(judge.verdicts && result.id in judge.verdicts
            ? { judge_pass: judge.verdicts[result.id] }
            : {}),
        }),
      ),
    ),
  });
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
