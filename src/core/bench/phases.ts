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
import type { ContinuityRecord } from "../brain/continuity/types.ts";
import { extractPreCompactRecords } from "../brain/pre-compact-extract.ts";
import {
  decideRecallInject,
  RECALL_INJECT_MAX_NOTES,
  type RecallInjectDecision,
} from "../brain/recall-inject.ts";
import { resolveSearchConfig, search } from "../search/index.ts";
import {
  benchRecallRetriever,
  classifyRecallDecision,
  injectedTokens,
  isolationViolations,
  scoreProactiveRecall,
  type RecallFailure,
} from "./failure-modes.ts";
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
  /** Pack item ids (budget, source_isolation). */
  readonly item_ids?: ReadonlyArray<string>;
  /** Characters of context this question injected, when it injected any. */
  readonly context_chars?: number;
  /** `estimateTokens` over the same string `context_chars` measured. */
  readonly injected_tokens?: number;
  /** The decision core's verdict, verbatim (proactive_recall). */
  readonly recall_decision?: RecallInjectDecision;
  /** Normalized label tokens the extractor recovered (write_fidelity). */
  readonly labels?: ReadonlyArray<string>;
  /** Provenance keys present on every extracted record (write_fidelity). */
  readonly provenance_keys?: ReadonlyArray<string>;
  /** Whether a second identical extraction produced the same record ids. */
  readonly dedup_stable?: boolean;
}

/**
 * The search configuration every phase uses.
 *
 * `resolveSearchConfig` still reads `process.env`, and overrides are
 * applied last and win, so pinning the semantic lane off here is what
 * makes the harness's network-freedom an invariant instead of an
 * inherited accident. Pinning it OFF rather than onto the offline
 * `LocalProvider` is deliberate: the bench's scoring is keyword
 * containment, so an embedding lane would add a second ranking signal to
 * a number nobody asked to include, and cost time for it.
 *
 * Exported so the invariant is assertable directly. It has to be: a test
 * that sets the env vars and compares two reports passes whether or not
 * the override is there, because reaching the embedding lane also needs
 * an index built with embeddings, which this harness does not build. The
 * resolved config is where the difference is real, so that is what the
 * test reads.
 *
 * One residual, named rather than implied: `resolveSearchConfig` parses
 * the provider name BEFORE merging overrides, so an env var naming a
 * provider it does not recognise makes this throw. That is a loud, named
 * failure rather than a silently different bench.
 */
export function benchSearchConfig(vault: string): ReturnType<typeof resolveSearchConfig> {
  return resolveSearchConfig({ vault, overrides: { semantic: { enabled: false } } });
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
    const config = benchSearchConfig(vault);
    await search(config, { query: "warmup", limit: 1 });
    checkpoint = completeBenchPhase(run.runDir, checkpoint, "index");
  }

  // Phase: retrieve - run every question once, persist raw results.
  if (!phaseDone(checkpoint, "retrieve")) {
    const config = benchSearchConfig(vault);
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
  if (question.category === "proactive_recall") {
    // The shipped decision core, driven directly over the fixture vault.
    // The retriever is a PARAMETER of that function, which is the only
    // reason this is measurable offline at all.
    const decision = await decideRecallInject(
      question.prompt ?? "",
      benchRecallRetriever(config, question.top_k ?? RECALL_INJECT_MAX_NOTES),
    );
    // An abstain injects nothing, and zero is the honest cost of nothing -
    // not an absent measurement.
    const brief = decision.kind === "inject" ? decision.brief : "";
    return {
      id: question.id,
      latency_ms: Date.now() - startedAt,
      recall_decision: decision,
      context_chars: brief.length,
      injected_tokens: injectedTokens(brief),
    };
  }
  if (question.category === "write_fidelity") {
    return retrieveWriteFidelity(vault, question, startedAt);
  }
  // budget and source_isolation both deliver a context pack; the
  // isolation question additionally requests an owner scope, which is
  // only honoured when the fixture's `Brain/_brain.yaml` sets
  // `integrity.owner_scope_delivery: fail` - the shipped default is
  // `off`, under which no scope is evaluated and the question is vacuous.
  const pack = packContext(vault, {
    maxTokens: question.max_tokens ?? 1000,
    ...(question.max_total_chars !== undefined ? { maxTotalChars: question.max_total_chars } : {}),
    ...(question.agent_scope !== undefined ? { agentScope: question.agent_scope } : {}),
  });
  const body = pack.items.map((item) => item.body).join("\n");
  return {
    id: question.id,
    latency_ms: Date.now() - startedAt,
    item_ids: pack.items.map((item) => item.id),
    context_chars: body.length,
    injected_tokens: injectedTokens(body),
  };
}

