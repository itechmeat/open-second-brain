/**
 * Memory quality benchmark types (Memory Observability Suite,
 * t_882c396a).
 *
 * MemoryBench-inspired harness for recall regression testing. The
 * MemScore lesson is encoded in the report type: quality, latency, and
 * context cost are SEPARATE metric families - never one collapsed
 * number. Everything is deterministic and network-free by default;
 * judge-model evaluation is an optional external command.
 */

/**
 * Bumped from `v1` for U10: `context_cost.est_tokens` was replaced by
 * `context_cost.avg_injected_tokens`. The old field averaged
 * `ceil(avg_chars / 4)` over an inline formula that did not even import
 * the shared helper; the new one is `estimateTokens` applied to the
 * strings the bench actually injected. Same family, different meaning and
 * a different number, so the schema says so rather than letting a stored
 * report be read under the wrong rule.
 */
import type { RecallFailure } from "./failure-modes.ts";
import type { EmbeddingGateVerdict } from "../search/embedding-spend.ts";
import type {
  ResolvedEmbeddingConfig,
  ResolvedRerankConfig,
  ResolvedSearchConfig,
} from "../search/types.ts";
import type { VaultScopeRules } from "../vault-scope/defaults.ts";
import type { LongMemEvalSampleStratum } from "./longmemeval-sample.ts";

export const BENCH_REPORT_SCHEMA = "o2b.bench.v2";

export const BENCH_PHASES = ["ingest", "index", "retrieve", "evaluate", "report"] as const;
export type BenchPhase = (typeof BENCH_PHASES)[number];

export const BENCH_CATEGORIES = [
  "single_hop",
  "temporal",
  "contradiction",
  "multi_evidence",
  "session_handoff",
  "budget",
  // The failure-mode suite (t_72d6eb23). Each drives a different shipped
  // seam, so none of them can be expressed as a retrieval question.
  "proactive_recall",
  "write_fidelity",
  "source_isolation",
  // The standing-instruction facet suite (recall-lane-latency). Like the
  // failure-mode categories it drives a seam the search pipeline never
  // touches: the `standing_query` attention action, run with the opt-in
  // provenance facet on, so the join ships measured rather than assumed.
  "standing_instruction",
] as const;
export type BenchCategory = (typeof BENCH_CATEGORIES)[number];

/** Question categories answered by running the search pipeline. */
export const RETRIEVAL_CATEGORIES: ReadonlySet<BenchCategory> = new Set([
  "single_hop",
  "temporal",
  "contradiction",
  "multi_evidence",
]);

export interface BenchFixtureNote {
  /** Vault-relative path; validated against traversal and absolutes. */
  readonly path: string;
  readonly body: string;
}

