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

import { evaluateAttentionFlow, listAttentionFlows } from "../brain/attention-flows.ts";
import { packContext } from "../brain/context-pack.ts";
import { TRANSPORT_REACH } from "../graph/transport-reach.ts";
import { loadNormalizedContinuityRecords } from "../brain/continuity/read-model.ts";
import type { ContinuityRecord } from "../brain/continuity/types.ts";
import { extractPreCompactRecords } from "../brain/pre-compact-extract.ts";
import {
  decideRecallInject,
  RECALL_INJECT_MAX_NOTES,
  type RecallInjectDecision,
} from "../brain/recall-inject.ts";
import { resolveSearchConfig, search } from "../search/index.ts";
import type { SearchLaneTiming } from "../search/index.ts";
import { evaluateSurfacingGate } from "../search/surfacing-gate.ts";
import {
  BENCH_EMBEDDING_RECEIPT_FILENAME,
  embedBenchVaultIndex,
  readBenchEmbeddingReceipt,
} from "./embedding-cache.ts";
import { countQuestionResults, preflightBenchRun, validateBenchTrace } from "./guards.ts";
import {
  benchResultsDir,
  benchRunDirPath,
  benchVaultDir,
  atomicWriteFileSync,
  completeBenchPhase,
  createBenchRun,
  loadBenchRun,
  nextBenchRunId,
  phaseDone,
  type BenchRunHandle,
} from "./run-store.ts";
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
import { LONGMEMEVAL_SUITE_NAME, scoreLongMemEvalRecall } from "./longmemeval.ts";
import {
  BENCH_REPORT_SCHEMA,
  DEFAULT_BENCH_KNOB_PIN,
  RETRIEVAL_CATEGORIES,
  type BenchFixture,
  type BenchEmbeddingReceipt,
  type BenchLongMemEvalFamily,
  type BenchPinnedKnobs,
  type BenchQuestion,
  type BenchQuestionResult,
  type BenchReport,
  type BenchSampleRequest,
  type BenchSuiteCapabilities,
  type BenchSuiteReceipt,
} from "./types.ts";

/**
 * The reach the benchmark harness runs its queries at.
 *
 * Local: a bench run measures this vault's own corpus and hands no page
 * to any caller, so a run that stopped seeing reserved pages would score
 * a smaller vault than the one under test.
 */
const BENCH_REACH = TRANSPORT_REACH.local;
/**
 * The standing-instruction facet category (recall-lane-latency). It is
 * the ONE category the headline quality family excludes: its rate stays
 * the named line of its own in `by_category`.
 */
const STANDING_INSTRUCTION_CATEGORY = "standing_instruction";

export interface BenchRunOptions {
  readonly fixture: BenchFixture;
  readonly runsDir: string;
  /** Registered suite name, when the run goes through a named suite. */
  readonly suite?: string;
  /**
   * What the run's suite may do, set by the CLI verb from the suite
   * registry. Inert on its own: a capability is exercised only when the
   * run's knob pin enables the feature too.
   */
  readonly capabilities?: BenchSuiteCapabilities;
  /**
   * Search-configuration knobs pinned for this run, applied last via
   * `resolveSearchConfig` and folded into the run identity (the
   * checkpoint hash). Absent means {@link DEFAULT_BENCH_KNOB_PIN}.
   */
  readonly pinnedKnobs?: BenchPinnedKnobs;
  /** Resume an existing run id; validates the fixture hash first. */
  readonly resume?: string;
  /**
   * Optional admission floor override for the proactive-recall decisions,
   * passed to the decision core's `confidenceFloor` option, which routes
   * through the shared surfacing calculator. Absent keeps the shipped
   * default (`RECALL_INJECT_CONFIDENCE_FLOOR`). The surfacing-replay
   * suite sweeps this to measure gate calibration.
   *
   * Part of the run identity: a resumed run whose floor changed fails
   * the identity guard instead of deciding the remaining questions under
   * a new floor while the persisted ones keep the old. A floor change
   * takes effect in a fresh run id.
   */
  readonly recallFloor?: number;
  /** Optional external judge command (config bench_judge_cmd). */
  readonly judgeCmd?: string;
  /**
   * The suite loader's conversion receipt, threaded through to the
   * report family - for LongMemEval, how many abstention questions the
   * conversion excluded from scoring.
   */
  readonly suiteReceipt?: BenchSuiteReceipt;
  /**
   * The seeded sampling request the run's fixture was loaded under.
   * The CLI samples at load time, so this folds into the run identity
   * (a resumed run whose sampling options changed fails the guard, even
   * when a cap at or above the population would make the sampled
   * fixtures identical) and is refused up front when malformed - it
   * drives no phase of its own.
   */
  readonly sample?: BenchSampleRequest;
  readonly now?: Date;
}

