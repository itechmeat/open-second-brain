/**
 * Operator summary composer (v0.10.16).
 *
 * One read-only call that aggregates the three independent brain
 * surfaces - doctor, dream, vault metadata - into a unified envelope:
 *
 *   - `trust_verdict`            - `clean | watch | investigate`
 *   - `digest_summary`           - preference status counts
 *   - `doctor_summary`           - warning / error counts
 *   - `dream_summary`            - warning / uncertain / quarantined counts
 *   - `verification_delta`       - confirmed / drift / regression / missing
 *   - `top_actions`              - ranked maintenance action list
 *   - `instruction_file_warnings`- ceiling breaches at vault root
 *
 * The composer never mutates the vault. It accepts a precomputed
 * dream summary so callers can choose between "run dream first" and
 * "skip dream entirely"; verification delta falls back to all-zero
 * counts when no dream is supplied.
 */

import { existsSync, readdirSync, statSync } from "node:fs";

import type { DoctorIssue } from "../doctor.ts";
import { runDoctor, type RunDoctorResult, type TrustVerdict } from "../doctor.ts";
import type { DreamRunSummary } from "../dream.ts";
import { collectMaintenanceActions } from "../maintenance/collect.ts";
import type { ActionItem } from "../maintenance/action-scorer.ts";
import { brainDirs } from "../paths.ts";
import { BRAIN_GUARDRAIL_DEFAULTS } from "../policy.ts";
import type { ResolvedBrainGuardrailConfig } from "../types.ts";
import {
  computeVerificationDelta,
  type VerificationDeltaResult,
} from "./compute-verification-delta.ts";
import { computeTrustVerdict } from "./compute-trust-verdict.ts";
import { checkInstructionFileCeiling } from "./instruction-file-ceiling.ts";
import type { InstructionFileCeilingWarning } from "../doctor.ts";

export interface OperatorSummary {
  readonly trust_verdict: TrustVerdict;
  readonly digest_summary: DigestSummary;
  readonly doctor_summary: DoctorSummary;
  readonly dream_summary: DreamSummary;
  readonly verification_delta: VerificationDeltaResult;
  readonly top_actions: ReadonlyArray<ActionItem>;
  readonly instruction_file_warnings: ReadonlyArray<InstructionFileCeilingWarning>;
}

export interface DigestSummary {
  readonly preference_count: number;
  readonly retired_count: number;
  readonly inbox_count: number;
}

export interface DoctorSummary {
  readonly warning_count: number;
  readonly error_count: number;
  readonly warnings: ReadonlyArray<DoctorIssue>;
  readonly errors: ReadonlyArray<DoctorIssue>;
}

export interface DreamSummary {
  readonly warning_count: number;
  readonly uncertain_count: number;
  readonly quarantined_count: number;
}

export interface BuildOperatorSummaryOptions {
  /**
   * Recent dream-pass summary. Verification delta is computed
   * against this; when omitted, all verification counts default to
   * zero.
   */
  readonly dreamSummary?: DreamRunSummary;
  /**
   * Resolved guardrail config. Drives the instruction-file ceiling
   * check. Defaults to `BRAIN_GUARDRAIL_DEFAULTS`.
   */
  readonly guardrails?: ResolvedBrainGuardrailConfig;
  /** Top-N cap on the maintenance action list. */
  readonly topActionsN?: number;
}

const DEFAULT_TOP_ACTIONS_N = 5;

export function buildOperatorSummary(
  vault: string,
  opts: BuildOperatorSummaryOptions,
): OperatorSummary {
  const guardrails = opts.guardrails ?? BRAIN_GUARDRAIL_DEFAULTS;
  const dreamSummary = opts.dreamSummary;

  const doctorResult = safeDoctor(vault, guardrails, dreamSummary);
  const dreamCounts = summariseDream(dreamSummary);
  const digestCounts = collectDigestCounts(vault);
  const verification = dreamSummary
    ? computeVerificationDelta(vault, dreamSummary)
    : zeroVerification();
  const instructionWarnings = checkInstructionFileCeiling(vault, {
    maxLines: guardrails.instruction_file_max_lines,
  });
  const topActions = safeTopActions(vault, opts.topActionsN ?? DEFAULT_TOP_ACTIONS_N);

  const trust = computeTrustVerdict({
    doctorWarnings: doctorResult.warnings,
    doctorErrors: doctorResult.errors,
    dreamWarnings: dreamSummary?.warnings ?? [],
    verification: verification.summary,
  });

  return Object.freeze({
    trust_verdict: trust,
    digest_summary: digestCounts,
    doctor_summary: Object.freeze({
      warning_count: doctorResult.warnings.length,
      error_count: doctorResult.errors.length,
      warnings: doctorResult.warnings,
      errors: doctorResult.errors,
    }),
    dream_summary: dreamCounts,
    verification_delta: verification,
    top_actions: topActions,
    instruction_file_warnings: instructionWarnings,
  });
}

