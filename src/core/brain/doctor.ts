/**
 * Brain layer invariant checker (design doc §13.5).
 *
 * Pure read. Walks `<vault>/Brain/` and reports a list of issues. The
 * caller decides the exit code: warnings are non-blocking, errors
 * indicate a corrupt state. The CLI (`o2b brain doctor [--strict]`)
 * wraps the result; this module ships the structured object.
 *
 * The checks themselves have nothing to do with one another, so each
 * lives in its own module under `doctor/` and this file is the registry:
 * it resolves the one context they read, runs {@link DOCTOR_CHECKS} in
 * order, and assembles the report. A new check joins the pass by being
 * added to that array - the order of the array is the order findings are
 * reported in, which several tests assert on.
 *
 * Invariants checked:
 *
 *   1. **Schema version.** `Brain/_brain.yaml schema_version` is known
 *      to this build. Unknown → error.
 *   2. **Required fields per kind.** Signal / preference / retired
 *      frontmatter parses through the Task 2 parsers, which throw on
 *      missing required fields. We re-wrap the throw as an error issue.
 *   3. **Status-vs-folder.** A file in `preferences/` whose status is
 *      not `unconfirmed` / `confirmed` is a warning; a file in
 *      `retired/` whose status is not `retired` is a warning.
 *      `BrainStatusFolderMismatchError` from the parsers feeds this.
 *   4. **Broken wikilinks.** Every `[[basename]]` referenced by
 *      `evidenced_by`, `supersedes`, `superseded_by`, or `retired_by`
 *      on any Brain artifact must resolve to an existing Markdown file
 *      somewhere inside `Brain/` (basename match, Obsidian-style).
 *      Unresolved → warning.
 *   5. **Duplicate id.** Two distinct files whose frontmatter `id` is
 *      identical → error.
 *   6. **Invalid ISO.** `created_at`, `unconfirmed_until`,
 *      `confirmed_at`, `last_evidence_at`, `retired_at` parse as
 *      ISO-8601 timestamps (`null` / missing acceptable for the
 *      optional ones). Bad → error.
 *   7. **Log header parsing.** Every malformed `## <HH:MM:SS>Z — kind`
 *      block surfaced by `parseLogDayFile` (per shard) is forwarded here.
 *
 * The function never mutates state. It will gracefully tolerate a
 * vault that has no Brain layer yet (returns clean) — same shape as
 * the existing `doctor` legacy command on an empty vault.
 */

import { statSync } from "node:fs";

import { activeBudgetPressureCheck } from "./doctor/active-budget-check.ts";
import type { DoctorCheck, DoctorCheckContext, DoctorFindings } from "./doctor/check.ts";
import { capturePatternCheck, configCheck, vaultIgnoreCheck } from "./doctor/config-checks.ts";
import { entityRegistryCheck } from "./doctor/entity-checks.ts";
import { brokenBacklinkCheck } from "./doctor/link-checks.ts";
import { evidenceRangeCheck, logShardCheck, orphanEvidenceCheck } from "./doctor/log-checks.ts";
import {
  contentHashDriftCheck,
  duplicatePreferenceCheck,
  topicKeyCollisionCheck,
  lowEvidenceConfirmedCheck,
  pinnedWithoutRecentEvidenceCheck,
} from "./doctor/preference-hygiene.ts";
import {
  duplicateIdCheck,
  preferenceCheck,
  retiredCheck,
  signalCheck,
} from "./doctor/record-checks.ts";
import {
  collectAllBasenames,
  readAllLogRecords,
  readAllPreferenceRecords,
} from "./doctor/records.ts";
import { recallChannelCoverageCheck } from "./doctor/recall-channel-coverage.ts";
import { removedToolReferenceCheck } from "./doctor/removed-tool-checks.ts";
import { makeStaleDependencyCheck } from "./doctor/stale-dependency-check.ts";
import { auditStaleDependencies } from "./stale-dependency.ts";
import { checkSemanticHealth } from "./doctor/semantic-health-check.ts";
import {
  danglingWorkrunCheck,
  symlinkEscapeCheck,
  syncConflictLogCheck,
  tierDriftCheck,
} from "./doctor/store-integrity.ts";
import {
  frontmatterUncertaintyProbe,
  lineageLedgerProbe,
  staleLockProbe,
  vaultMarkerProbe,
} from "./doctor/uncertainty-probes.ts";
import type { DoctorUncertainEntry, RunDoctorOptions, RunDoctorResult } from "./doctor/report.ts";
import { reportSweptSkip, sweptFailureReason, sweptPathWarning } from "./doctor/unreadable-path.ts";
import type { SemanticHealthReport } from "./health/reconcile.ts";
import { brainDirs } from "./paths.ts";
import {
  BRAIN_GUARDRAIL_DEFAULTS,
  BRAIN_HEALTH_DEFAULTS,
  loadBrainConfigDetailed,
  resolveHealth,
} from "./policy.ts";
import { computeTrustVerdict } from "./trust/compute-trust-verdict.ts";
import {
  computeVerificationDelta,
  type VerificationDeltaSummaryCounts,
} from "./trust/compute-verification-delta.ts";
import { checkInstructionFileCeiling } from "./trust/instruction-file-ceiling.ts";
import type { DoctorIssue, InstructionFileCeilingWarning, TrustVerdict } from "./types.ts";