/**
 * Run the shipped write path twice over the same intake and record what
 * survived.
 *
 * Twice on purpose: the second pass is the dedup measurement. Extraction
 * keys on (session, turn range, label, content hash), so a faithful write
 * path must return the SAME record ids the second time and append
 * nothing. A path that re-appends looks identical on a single run.
 *
 * No model is called, and none could be: the server never calls one on
 * any write path. What the fixture supplies is the structured intake that
 * stands in for an agent's distillation.
 */
function retrieveWriteFidelity(
  vault: string,
  question: BenchQuestion,
  startedAt: number,
): RetrievedQuestion {
  const input = {
    sessionId: `bench-${question.id}`,
    turnStart: "turn-1",
    turnEnd: "turn-2",
    text: question.intake_text ?? "",
    createdAt: BENCH_WRITE_FIDELITY_INSTANT,
  };
  const first = extractPreCompactRecords(vault, input);
  const second = extractPreCompactRecords(vault, input);
  const provenance = new Set<string>(first.records.flatMap(provenanceKeys));
  return {
    id: question.id,
    latency_ms: Date.now() - startedAt,
    labels: first.records.map((record) => String(record.payload["extract_type"] ?? "")),
    // Present on EVERY record, not on any: a provenance field that
    // survives only sometimes has not survived.
    provenance_keys: [...provenance].filter((key) =>
      first.records.every((record) => provenanceKeys(record).includes(key)),
    ),
    dedup_stable:
      first.records.length > 0 &&
      JSON.stringify(first.records.map((r) => r.id)) ===
        JSON.stringify(second.records.map((r) => r.id)),
  };
}

/**
 * Every provenance name one extracted record carries.
 *
 * Both levels count: the record envelope carries `id`, `kind`,
 * `createdAt` and `sourceRefs`, and the payload carries the
 * session/turn/hash keys. A fixture asks for either by name.
 */
function provenanceKeys(record: ContinuityRecord): ReadonlyArray<string> {
  return [...Object.keys(record), ...Object.keys(record.payload)];
}

/**
 * Fixed authoring instant for write-fidelity extraction. Extraction
 * defaults `createdAt` to wall clock, which would make the record ids -
 * and therefore the whole report - differ on every run.
 */
