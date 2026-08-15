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
  readonly expected_text?: string;
  /** budget / source_isolation: pack item ids that must be delivered. */
  readonly expected_ids?: ReadonlyArray<string>;
  readonly max_tokens?: number;
  readonly max_total_chars?: number;
  /** proactive_recall: the user prompt the decision core sees. */
  readonly prompt?: string;
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

export interface BenchQuestionResult {
  readonly id: string;
  readonly category: BenchCategory;
  readonly pass: boolean;
  /** One-line reason when pass is false. */
  readonly failure?: string;
  readonly latency_ms: number;
  /** Characters of context this question injected, when it injected any. */
  readonly context_chars?: number;
  /** {@link estimateTokens} over the same string `context_chars` measured. */
  readonly injected_tokens?: number;
  /** proactive_recall: which failure mode fired, absent when none did. */
  readonly recall_failure?: RecallFailure;
  /** source_isolation: forbidden ids the pack actually delivered. */
  readonly isolation_violations?: number;
}

export interface BenchReport {
  readonly schema: string;
  readonly run_id: string;
  readonly fixture: string;
  readonly fixture_hash: string;
  readonly created_at: string;
  readonly quality: {
    readonly passed: number;
    readonly total: number;
    readonly pass_rate: number;
    readonly by_category: Readonly<Record<string, { passed: number; total: number }>>;
  };
  readonly latency_ms: { readonly avg: number; readonly max: number };
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
  readonly judge: { readonly status: "skipped" | "ran" | "error"; readonly detail?: string };
  readonly questions: ReadonlyArray<BenchQuestionResult>;
}

export interface BenchCheckpoint {
  readonly run_id: string;
  readonly fixture_name: string;
  readonly fixture_hash: string;
  readonly created_at: string;
  readonly completed_phases: ReadonlyArray<BenchPhase>;
}