// ----- Public surface -------------------------------------------------------
//
// `DoctorSeverity`, `DoctorIssue`, `TrustVerdict`, and
// `InstructionFileCeilingWarning` live in `./types.ts` — a leaf module
// with no imports of its own — so the `trust/` helpers below can depend
// on those shapes without importing this file.

export { collectAllBasenames } from "./doctor/records.ts";
export { computeSemanticHealth } from "./doctor/semantic-health-check.ts";
export type {
  DoctorUncertainEntry,
  RunDoctorOptions,
  RunDoctorResult,
  VerificationDeltaSummary,
} from "./doctor/report.ts";

// ----- The registry ---------------------------------------------------------

/**
 * Every check the pass runs, in report order.
 *
 * The order is part of the contract: findings are reported in discovery
 * order and the id index the record checks fill is what
 * {@link duplicateIdCheck} reads, so it has to follow them.
 */
const DOCTOR_CHECKS: ReadonlyArray<DoctorCheck> = Object.freeze([
  configCheck,
  vaultIgnoreCheck,
  signalCheck,
  preferenceCheck,
  retiredCheck,
  tierDriftCheck,
  duplicateIdCheck,
  logShardCheck,
  brokenBacklinkCheck,
  // The one check whose collector is supplied rather than imported: its
  // pure kernel is the leaf both halves share, so this registry - which
  // already reaches every check module and the store beneath them - is
  // where the two meet without closing a loop.
  makeStaleDependencyCheck(auditStaleDependencies),
  removedToolReferenceCheck,
  duplicatePreferenceCheck,
  topicKeyCollisionCheck,
  lowEvidenceConfirmedCheck,
  pinnedWithoutRecentEvidenceCheck,
  contentHashDriftCheck,
  danglingWorkrunCheck,
  activeBudgetPressureCheck,
  evidenceRangeCheck,
  orphanEvidenceCheck,
  entityRegistryCheck,
  capturePatternCheck,
  syncConflictLogCheck,
  symlinkEscapeCheck,
  frontmatterUncertaintyProbe,
  lineageLedgerProbe,
  vaultMarkerProbe,
  staleLockProbe,
  recallChannelCoverageCheck,
]);

// ----- Entry point ----------------------------------------------------------

/** Issue code for a resolved root that carries no Brain layer. */
const BRAIN_ROOT_ABSENT_CODE = "brain-root-absent";

/** Subsystem name the pass reports a Brain layer it could not reach under. */
const BRAIN_ROOT_SITE = "brain.doctor.root";

/**
 * Whether the Brain layer is there, is not, or could not be reached.
 *
 * `existsSync` used to stand here, and it answers false for a permission
 * denial on any parent component exactly as it does for a root nobody
 * has initialized. The two then produced the same report - and that
 * report advises `o2b brain init`, which on a populated vault whose root
 * an operator locked down is advice to write into a store this pass
 * never managed to look at.
 */