export interface BenchFixtureContinuity {
  readonly kind: "session_turn";
  readonly created_at: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

/**
 * What a suite provides for the official-prompt judge: the question as
 * the dataset asked it, the reference answer when it states one, and the
 * gold evidence ids. Rides the judge stdin payload verbatim; it is
 * NEVER scoring input - `evaluateQuestion` ignores it, and the converter
 * never sets `expected_text` (that field is ignored for retrieval
 * categories, so a gold answer pinned there would silently score
 * nothing).
 */
export interface BenchJudgeInput {
  readonly question: string;
  readonly answer?: string;
  readonly gold: ReadonlyArray<string>;
  /**
   * The retrieved evidence the run actually injected, path plus a
   * bounded text excerpt in rank order, so a judge can evaluate an
   * answer against what the system showed rather than the whole vault.
   * Present when the run records retrieved texts for a judged question.
   */
  readonly evidence?: ReadonlyArray<{ readonly path: string; readonly text: string }>;
}

export interface BenchQuestion {
  readonly id: string;
  readonly category: BenchCategory;
  /** Search query (retrieval categories). */
  readonly query?: string;
  readonly top_k?: number;
  readonly expected_paths?: ReadonlyArray<string>;
  /**
   * Stale-fact guard: none of these paths may rank above the best
   * expected path. Catches superseded-recall regressions.
   */
  readonly not_expected_above?: ReadonlyArray<string>;
  /** session_handoff: which session's turns must be readable. */
  readonly session_id?: string;
  readonly expected_turns?: number;
  /**
   * standing_instruction: the full earliest-cited annotation that must
   * close the item of `expected_ids[0]`, compared exactly with the
   * closing bracket included - a near-miss origin cannot satisfy the
   * expectation as a substring. (session_handoff reads the same field
   * as an in-turns substring, so the exact-match rule is
   * category-specific.)
   */
  readonly expected_text?: string;
  /**
   * Official-prompt judge glue (longmemeval), absent for suites that
   * provide none - their judge payload stays unchanged.
   */
  readonly judge_input?: BenchJudgeInput;
  /** budget / source_isolation: pack item ids that must be delivered. */
  readonly expected_ids?: ReadonlyArray<string>;
  readonly max_tokens?: number;
  readonly max_total_chars?: number;
  /** proactive_recall: the user prompt the decision core sees. */
  readonly prompt?: string;
  /**
   * proactive_recall: the previous prompt in the replayed sequence, when
   * the suite records one. The structural gate (`evaluateSurfacingGate`)
   * consumes it ahead of the decision core, exactly as the transports
   * run it; absent means the gate is not reproduced for this question
   * and it is judged on retrieval alone.
   */
  readonly previous_prompt?: string;
  /**
   * proactive_recall: whether memory SHOULD speak up for this prompt.
   * `false` is the anti-gaming half of the fixture - a prompt the vault
   * has nothing useful to say about, where injecting is the failure.
   */
  readonly expect_inject?: boolean;
  /** write_fidelity: the labelled prose a host flushes before compaction. */
  readonly intake_text?: string;
  /** write_fidelity: normalized label tokens the extractor must recover, in order. */
  readonly expected_labels?: ReadonlyArray<string>;
  /** write_fidelity: payload keys that must survive onto every record. */
  readonly expected_provenance?: ReadonlyArray<string>;
  /** source_isolation: the owner scope the delivery is requested under. */
  readonly agent_scope?: string;
  /** source_isolation: pack item ids that must NOT be delivered. */
  readonly forbidden_ids?: ReadonlyArray<string>;
}

export interface BenchFixture {
  readonly name: string;
  readonly description?: string;
  readonly notes: ReadonlyArray<BenchFixtureNote>;
  readonly continuity: ReadonlyArray<BenchFixtureContinuity>;
  readonly questions: ReadonlyArray<BenchQuestion>;
}

/**
 * What a registered suite may do inside one bench run.
 *
 * Declared at suite registration and carried on {@link BenchRunOptions}
 * by the CLI verb from the suite registry, so "what a suite may do" is a
 * property of the suite in code - never of a flag a caller forgot.
 * A capability declaration alone is inert: the feature also has to be
 * enabled through the run's knob pin.
 */
export interface BenchSuiteCapabilities {
  /**
   * Whether the suite may build the disposable vault index with
   * embeddings (through the apply-gated indexer options) and run the
   * semantic lane.
   */
  readonly embeddings: boolean;
  /**
   * Whether the suite's loader accepts a seeded sampling request
   * ({@link BenchSuiteLoadOptions.sample}). Absent means false: the
   * sampling flags are refused for such a suite, naming it. Declared
   * here, honored by the loader - a capability declaration alone is
   * inert, exactly like {@link BenchSuiteCapabilities.embeddings}.
   */
  readonly sampling?: boolean;
}

/**
 * A seeded sampling request for one suite load: select a deterministic,
 * question-type-proportional subset of the dataset instead of running
 * it whole. The seed is an opaque string (hashed, never interpolated
 * into run ids); the cap is a positive integer bounding the selected
 * questions. Part of the run identity: a resumed run whose sampling
 * options changed fails the identity guard.
 */
export interface BenchSampleRequest {
  readonly seed: string;
  readonly cap: number;
}

/**
 * Options the bench verb passes to a suite loader as its second,
 * OPTIONAL parameter - a suite registered before an option existed
 * keeps its one-parameter loader and simply never sees the request.
 */
export interface BenchSuiteLoadOptions {
  readonly sample?: BenchSampleRequest;
}

/**
 * What a suite loader returns: the converted fixture plus a typed
 * receipt of what conversion decided (for LongMemEval, how many
 * abstention questions it dropped).
 */
export interface BenchSuiteLoad {
  readonly fixture: BenchFixture;
  readonly receipt?: BenchSuiteReceipt;
}

/** Suite-level conversion receipt, surfaced through the report family. */
export interface BenchSuiteReceipt {
  /** LongMemEval-style abstention questions dropped at conversion time. */
  readonly abstention_excluded?: number;
  /**
   * Seeded-sampling bookkeeping, present only when the loader sampled:
   * the population it chose from, the questions it selected, and the
   * per-stratum breakdown. Mirrors the abstention precedent - a
   * whole-dataset run carries no sample fields rather than a
   * manufactured 0.
   */
  readonly sample_population?: number;
  readonly sample_selected?: number;
  readonly sample_strata?: ReadonlyArray<LongMemEvalSampleStratum>;
}

/**
 * One registered suite: how a dataset file becomes a {@link BenchFixture}
 * and what the suite may do inside a run. Suites register through the
 * registry map in the bench verb - an appendable registration point, not
 * a hard-coded branch chain.
 */
export interface BenchSuiteRegistration {
  readonly loader: (fixturePath: string, options?: BenchSuiteLoadOptions) => BenchSuiteLoad;
  readonly capabilities: BenchSuiteCapabilities;
}

/**
 * Search-configuration knobs pinned for one bench run. Shaped exactly
 * like `resolveSearchConfig`'s overrides - applied last and win - so a
 * pin can express every search, rerank and embedding knob the resolver
 * knows. The pin is part of the RUN IDENTITY: it is folded into the
 * checkpoint hash, so a resumed run that would mix two configurations
 * fails the guard loudly instead of silently comparing them.
 */
export type BenchPinnedKnobs = Partial<
  Omit<ResolvedSearchConfig, "scopeRules" | "semantic" | "rerank">
> & {
  readonly scopeRules?: VaultScopeRules;
  readonly semantic?: Partial<ResolvedEmbeddingConfig>;
  readonly rerank?: Partial<ResolvedRerankConfig>;
  /**
   * The standing-instruction facet lane's arm (recall-lane-latency), read
   * by the retrieve branch: absent or true, the `standing_instruction`
   * category evaluates with the provenance facet on; false runs the plain
   * lane, which emits the legacy strings so the category's facet
   * assertions fail by name - the off arm of the measured A/B, and the
   * reason the pin changes what a run measures instead of only naming it.
   * The value folds into the checkpoint hash either way, so a resumed run
   * that would mix a facet-gate arm with a plain one fails the guard
   * loudly instead of comparing them. Absent on every other run, so
   * `DEFAULT_BENCH_KNOB_PIN` and the existing run identities serialize
   * byte-identically.
   */
  readonly standingInstructionFacets?: boolean;
};

/**
 * The default knob pin: the hardcoded semantic-off override the harness
 * has always applied, made an explicit named value so the default run
 * identity is deterministic and locomo report numbers stay identical.
 */
export const DEFAULT_BENCH_KNOB_PIN: BenchPinnedKnobs = Object.freeze({
  semantic: Object.freeze({ enabled: false }),
});

/**
 * The embedding spend receipt a capability-declaring suite surfaces.
 *
 * It records the ONE spend plan the suite's index phase computed through
 * the apply-gated path (`planEmbeddingSpend`, the indexer's own gate) and
 * how the shared vector cache split it: `cache_hits` vectors came off the
 * runs-dir cache with zero provider contact, `cache_misses` were embedded
 * through the indexer's embedding phase - which re-prices and re-gates
 * that census itself, so the verdict acted on is never a caller's. A
 * blocked gate is a named refusal, never a silent bypass.
 */
export interface BenchEmbeddingReceipt {
  readonly provider: string;
  /** The model the vectors are stored under. */
  readonly model: string | null;
  /**
   * Canonical embedding identity: the `<provider>:<model>:<dimension>`
   * triple plus the query/passage prefixes, rendered by
   * `benchEmbeddingSignature`.
   */
  readonly signature: string;
  /** Chunks the spend plan found pending when the phase opened. */
  readonly planned: number;
  /** Pending chunks served from the shared cache (no provider contact). */
  readonly cache_hits: number;
  /** Pending chunks embedded through the apply-gated embedding phase. */
  readonly cache_misses: number;
  /** Tokens the full pending census estimated. */
  readonly tokens: number;
  /** Estimated spend of the full pending census; null when unpriced. */
  readonly estimated_usd: number | null;
  /** Who stated the price the estimate used. */
  readonly price_source: string;
  /** The plan's own gate verdict, verbatim. */
  readonly gate: EmbeddingGateVerdict;
  /**
   * True only when the embedding phase's receipt records a forced pass
   * over a gate that would have refused. The bench itself never forces;
   * the field exists so a receipt can never hide a bypass.
   */
  readonly forced?: boolean;
}

/**
 * The LongMemEval report family (the MemScore rule: metric families stay
 * separate and named). The strict recall_all@5 aggregate is never folded
 * into `quality.pass_rate`, and the abstention exclusion count is
 * surfaced beside it rather than hidden - a reader can see what the
 * number does and does not cover.
 */
export interface BenchLongMemEvalFamily {
  /** Share of scored questions with every gold note inside the cutoff. */
  readonly recall_all_at_5: number;
  /**
   * Abstention questions the conversion excluded from scoring, taken
   * from the run's conversion receipt. Null when the run carries no
   * receipt - the count is then unknown, never a manufactured 0.
   */
  readonly abstention_excluded: number | null;
  /**
   * Questions the run's seeded sampler selected, taken from the run's
   * conversion receipt. Present only when the run sampled, so a
   * whole-dataset (or receipt-less) report serializes byte-identically
   * to before.
   */
  readonly sample_selected?: number;
  /**
   * Population the run's seeded sampler chose from, taken from the
   * run's conversion receipt. Present only when the run sampled, under
   * the same spread-omission as `sample_selected`.
   */
  readonly sample_population?: number;
  /**
   * Per-stratum population/selected breakdown of the run's seeded
   * sample, taken from the run's conversion receipt. Present only when
   * the run sampled, under the same spread-omission as
   * `sample_selected`.
   */
  readonly sample_strata?: ReadonlyArray<LongMemEvalSampleStratum>;
}

export interface BenchQuestionResult {
  readonly id: string;
  readonly category: BenchCategory;
  readonly pass: boolean;
  /** One-line reason when pass is false. */
  readonly failure?: string;
  readonly latency_ms: number;
  /**
   * Overlapped lane milliseconds (recall-lane-latency): how much of this
   * question's embed round trip the keyword lanes hid, present only when
   * the semantic lane attempted the embed - a keyword-only run adds no
   * key, keeping its report bytes identical.
   */
  readonly overlapped_ms?: number;
  /** Characters of context this question injected, when it injected any. */
  readonly context_chars?: number;
  /** {@link estimateTokens} over the same string `context_chars` measured. */
  readonly injected_tokens?: number;
  /** proactive_recall: which failure mode fired, absent when none did. */
  readonly recall_failure?: RecallFailure;
  /** source_isolation: forbidden ids the pack actually delivered. */
  readonly isolation_violations?: number;
  /**
   * The external judge's verdict for this question, present only when a
   * judge ran and answered for it; deterministic evaluation stays
   * canonical either way.
   */
  readonly judge_pass?: boolean;
}

export interface BenchReport {
  readonly schema: string;
  readonly run_id: string;
  readonly fixture: string;
  readonly fixture_hash: string;
  readonly created_at: string;
  readonly quality: {
    /**
     * Headline pass count over every category EXCEPT
     * `standing_instruction` (recall-lane-latency): the facet lane's
     * rate stays the named line of its own in `by_category`, so adding
     * facet questions to a fixture never shifts the headline a baseline
     * compares.
     */
    readonly passed: number;
    /** Question count behind {@link BenchReport.quality.passed}, same exclusion. */
    readonly total: number;
    /** `passed / total` at report precision; `0` when nothing counts. */
    readonly pass_rate: number;
    /** Per-category passed/total, every category including the excluded one. */
    readonly by_category: Readonly<Record<string, { passed: number; total: number }>>;
  };
  readonly latency_ms: {
    readonly avg: number;
    readonly max: number;
    /**
     * Mean overlapped lane milliseconds (recall-lane-latency) over the
     * questions that attempted the semantic lane. Present only when at
     * least one did, so the default (keyword-only) report serializes
     * byte-identically without it.
     */
    readonly overlapped_ms?: number;
  };
  /**
   * Cost, kept apart from quality on purpose (the MemScore lesson stated
   * at the top of this file). `avg_injected_tokens` is the fourth
   * failure-mode metric and it lives HERE rather than in `failure_modes`
   * because a token count is a cost, not a failure - collapsing it into
   * the failure block is exactly the conflation this type exists to
   * prevent. Both fields are averaged over the questions that injected
   * something, so they describe the same population.
   */
  readonly context_cost: { readonly avg_chars: number; readonly avg_injected_tokens: number };
  /**
   * The three ways memory fails that are not "the query missed"
   * (t_72d6eb23). Both rates share one denominator - every decision the
   * proactive-recall questions produced - which is what stops a strategy
   * that always injects from scoring well; see `failure-modes.ts`.
   * `source_isolation_violations` is a COUNT and gates at zero.
   */
  readonly failure_modes: {
    readonly know_to_ask_failure_rate: number;
    readonly false_fire_rate: number;
    readonly source_isolation_violations: number;
  };
  /**
   * The embedding spend receipt, present only when the run's suite
   * declares the embeddings capability AND the knob pin enables the
   * semantic lane - so the default (and locomo) report serializes
   * byte-identically without it. Carries the provider+model signature so
   * numbers are never compared across embedding identities.
   */
  readonly embeddings?: BenchEmbeddingReceipt;
  /**
   * The LongMemEval suite's named metric family, present only on runs
   * through the longmemeval suite - so the default (and locomo) report
   * serializes byte-identically without it.
   */
  readonly longmemeval?: BenchLongMemEvalFamily;
  readonly judge: { readonly status: "skipped" | "ran" | "error"; readonly detail?: string };
  readonly questions: ReadonlyArray<BenchQuestionResult>;
}

export interface BenchCheckpoint {
  readonly run_id: string;
  readonly fixture_name: string;
  readonly fixture_hash: string;
  /**
   * The knob pin this run was created under, and the run-identity hash
   * covering fixture plus pin. Both absent on checkpoints written before
   * knob pinning existed; resume refuses such a checkpoint loudly rather
   * than mixing configurations.
   */
  readonly pinned_knobs?: BenchPinnedKnobs;
  readonly knobs_hash?: string;
  /**
   * The seeded sampling request this run was created under, present only
   * on a sampled run. The run-identity hash covers it, so a resumed run
   * under different sampling options fails the guard; the field itself
   * is spread-omitted on unsampled runs, keeping those checkpoints
   * byte-identical to before.
   */
  readonly sample?: BenchSampleRequest;
  readonly created_at: string;
  readonly completed_phases: ReadonlyArray<BenchPhase>;
}