/** Raw per-question record persisted by the retrieve phase. */
interface RetrievedQuestion {
  readonly id: string;
  readonly latency_ms: number;
  /**
   * Overlapped lane milliseconds (recall-lane-latency), present only when
   * the semantic lane attempted the embed for this question.
   */
  readonly overlapped_ms?: number;
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
  /**
   * The item strings the standing_query sections rendered, annotations
   * included (standing_instruction). The evaluator asserts the expected
   * earliest-cited coordinates against these.
   */
  readonly standing_items?: ReadonlyArray<string>;
  /**
   * Facet keys (`pref:<preference id>`) whose provenance join resolved
   * (standing_instruction). A preference the lane surfaced but could not
   * resolve is honestly absent - never an implied origin.
   */
  readonly facet_ids?: ReadonlyArray<string>;
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
/**
 * The search configuration every phase uses, driven by the run's knob
 * pin.
 *
 * `resolveSearchConfig` still reads `process.env`, and overrides are
 * applied last and win, so the pin is what makes the harness's network-
 * freedom an invariant instead of an inherited accident. The default pin
 * ({@link DEFAULT_BENCH_KNOB_PIN}) is the hardcoded semantic-off override
 * this function always applied - a named value now, so the default run
 * identity is deterministic and locomo report numbers stay identical. A
 * suite that declares the embeddings capability may pin the semantic
 * lane on (the deterministic local provider keeps the run network-free).
 *
 * Exported so the invariant is assertable directly. It has to be: a test
 * that sets the env vars and compares two reports passes whether or not
 * the override is there, because reaching the embedding lane also needs
 * an index built with embeddings, which the default harness does not
 * build. The resolved config is where the difference is real, so that is
 * what the test reads.
 *
 * One residual, named rather than implied: `resolveSearchConfig` parses
 * the provider name BEFORE merging overrides, so an env var naming a
 * provider it does not recognise makes this throw. That is a loud, named
 * failure rather than a silently different bench.
 */
export function benchSearchConfig(
  vault: string,
  pinnedKnobs: BenchPinnedKnobs = DEFAULT_BENCH_KNOB_PIN,
): ReturnType<typeof resolveSearchConfig> {
  return resolveSearchConfig({ vault, overrides: pinnedKnobs });
}

/** Char budget per evidence excerpt a judged question carries. */
const JUDGE_EVIDENCE_EXCERPT_CHARS = 800;

export async function runMemoryBench(opts: BenchRunOptions): Promise<BenchReport> {
  // Refused BEFORE any run state exists (pr-250 review, L9): the floor
  // routes into the shared surfacing calculator, whose own contract
  // refuses out-of-range values per question - so an out-of-range floor
  // used to buy a full run whose every proactive decision was a
  // retrievalError, paid after ingest and index, instead of this one
  // named error. The bound is the calculator's own: a finite number in
  // [0, 1]. Zero stays legal - the replay suite's permissive sweep arm
  // uses it as the maximally permissive calibration point.
  if (
    opts.recallFloor !== undefined &&
    !(Number.isFinite(opts.recallFloor) && opts.recallFloor >= 0 && opts.recallFloor <= 1)
  ) {
    throw new Error(
      `bench run refused: recallFloor ${opts.recallFloor} is outside [0, 1]; the admission floor must be a finite number in the unit interval`,
    );
  }
  // Refused BEFORE any run state exists, on the same principle: the
  // sampling options are part of the run identity, so a malformed one
  // must not buy a full run under an identity that could never resume.
  if (opts.sample !== undefined) {
    if (!Number.isInteger(opts.sample.cap) || opts.sample.cap <= 0) {
      throw new Error(
        `bench run refused: sample cap ${opts.sample.cap} is not a positive integer; the sampling cap bounds the selected questions`,
      );
    }
    if (opts.sample.seed.trim() === "") {
      throw new Error("bench run refused: sample seed must be a non-empty string");
    }
  }
  const pinnedKnobs = opts.pinnedKnobs ?? DEFAULT_BENCH_KNOB_PIN;
  // The run's clock is resolved once so every consumer sees the same
  // second: the preflight's collision check must read the identity the
  // store is about to write.
  const now = opts.now ?? new Date();
  // The preflight catches every damaged state catchable BEFORE a run
  // exists (unusable runs dir, fresh-run collision, damaged or tampered
  // resume target, fixture cross-reference defects), so a refusal can
  // never leave a run directory behind. Guards add zero stdout and no
  // knobs: a healthy run is untouched.
  const freshRunId =
    opts.resume !== undefined
      ? undefined
      : nextBenchRunId(opts.fixture, {
          now,
          pinnedKnobs,
          ...(opts.recallFloor !== undefined ? { recallFloor: opts.recallFloor } : {}),
          ...(opts.sample !== undefined ? { sample: opts.sample } : {}),
        });
  preflightBenchRun({
    runsDir: opts.runsDir,
    fixture: opts.fixture,
    ...(opts.resume !== undefined ? { resume: opts.resume } : {}),
    ...(freshRunId !== undefined ? { freshRunId } : {}),
  });
  // Resolved BEFORE the run is created (t_d7ce8baf): `resolveSearchConfig`
  // parses the env BEFORE merging overrides, so an env var naming a
  // provider it does not recognise throws - and that refusal used to
  // leave an orphan run dir behind. The vault path is computed the way
  // the store resolves it, so the config here is the config the searches
  // will run under.
  const runDir = benchRunDirPath(opts.runsDir, opts.resume ?? freshRunId!);
  const vault = benchVaultDir(runDir);
  const config = benchSearchConfig(vault, pinnedKnobs);
  // The capability gate: the semantic lane is reachable only when the
  // run's suite declared the embeddings capability, so a pin can never
  // silently arm a lane the suite never asked for. Same ordering rule:
  // this refusal also used to orphan a run dir.
  if (config.semantic.enabled && opts.capabilities?.embeddings !== true) {
    throw new Error(
      "bench run pins the semantic lane on without the embeddings capability - declare { embeddings: true } for the suite or keep the semantic lane pinned off",
    );
  }
  const run: BenchRunHandle =
    opts.resume !== undefined
      ? loadBenchRun(opts.runsDir, opts.resume, {
          expectFixture: opts.fixture,
          pinnedKnobs,
          ...(opts.recallFloor !== undefined ? { recallFloor: opts.recallFloor } : {}),
          ...(opts.sample !== undefined ? { sample: opts.sample } : {}),
        })
      : createBenchRun(opts.runsDir, opts.fixture, {
          now,
          pinnedKnobs,
          ...(opts.recallFloor !== undefined ? { recallFloor: opts.recallFloor } : {}),
          ...(opts.sample !== undefined ? { sample: opts.sample } : {}),
        });
  let checkpoint = run.checkpoint;
  // Present when this invocation ran the embedding index phase; read
  // back from the run artifact on a resumed run.
  let embeddings: BenchEmbeddingReceipt | undefined;

  // Phase: ingest - materialize the disposable vault.
  if (!phaseDone(checkpoint, "ingest")) {
    materializeBenchVault(opts.fixture, vault);
    checkpoint = completeBenchPhase(run.runDir, checkpoint, "ingest");
  }

  // Phase: index - one warmup search triggers the store self-heal so
  // the FTS index exists before any timed retrieval. A suite that both
  // declares the embeddings capability and pins the semantic lane on
  // builds real vectors instead, through the apply-gated indexer path
  // and the shared runs-dir vector cache.
  if (!phaseDone(checkpoint, "index")) {
    if (config.semantic.enabled) {
      embeddings = await embedBenchVaultIndex({ config, runsDir: opts.runsDir });
      writeFileSync(
        join(run.runDir, BENCH_EMBEDDING_RECEIPT_FILENAME),
        `${JSON.stringify(embeddings, null, 2)}\n`,
        "utf8",
      );
    } else {
      await search(config, { query: "warmup", limit: 1, transportReach: BENCH_REACH });
    }
    checkpoint = completeBenchPhase(run.runDir, checkpoint, "index");
  }
  if (embeddings === undefined && config.semantic.enabled) {
    embeddings = readBenchEmbeddingReceipt(run.runDir);
  }

  // Phase: retrieve - run every question once, persist raw results.
  if (!phaseDone(checkpoint, "retrieve")) {
    mkdirSync(benchResultsDir(run.runDir), { recursive: true });
    // Deliberately sequential: per-question latency_ms must not include
    // contention from sibling searches running on the same store.
    // oxlint-disable-next-line no-await-in-loop
    for (const question of opts.fixture.questions) {
      // oxlint-disable-next-line no-await-in-loop
      const retrieved = await retrieveQuestion(
        vault,
        config,
        question,
        pinnedKnobs,
        opts.recallFloor,
      );
      atomicWriteFileSync(
        join(benchResultsDir(run.runDir), `${question.id}.json`),
        `${JSON.stringify(retrieved, null, 2)}\n`,
      );
    }
    checkpoint = completeBenchPhase(run.runDir, checkpoint, "retrieve");
  }

  // The trace guard, FIRST pass: every fixture question must have a
  // parseable, correctly-keyed record carrying its category's required
  // fields, no faulted decisions and no leftover files - refused by name
  // BEFORE the evaluator scores anything, so a tampered or truncated
  // trace can never be dressed up as an ordinary failing run. (The
  // second pass runs pre-write with the assembled report, cross-checking
  // the published counts against the same trace.)
  validateBenchTrace({ runDir: run.runDir, fixture: opts.fixture });

  // Phase: evaluate - pure over the persisted results; no vault access.
  // Each persisted record is read once and shared by the evaluator and
  // the suite metric families.
  const retrievedById = new Map(
    opts.fixture.questions.map((question) => [question.id, readRetrieved(run.runDir, question.id)]),
  );
  const results = opts.fixture.questions
    .map((question) => evaluateQuestion(question, retrievedById.get(question.id)!))
    .toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (!phaseDone(checkpoint, "evaluate")) {
    checkpoint = completeBenchPhase(run.runDir, checkpoint, "evaluate");
  }

  // The LongMemEval suite's named metric family: strict recall_all@5
  // rolled off the same persisted results the evaluator read. The
  // exclusion count comes only from a real conversion receipt - without
  // one it reports null, never a manufactured 0. The sampled count
  // rides along only when the run sampled, so a whole-dataset report
  // serializes byte-identically to before.
  let longmemeval: BenchLongMemEvalFamily | undefined;
  if (opts.suite === LONGMEMEVAL_SUITE_NAME) {
    const scored = scoreLongMemEvalRecall(opts.fixture.questions, [...retrievedById.values()]);
    longmemeval = Object.freeze({
      recall_all_at_5: scored.scored > 0 ? round3(scored.passed / scored.scored) : 0,
      abstention_excluded: opts.suiteReceipt?.abstention_excluded ?? null,
      // The sampled bookkeeping rides the named family when the run
      // sampled - population, selected count and the per-stratum
      // breakdown - so a reader can see what the run's numbers cover
      // without opening the checkpoint. Spread-omitted otherwise: a
      // whole-dataset (or receipt-less) report serializes
      // byte-identically to before.
      ...(opts.suiteReceipt?.sample_population !== undefined
        ? { sample_population: opts.suiteReceipt.sample_population }
        : {}),
      ...(opts.suiteReceipt?.sample_selected !== undefined
        ? { sample_selected: opts.suiteReceipt.sample_selected }
        : {}),
      ...(opts.suiteReceipt?.sample_strata !== undefined
        ? { sample_strata: opts.suiteReceipt.sample_strata }
        : {}),
    });
  }

  // Optional judge (advisory, fail-open), then report. Questions whose
  // suite provides official-prompt judge input carry it on the stdin
  // payload; suites without it keep the payload unchanged.
  // Judged questions carry the retrieved evidence (path plus a bounded
  // excerpt, in rank order) beside the reference answer, so a judge can
  // evaluate against what the system actually showed.
  const bodiesByPath = new Map(opts.fixture.notes.map((n) => [n.path, n.body]));
  const excerpt = (body: string): string =>
    body.length > JUDGE_EVIDENCE_EXCERPT_CHARS
      ? `${body.slice(0, JUDGE_EVIDENCE_EXCERPT_CHARS)}...`
      : body;
  const judgeInputs = new Map(
    opts.fixture.questions.flatMap((question) => {
      if (question.judge_input === undefined) return [];
      const retrieved = retrievedById.get(question.id);
      const evidence = (retrieved?.paths ?? []).flatMap((path) => {
        const body = bodiesByPath.get(path);
        return body === undefined ? [] : [{ path, text: excerpt(body) }];
      });
      const input =
        evidence.length > 0 ? { ...question.judge_input, evidence } : question.judge_input;
      return [[question.id, input] as const];
    }),
  );
  const judge = runJudge(opts.judgeCmd, results, judgeInputs);
  const report = buildReport(run, opts.fixture, results, judge, embeddings, longmemeval);
  // The trace guard, SECOND pass: the assembled report must agree with
  // the trace it was built from (same aggregation, including the
  // standing_instruction headline exclusion) - refused before anything
  // is written, so a buildReport regression cannot publish silently.
  validateBenchTrace({ runDir: run.runDir, fixture: opts.fixture, results, report });
  atomicWriteFileSync(join(run.runDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  if (!phaseDone(checkpoint, "report")) {
    completeBenchPhase(run.runDir, checkpoint, "report");
  }
  return report;
}

async function retrieveQuestion(
  vault: string,
  config: ReturnType<typeof resolveSearchConfig>,
  question: BenchQuestion,
  pinnedKnobs: BenchPinnedKnobs,
  recallFloor?: number,
): Promise<RetrievedQuestion> {
  const startedAt = Date.now();
  if (RETRIEVAL_CATEGORIES.has(question.category)) {
    // Overlapped lane accounting (recall-lane-latency): the per-call sink
    // rides this question's search and the figure is persisted only when
    // the semantic lane attempted the embed, so a keyword-only suite
    // keeps its report bytes.
    let laneTiming: SearchLaneTiming | undefined;
    const outcome = await search(config, {
      query: question.query ?? "",
      limit: question.top_k ?? 5,
      transportReach: BENCH_REACH,
      laneTiming: (timing) => {
        laneTiming = timing;
      },
    });
    return {
      id: question.id,
      latency_ms: Date.now() - startedAt,
      ...(laneTiming?.attempted === true ? { overlapped_ms: laneTiming.overlappedMs } : {}),
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
    // The structural pre-tier (pr-250 review, M9): the transports run
    // `evaluateSurfacingGate` ahead of the decision core, so a duplicate,
    // slash-command, shell-command or empty prompt never reaches
    // retrieval. The bench reproduces that composition exactly whenever
    // the fixture records the prompt this question follows: a structural
    // refusal is persisted as an honest abstention - the gate's own
    // reason, nothing measured, zero injected cost - and the decision
    // core never runs for it.
    const previousPrompt = question.previous_prompt;
    if (previousPrompt !== undefined && previousPrompt.length > 0) {
      const gate = evaluateSurfacingGate({ prompt: question.prompt ?? "", previousPrompt });
      if (!gate.retrieve) {
        return {
          id: question.id,
          latency_ms: Date.now() - startedAt,
          recall_decision: Object.freeze({
            kind: "abstain",
            reason: "structural",
            structuralReason: gate.reason,
            topScore: 0,
            matchQuality: null,
          }),
          context_chars: 0,
          injected_tokens: injectedTokens(""),
        };
      }
    }
    // The shipped decision core, driven directly over the fixture vault.
    // The retriever is a PARAMETER of that function, which is the only
    // reason this is measurable offline at all. The admission floor is a
    // parameter too (t_107a3249): the replay suite sweeps it to measure
    // gate calibration; absent keeps the shipped default.
    const decision = await decideRecallInject(
      question.prompt ?? "",
      benchRecallRetriever(config, question.top_k ?? RECALL_INJECT_MAX_NOTES),
      recallFloor === undefined ? {} : { confidenceFloor: recallFloor },
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
  if (question.category === STANDING_INSTRUCTION_CATEGORY) {
    return retrieveStandingInstruction(vault, question, startedAt, pinnedKnobs);
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
 * Run the shipped standing_query surfacing lane over the fixture's
 * attention flows (standing_instruction, recall-lane-latency).
 *
 * The lane's arm follows the run's knob pin: absent or true, the facet
 * option is on - the category exists to measure the provenance join.
 * Pinned false, the plain lane runs and emits the legacy strings, so the
 * category's facet assertions fail by name: the off arm of the A/B the
 * design promises, which is what makes the pin change what a run
 * measures instead of only naming it. Every flow that declares the
 * `standing_query` action is evaluated and its surfaced items and
 * resolved facet keys persisted; a preference the lane surfaces but
 * whose join does not resolve contributes its plain string and no facet,
 * exactly as the option contract renders it.
 */
function retrieveStandingInstruction(
  vault: string,
  question: BenchQuestion,
  startedAt: number,
  pinnedKnobs: BenchPinnedKnobs,
): RetrievedQuestion {
  // Absent keeps the lane on, so existing runs and the default pin
  // measure the facet lane exactly as before the pin was wired.
  const facetsOn = pinnedKnobs.standingInstructionFacets !== false;
  const items: string[] = [];
  const facetIds: string[] = [];
  for (const flow of listAttentionFlows(vault)) {
    if (!flow.actions.includes("standing_query")) continue;
    const evaluation = facetsOn
      ? evaluateAttentionFlow(vault, flow.id, { standingInstructionFacets: true })
      : evaluateAttentionFlow(vault, flow.id, { standingInstructionFacets: false });
    for (const section of evaluation.sections) {
      if (section.action !== "standing_query") continue;
      items.push(...section.items);
      for (const facet of section.facets ?? []) facetIds.push(facet.key);
    }
  }
  return {
    id: question.id,
    latency_ms: Date.now() - startedAt,
    standing_items: items,
    facet_ids: facetIds,
  };
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
    ...(retrieved.overlapped_ms !== undefined ? { overlapped_ms: retrieved.overlapped_ms } : {}),
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
  if (question.category === STANDING_INSTRUCTION_CATEGORY) {
    return evaluateStandingInstruction(question, retrieved, base);
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
  if (decision.kind === "abstain") {
    return decision.structuralReason !== undefined
      ? `abstain(${decision.reason}:${decision.structuralReason})`
      : `abstain(${decision.reason})`;
  }
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

/**
 * Assert the standing-instruction facet lane delivered what the fixture
 * named (standing_instruction, recall-lane-latency).
 *
 * `expected_ids` are facet keys - `pref:<preference id>`, so the
 * preference id itself is what is asserted delivered. `expected_text`
 * is the full earliest-cited annotation that must CLOSE the first named
 * preference's item: the assertion finds the item for `expected_ids[0]`
 * and compares the annotation exactly, closing bracket included, so a
 * near-miss origin (`...#t1`) cannot satisfy an expectation about
 * another (`...#t10`) and an origin cannot pass by sitting on a
 * different preference's item. A fixture states the kind word ("earliest
 * cited turn ..."/"earliest cited session ...") so a session-annotated
 * origin cannot satisfy a turn expectation. A preference the lane
 * surfaced but could not resolve is a named failure, never an implied
 * provenance.
 */
function evaluateStandingInstruction(
  question: BenchQuestion,
  retrieved: RetrievedQuestion,
  base: ResultBase,
): BenchQuestionResult {
  const facetIds = retrieved.facet_ids ?? [];
  const missingFacets = (question.expected_ids ?? []).filter((id) => !facetIds.includes(id));
  if (missingFacets.length > 0) {
    return Object.freeze({
      ...base,
      pass: false,
      failure: `expected facet missing from the surfaced standing instructions: ${missingFacets.join(", ")}`,
    });
  }
  const expectedOrigin = question.expected_text;
  if (expectedOrigin !== undefined) {
    // Tie the annotation to the expected preference's own item: the
    // first expected facet key names the preference, and its item is the
    // `id (scope)` string the lane renders for it.
    const expectedKey = question.expected_ids?.[0];
    const expectedId =
      expectedKey !== undefined && expectedKey.startsWith("pref:")
        ? expectedKey.slice("pref:".length)
        : undefined;
    const item =
      expectedId === undefined
        ? undefined
        : (retrieved.standing_items ?? []).find((candidate) =>
            candidate.startsWith(`${expectedId} (`),
          );
    if (item === undefined || !item.endsWith(expectedOrigin)) {
      return Object.freeze({
        ...base,
        pass: false,
        failure: `expected origin annotation not found on the item for ${expectedKey ?? "(no facet named)"}: ${expectedOrigin}`,
      });
    }
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
  embeddings?: BenchEmbeddingReceipt,
  longmemeval?: BenchLongMemEvalFamily,
): BenchReport {
  // ONE copy of the counting rule - the guards' `countQuestionResults`,
  // which the pre-write trace cross-check (T7) runs against the same
  // results - so the published counts and their validation cannot drift.
  const { passed, total, byCategory } = countQuestionResults(results);
  const latencies = results.map((result) => result.latency_ms);
  // The latency family's overlap figure (recall-lane-latency): averaged
  // over the questions that attempted the semantic lane, present only
  // when at least one did - a keyword-only report keeps its bytes.
  const overlappedMsValues = results
    .map((result) => result.overlapped_ms)
    .filter((value): value is number => value !== undefined);
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
      total,
      pass_rate: total > 0 ? round3(passed / total) : 0,
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
      ...(overlappedMsValues.length > 0
        ? {
            overlapped_ms: Math.round(
              overlappedMsValues.reduce((sum, value) => sum + value, 0) / overlappedMsValues.length,
            ),
          }
        : {}),
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
    ...(embeddings !== undefined ? { embeddings: Object.freeze({ ...embeddings }) } : {}),
    ...(longmemeval !== undefined ? { longmemeval } : {}),
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