function brainRootProbe(brain: string): BrainRootProbe {
  try {
    statSync(brain);
    return { kind: "present" };
  } catch (err) {
    const reason = sweptFailureReason(err);
    return reason === null ? { kind: "absent" } : { kind: "unreadable", reason };
  }
}

/** The three answers, kept apart because two of them used to be one. */
type BrainRootProbe =
  | { readonly kind: "present" }
  | { readonly kind: "absent" }
  | { readonly kind: "unreadable"; readonly reason: string };

export function runDoctor(vault: string, opts: RunDoctorOptions = {}): RunDoctorResult {
  const dirs = brainDirs(vault);
  const root = brainRootProbe(dirs.brain);
  if (root.kind === "unreadable") {
    // The layer is there and was not read. Every check below would have
    // reported the same denial for its own subtree, so the pass stops
    // here and says so once - under the code the sweeps already use for
    // a subtree they could not enter.
    const uncertain: DoctorUncertainEntry[] = [];
    const message = reportSweptSkip(dirs.brain, `Brain layer could not be read: ${root.reason}`, {
      site: BRAIN_ROOT_SITE,
      consequence: "every Brain check was skipped, so nothing about this root has been verified",
      uncertain,
    });
    return Object.freeze({
      warnings: Object.freeze([sweptPathWarning(dirs.brain, message)]),
      errors: Object.freeze([]),
      trust_verdict: "watch" as TrustVerdict,
      instruction_file_warnings: Object.freeze([]),
      uncertain: Object.freeze(uncertain),
    });
  }
  if (root.kind === "absent") {
    // A root with no Brain layer is NOT clean (context-integrity-gates,
    // Unit J). It is exactly the shape a mis-resolved vault takes, and
    // reporting it as clean is what let a wrong root pass the one
    // command an operator runs to check the store. It is still not an
    // error - an un-initialized vault is legitimate - so it is reported
    // as a named warning plus an `uncertain` entry: every check below
    // was skipped, so nothing about this root has actually been
    // verified.
    const message =
      `no Brain layer at ${dirs.brain}; run \`o2b brain init\` if this is the ` +
      "intended vault, otherwise the resolved vault root is wrong";
    return Object.freeze({
      warnings: Object.freeze([
        {
          severity: "warning",
          code: BRAIN_ROOT_ABSENT_CODE,
          path: dirs.brain,
          message,
        } satisfies DoctorIssue,
      ]),
      errors: Object.freeze([]),
      trust_verdict: "watch" as TrustVerdict,
      instruction_file_warnings: Object.freeze([]),
      uncertain: Object.freeze([
        {
          code: BRAIN_ROOT_ABSENT_CODE,
          path: dirs.brain,
          message: "every Brain check was skipped: the layer is absent",
        },
      ]),
    });
  }

  // The findings first, because the context is itself read from disk and
  // its three directory reads have to be able to report. Resolved before
  // any check runs, an unreadable `Brain/preferences` or a `Brain/log`
  // that is a regular file ended the pass with no findings at all.
  const findings: DoctorFindings = { issues: [], uncertain: [] };
  const ctx = resolveContext(vault, opts, findings.uncertain);
  for (const check of DOCTOR_CHECKS) {
    if (!check.failSoft) {
      check.run(ctx, findings);
      continue;
    }
    // A fail-soft check that throws must not mask the findings of the
    // ones after it: the doctor's whole job is to report the condition
    // it can see, and one broken scan is not a reason to report nothing.
    try {
      check.run(ctx, findings);
    } catch {
      /* doctor never throws */
    }
  }

  // v0.14.0 semantic-health pass. Best-effort like every other lint:
  // a failure here must not poison the structural warning / error
  // stream. The report is attached to the result even on a clean run
  // (empty domains, `clean` verdict); it stays `undefined` only when
  // the pass threw. It sits outside the registry because it is the one
  // check that also RETURNS something the report carries.
  let semanticReport: SemanticHealthReport | undefined;
  try {
    const health = ctx.config ? resolveHealth(ctx.config) : BRAIN_HEALTH_DEFAULTS;
    semanticReport = checkSemanticHealth(vault, ctx.preferences, findings.issues, health, ctx.now);
  } catch {
    /* doctor never throws */
  }

  // Partition by severity. Stable sort preserves discovery order which
  // is convenient for tests asserting on `path`+`code`.
  const warnings = findings.issues.filter((i) => i.severity === "warning");
  const errors = findings.issues.filter((i) => i.severity === "error");

  // v0.10.16 trust layer. Each computation is best-effort: a failure
  // in a helper must not poison the legacy warning / error stream.
  const guardrails = opts.guardrails ?? BRAIN_GUARDRAIL_DEFAULTS;
  let instructionWarnings: ReadonlyArray<InstructionFileCeilingWarning> = [];
  try {
    instructionWarnings = checkInstructionFileCeiling(vault, {
      maxLines: guardrails.instruction_file_max_lines,
    });
  } catch {
    /* doctor never throws */
  }

  let verificationCounts: VerificationDeltaSummaryCounts | undefined;
  if (opts.dreamSummary !== undefined) {
    try {
      const delta = computeVerificationDelta(vault, opts.dreamSummary);
      verificationCounts = delta.summary;
    } catch {
      /* doctor never throws */
    }
  }

  const trustVerdict: TrustVerdict = computeTrustVerdict({
    doctorWarnings: warnings,
    doctorErrors: errors,
    dreamWarnings: opts.dreamSummary?.warnings ?? [],
    verification: verificationCounts ?? {
      confirmed: 0,
      drift: 0,
      regression: 0,
      missing_evidence: 0,
    },
  });

  return Object.freeze({
    warnings: Object.freeze(warnings),
    errors: Object.freeze(errors),
    trust_verdict: trustVerdict,
    ...(verificationCounts !== undefined ? { verification_delta_summary: verificationCounts } : {}),
    instruction_file_warnings: instructionWarnings,
    // Conditional so a clean vault's result - and therefore the CLI's
    // `--json` payload - is byte-identical to the shape it had before
    // this field had a producer.
    ...(findings.uncertain.length > 0 ? { uncertain: Object.freeze(findings.uncertain) } : {}),
    ...(semanticReport !== undefined ? { semantic_health: semanticReport } : {}),
  });
}

