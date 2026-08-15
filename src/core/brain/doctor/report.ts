/**
 * The public result shapes of the Brain doctor pass.
 *
 * A leaf: the checks push into these streams and the assembler in
 * `doctor.ts` composes the result out of them, so neither can own the
 * shapes without the other importing it back.
 */

import type { SemanticHealthReport } from "../health/reconcile.ts";
import type { DoctorIssue, InstructionFileCeilingWarning, TrustVerdict } from "../types.ts";

export interface RunDoctorOptions {
  /**
   * Reserved for future per-check toggles. Today the doctor reports
   * every check it knows; CLI `--strict` only changes the exit code,
   * not the contents of the report.
   */
  readonly strict?: boolean;
  /**
   * Wall clock used by age-based lints (`low-evidence-confirmed`,
   * `pinned-without-recent-evidence`). Defaults to `new Date()`.
   * Tests pin this for determinism.
   */
  readonly now?: Date;
  /**
   * Search-index path for index-backed checks
   * (write-time-integrity-governance: staged tier-drift findings).
   * Fail-soft: a missing index or pre-v6 schema simply skips them.
   */
  readonly dbPath?: string;
  /**
   * The `o2b` config file this pass should read runtime gates from (C1).
   *
   * Passed through to {@link DoctorCheckContext.configPath}. Omitted, the
   * gate resolvers fall back to their own default discovery, which is the
   * answer the runtime being diagnosed would get.
   */
  readonly configPath?: string;
  /**
   * Optional precomputed dream summary (v0.10.16). When supplied,
   * the doctor runs the verification-delta helper and folds the
   * counts into the trust verdict. When omitted, verification
   * defaults to all-zero counts and the trust verdict is computed
   * against doctor signals alone.
   */
  readonly dreamSummary?: import("../dream.ts").DreamRunSummary;
  /**
   * Optional resolved guardrail config (v0.10.16). When omitted,
   * `BRAIN_GUARDRAIL_DEFAULTS` are used. Drives the
   * instruction-file-ceiling check.
   */
  readonly guardrails?: import("../types.ts").ResolvedBrainGuardrailConfig;
}

/**
 * Compact counts attached to a `RunDoctorResult` so callers can render
 * a one-line "verification delta: X drift, Y regression, Z missing"
 * summary without re-walking the vault. Full per-entry detail lives
 * on the trust-layer `operator_summary` composer.
 */
export interface VerificationDeltaSummary {
  readonly confirmed: number;
  readonly drift: number;
  readonly regression: number;
  readonly missing_evidence: number;
}

/**
 * Per-check uncertainty entry. Distinct from `warnings` / `errors`:
 * these are sub-operations the doctor attempted but cannot claim
 * completed cleanly (e.g. an instruction-file the doctor could not
 * read, a verification step that timed out). Empty on every clean
 * run. v0.10.16 extension point.
 */
export interface DoctorUncertainEntry {
  readonly code: string;
  readonly path?: string;
  readonly message: string;
}

export interface RunDoctorResult {
  readonly warnings: ReadonlyArray<DoctorIssue>;
  readonly errors: ReadonlyArray<DoctorIssue>;
  /**
   * Aggregate trust verdict (v0.10.16). Absent when the trust helper
   * was not invoked; consumers of `runDoctor` that only need the
   * legacy warning / error stream can ignore the field.
   */
  readonly trust_verdict?: TrustVerdict;
  /**
   * Counts of verification-delta states for the most recent dream
   * cycle. Absent when verification did not run.
   */
  readonly verification_delta_summary?: VerificationDeltaSummary;
  /**
   * Warnings emitted by the instruction-file-ceiling helper. Empty
   * when the helper did not run or no tracked file exceeded the
   * configured ceiling.
   */
  readonly instruction_file_warnings?: ReadonlyArray<InstructionFileCeilingWarning>;
  /**
   * Sub-operations the doctor attempted but could not fully verify.
   * Empty on every clean run; populated when an uncertainty-surfacing
   * helper is invoked.
   */
  readonly uncertain?: ReadonlyArray<DoctorUncertainEntry>;
  /**
   * Semantic-health report (v0.14.0): contradiction / concept-gap /
   * stale-claim findings plus an escalating verdict. Absent only when
   * the vault has no Brain layer; otherwise present even on a clean
   * run (with empty domains and a `clean` verdict).
   */
  readonly semantic_health?: SemanticHealthReport;
}