const BENCH_WRITE_FIDELITY_INSTANT = "2026-06-01T00:00:00.000Z";

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
    ...(retrieved.injected_tokens !== undefined
      ? { injected_tokens: retrieved.injected_tokens }
      : {}),
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
  if (question.category === "proactive_recall") {
    return evaluateProactiveRecall(question, retrieved, base);
  }
  if (question.category === "write_fidelity") {
    return evaluateWriteFidelity(question, retrieved, base);
  }
  if (question.category === "source_isolation") {
    return evaluateSourceIsolation(question, retrieved, base);
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

/** Shared prefix of every evaluated question, built once by the caller. */
type ResultBase = Pick<
  BenchQuestionResult,
  "id" | "category" | "latency_ms" | "context_chars" | "injected_tokens"
>;

function evaluateProactiveRecall(
  question: BenchQuestion,
  retrieved: RetrievedQuestion,
  base: ResultBase,
): BenchQuestionResult {
  const decision = retrieved.recall_decision;
  if (decision === undefined) {
    return Object.freeze({
      ...base,
      pass: false,
      failure: "no recall decision was persisted for this question",
    });
  }
  const failure = classifyRecallDecision(question.expect_inject === true, decision);
  if (failure === null) return Object.freeze({ ...base, pass: true });
  return Object.freeze({
    ...base,
    pass: false,
    recall_failure: failure,
    failure: `${failure}: decision was ${describeDecision(decision)}`,
  });
}

/** One decision as a diffable one-liner. Classifications only, no prose. */
function describeDecision(decision: RecallInjectDecision): string {
  if (decision.kind === "abstain") return `abstain(${decision.reason})`;
  if (decision.kind === "error") return `error(${decision.fault})`;
  return `inject(${decision.noteCount} notes)`;
}

function evaluateWriteFidelity(
  question: BenchQuestion,
  retrieved: RetrievedQuestion,
  base: ResultBase,
): BenchQuestionResult {
  const labels = retrieved.labels ?? [];
  const expected = question.expected_labels ?? [];
  if (JSON.stringify(labels) !== JSON.stringify(expected)) {
    return Object.freeze({
      ...base,
      pass: false,
      failure: `labels [${labels.join(", ")}] do not match expected [${expected.join(", ")}]`,
    });
  }
  const present = retrieved.provenance_keys ?? [];
  const missing = (question.expected_provenance ?? []).filter((key) => !present.includes(key));
  if (missing.length > 0) {
    return Object.freeze({
      ...base,
      pass: false,
      failure: `provenance lost on the write path: ${missing.join(", ")}`,
    });
  }
  if (retrieved.dedup_stable !== true) {
    return Object.freeze({
      ...base,
      pass: false,
      failure: "a second identical intake did not resolve to the same records",
    });
  }
  return Object.freeze({ ...base, pass: true });
}

function evaluateSourceIsolation(
  question: BenchQuestion,
  retrieved: RetrievedQuestion,
  base: ResultBase,
): BenchQuestionResult {
  const ids = retrieved.item_ids ?? [];
  const leaked = isolationViolations(ids, question.forbidden_ids ?? []);
  if (leaked.length > 0) {
    return Object.freeze({
      ...base,
      pass: false,
      isolation_violations: leaked.length,
      failure: `delivered memory owned by another agent: ${leaked.join(", ")}`,
    });
  }
  // The converse invariant: a scope must isolate without narrowing what
  // the caller legitimately owns. Without this a pack that returned
  // NOTHING would score a perfect isolation result.
  const missing = (question.expected_ids ?? []).filter((id) => !ids.includes(id));
  if (missing.length > 0) {
    return Object.freeze({
      ...base,
      pass: false,
      isolation_violations: 0,
      failure: `scoping withheld the caller's own memory: ${missing.join(", ")}`,
    });
  }
  return Object.freeze({ ...base, pass: true, isolation_violations: 0 });
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
  const avgChars = mean(results.map((result) => result.context_chars));
  // The suite's ONE token number, from the ONE estimator. The inline
  // `ceil(avg_chars / 4)` that stood here was a sixth formula in a repo
  // that already had five, and it did not even import the shared helper -
  // so it disagreed with every token figure the Brain reports. Averaged
  // over the same population as `avg_chars` so the two are comparable.
  const avgInjectedTokens = mean(results.map((result) => result.injected_tokens));
  const recallFailures: ReadonlyArray<RecallFailure | null> = results
    .filter((result) => result.category === "proactive_recall")
    .map((result) => result.recall_failure ?? null);
  const proactive = scoreProactiveRecall(recallFailures);
  const isolationTotal = results.reduce(
    (sum, result) => sum + (result.isolation_violations ?? 0),
    0,
  );
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
      avg_injected_tokens: avgInjectedTokens,
    }),
    failure_modes: Object.freeze({
      know_to_ask_failure_rate: proactive.know_to_ask_failure_rate,
      false_fire_rate: proactive.false_fire_rate,
      source_isolation_violations: isolationTotal,
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

/** Mean over the values that are present, rounded; 0 when none are. */
function mean(values: ReadonlyArray<number | undefined>): number {
  const present = values.filter((value): value is number => typeof value === "number");
  if (present.length === 0) return 0;
  return Math.round(present.reduce((sum, value) => sum + value, 0) / present.length);
}