/**
 * Resolve everything the checks read, once.
 *
 * The config load is the only step that may legitimately fail here: an
 * unreadable `_brain.yaml` is itself a finding {@link configCheck}
 * reports, and the config-dependent lints simply do not run without one.
 *
 * The three directory reads run outside the pass's fail-soft loop, so
 * each is handed the uncertainty stream: a directory they cannot read
 * shrinks what every check downstream sees, and that has to be a finding
 * rather than a throw before the first check or a silently smaller set.
 */
function resolveContext(
  vault: string,
  opts: RunDoctorOptions,
  uncertain: DoctorUncertainEntry[],
): DoctorCheckContext {
  let config;
  try {
    config = loadBrainConfigDetailed(vault).config;
  } catch {
    config = undefined;
  }
  return {
    vault,
    now: opts.now ?? new Date(),
    config,
    dbPath: opts.dbPath,
    configPath: opts.configPath,
    knownBasenames: collectAllBasenames(vault, {
      site: CONTEXT_SITE,
      consequence:
        "its files are absent from the basename universe every link check resolves against, so " +
        "a wikilink that resolves under it reads as broken here",
      uncertain,
    }),
    idIndex: new Map<string, string[]>(),
    // Built once and fed to every lint that needs them, rather than
    // re-parsing the same files five times.
    preferences: readAllPreferenceRecords(vault, {
      site: CONTEXT_SITE,
      consequence:
        "no preference in it was loaded, so every preference-hygiene lint below reports on a " +
        "subset of the store",
      uncertain,
    }),
    logs: readAllLogRecords(vault, {
      site: CONTEXT_SITE,
      consequence:
        "no log day in it was loaded, so the evidence and orphan lints below report on a subset " +
        "of the store",
      uncertain,
    }),
  };
}

/** Subsystem name the shared context reports an unreadable path under. */
const CONTEXT_SITE = "brain.doctor.context";