/**
 * Markdown rendering of the operator summary. Sections mirror the
 * JSON envelope; no headings for sections that are entirely empty.
 */
export function renderOperatorSummaryMarkdown(summary: OperatorSummary): string {
  const out: string[] = [];
  out.push("# Operator summary");
  out.push("");
  out.push(`Trust: **${summary.trust_verdict}**`);
  out.push("");
  out.push(
    `Doctor: ${summary.doctor_summary.warning_count} warning(s), ${summary.doctor_summary.error_count} error(s)`,
  );
  out.push(
    `Dream: ${summary.dream_summary.warning_count} warning(s), ${summary.dream_summary.uncertain_count} uncertain, ${summary.dream_summary.quarantined_count} quarantined`,
  );
  out.push(
    `Verification: ${summary.verification_delta.summary.confirmed} confirmed, ${summary.verification_delta.summary.drift} drift, ${summary.verification_delta.summary.regression} regression, ${summary.verification_delta.summary.missing_evidence} missing_evidence`,
  );
  out.push("");
  out.push(
    `Vault: ${summary.digest_summary.preference_count} preferences, ${summary.digest_summary.retired_count} retired, ${summary.digest_summary.inbox_count} inbox`,
  );

  if (summary.instruction_file_warnings.length > 0) {
    out.push("");
    out.push("## Instruction file warnings");
    out.push("");
    for (const w of summary.instruction_file_warnings) {
      out.push(`- \`${w.path}\` - ${w.lines} lines (ceiling ${w.ceiling})`);
    }
  }

  if (summary.top_actions.length > 0) {
    out.push("");
    out.push("## Top actions");
    out.push("");
    for (const a of summary.top_actions) {
      out.push(`- ${a.category}: ${a.title}`);
    }
  }

  out.push("");
  return out.join("\n");
}

// ----- Internals -----------------------------------------------------------

function safeDoctor(
  vault: string,
  guardrails: ResolvedBrainGuardrailConfig,
  dreamSummary: DreamRunSummary | undefined,
): RunDoctorResult {
  try {
    return runDoctor(vault, {
      guardrails,
      ...(dreamSummary ? { dreamSummary } : {}),
    });
  } catch {
    return Object.freeze({ warnings: [], errors: [] });
  }
}

function summariseDream(dream: DreamRunSummary | undefined): DreamSummary {
  if (dream === undefined) {
    return Object.freeze({
      warning_count: 0,
      uncertain_count: 0,
      quarantined_count: 0,
    });
  }
  return Object.freeze({
    warning_count: dream.warnings.length,
    uncertain_count: dream.uncertain.length,
    quarantined_count: dream.quarantined.length,
  });
}

function collectDigestCounts(vault: string): DigestSummary {
  const dirs = brainDirs(vault);
  return Object.freeze({
    preference_count: countMarkdownFiles(dirs.preferences),
    retired_count: countMarkdownFiles(dirs.retired),
    inbox_count: countMarkdownFiles(dirs.inbox),
  });
}

function countMarkdownFiles(dir: string): number {
  if (!existsSync(dir)) return 0;
  try {
    let n = 0;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".md")) continue;
      try {
        const s = statSync(`${dir}/${name}`);
        if (s.isFile()) n += 1;
      } catch {
        // Race: skip
      }
    }
    return n;
  } catch {
    return 0;
  }
}

function safeTopActions(vault: string, topN: number): ReadonlyArray<ActionItem> {
  try {
    const all = collectMaintenanceActions(vault);
    return Object.freeze(all.slice(0, Math.max(0, topN)));
  } catch {
    return Object.freeze([]);
  }
}

function zeroVerification(): VerificationDeltaResult {
  return Object.freeze({
    entries: Object.freeze([]),
    summary: Object.freeze({
      confirmed: 0,
      drift: 0,
      regression: 0,
      missing_evidence: 0,
    }),
  });
}
