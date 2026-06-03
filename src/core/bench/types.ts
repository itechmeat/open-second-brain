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

export const BENCH_REPORT_SCHEMA = "o2b.bench.v1";

export const BENCH_PHASES = ["ingest", "index", "retrieve", "evaluate", "report"] as const;
export type BenchPhase = (typeof BENCH_PHASES)[number];

export const BENCH_CATEGORIES = [
  "single_hop",
  "temporal",
  "contradiction",
  "multi_evidence",
  "session_handoff",
  "budget",
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
  /** budget: pack item ids that must fit inside the budget. */
  readonly expected_ids?: ReadonlyArray<string>;
  readonly max_tokens?: number;
  readonly max_total_chars?: number;
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
  /** Pack character count (budget questions). */
  readonly context_chars?: number;
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
  readonly context_cost: { readonly avg_chars: number; readonly est_tokens: number };
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
