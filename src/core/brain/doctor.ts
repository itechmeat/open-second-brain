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

import { join, relative, resolve } from "node:path";

import { toPosix } from "../path-safety.ts";
import { lookAtDirectory } from "../vault-unexaminable.ts";
import { BRAIN_ROOT_REL } from "./path-constants.ts";

import { activeBudgetPressureCheck } from "./doctor/active-budget-check.ts";
import type { DoctorCheck, DoctorCheckContext, DoctorFindings } from "./doctor/check.ts";
import { inboxArchivableCheck } from "./doctor/inbox-archive-check.ts";
import { privacyMarkerCheck } from "./doctor/privacy-marker-check.ts";
import { deliveryProvenanceCheck } from "./doctor/delivery-provenance-check.ts";
import { plantedRowsCheck } from "./doctor/planted-rows-check.ts";
import { capturePatternCheck, configCheck, vaultIgnoreCheck } from "./doctor/config-checks.ts";
import { entityRegistryCheck } from "./doctor/entity-checks.ts";
import { brokenBacklinkCheck } from "./doctor/link-checks.ts";
import { mergeChainDanglingCheck } from "./doctor/merge-chain-check.ts";
import { orphanSessionCheck } from "./doctor/orphan-session-check.ts";
import {
  permissionsDocumentCheck,
  permissionsLegacyOnlyCheck,
} from "./doctor/permissions-check.ts";
import { sessionIdentityCheck } from "./doctor/session-identity-check.ts";
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
  readLogSnapshot,
  type LogSnapshot,
  readAllPreferenceRecords,
} from "./doctor/records.ts";
import { embeddingSunsetCheck } from "./doctor/embedding-sunset-check.ts";
import { embeddingsHealthCheck } from "./doctor/embeddings-health-check.ts";
import { chunkHoldsCheck } from "./doctor/chunk-holds-check.ts";
import { rerankHealthCheck } from "./doctor/rerank-health-check.ts";
import { payloadRegistryCheck } from "./doctor/payload-checks.ts";
import { recallChannelCoverageCheck } from "./doctor/recall-channel-coverage.ts";
import { recoveryPointLivenessCheck } from "./doctor/recovery-point-liveness.ts";
import { storageCapacityCheck } from "./doctor/storage-capacity.ts";
import { receiptLedgerCheck } from "./doctor/receipt-ledger.ts";
import { receiptContentDriftCheck } from "./doctor/receipt-content-drift-check.ts";
import { removedToolReferenceCheck } from "./doctor/removed-tool-checks.ts";
import { makeStaleDependencyCheck } from "./doctor/stale-dependency-check.ts";
import { auditStaleDependencies } from "./stale-dependency.ts";
import { frozenVaultCheck } from "./doctor/frozen-check.ts";
import { deviceStateCheck } from "./doctor/device-state-check.ts";
import { adoptConflictsCheck } from "./doctor/adopt-conflicts-check.ts";
import { laneFolderCollisionCheck, laneIdMisfiledCheck } from "./doctor/lane-id-check.ts";
import { migrationCheck } from "./doctor/migration-check.ts";
import { storeCheck } from "./doctor/store-check.ts";
import { runStoreSideDoctor, STORE_SIDE_CHECKS } from "./doctor/store-side-pass.ts";
import { configuredStore } from "../store/read/store-entities.ts";
import { configuredVaultMissing, storeOnlyMode } from "../store/store-only.ts";
import { vaultBindingStatus } from "../vault-adapter/vault-binding.ts";
import { resolveConfiguredStoreRoot } from "../store/store-paths.ts";
import { viewWriterCheck } from "./doctor/view-writer-check.ts";
import { dreamOwnerCheck } from "./doctor/dream-owner-check.ts";
import { topicPlanCheck } from "./doctor/topic-plan-check.ts";
import { gitTrackedStateCheck } from "./doctor/git-tracked-state-check.ts";
import { secretsSyncExposureCheck } from "./doctor/secrets-sync-check.ts";
import { logChainCheck } from "./doctor/log-chain-check.ts";
import { lessonsBlockCheck } from "./doctor/lessons-block-check.ts";
import { attestationCheck } from "./doctor/attestation-check.ts";
import { checkSemanticHealth } from "./doctor/semantic-health-check.ts";
import {
  danglingWorkrunCheck,
  denyConsultedLanesCheck,
  freshenFailureCheck,
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
import { uncertainStream, type UncertainAdmission } from "./doctor/uncertain-stream.ts";
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
import {
  BRAIN_LOG_EVENT_KIND,
  type DoctorIssue,
  type InstructionFileCeilingWarning,
  type TrustVerdict,
} from "./types.ts";

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
import { withoutSeenRecording } from "../store/seen-shards.ts";

// ----- The registry ---------------------------------------------------------

/** The stale-dependency check over the unbounded collector. */
const STALE_DEPENDENCY_CHECK_UNBOUNDED = makeStaleDependencyCheck(auditStaleDependencies);

/**
 * The stale-dependency check, its collector bounded to the pages the
 * pass may read when the context carries a predicate, so a page the
 * caller cannot read is neither a state nor a consumer of one, and moves
 * no count of the note or the rows it renders.
 */
const staleDependencyCheck: DoctorCheck = {
  failSoft: STALE_DEPENDENCY_CHECK_UNBOUNDED.failSoft,
  run(ctx, out) {
    const readable = ctx.readable;
    if (readable === undefined) {
      STALE_DEPENDENCY_CHECK_UNBOUNDED.run(ctx, out);
      return;
    }
    makeStaleDependencyCheck((vault, opts) =>
      auditStaleDependencies(vault, { ...opts, readable }),
    ).run(ctx, out);
  },
};

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
  freshenFailureCheck,
  duplicateIdCheck,
  logShardCheck,
  brokenBacklinkCheck,
  mergeChainDanglingCheck,
  // The one check whose collector is supplied rather than imported: its
  // pure kernel is the leaf both halves share, so this registry - which
  // already reaches every check module and the store beneath them - is
  // where the two meet without closing a loop.
  staleDependencyCheck,
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
  orphanSessionCheck,
  // The blank-identity count reads the same ledger the orphan check's
  // resolution half reads, so the two session-identity checks report
  // adjacently.
  sessionIdentityCheck,
  entityRegistryCheck,
  capturePatternCheck,
  syncConflictLogCheck,
  frozenVaultCheck,
  secretsSyncExposureCheck,
  // The git-side twin of the sync-exposure check above: derived state
  // the vault scope ignores but git still carries (t_206562ae).
  gitTrackedStateCheck,
  inboxArchivableCheck,
  privacyMarkerCheck,
  // The delivery-trust wave's observable: how many delivered pages the fail-closed
  // fence covers for lack of any derivable provenance stamp (t_1af24938).
  deliveryProvenanceCheck,
  // The write-time twin of the privacy-marker count: third-party text
  // that planted live structure (t_c2ac4fc8), audited with the same
  // grammar the neutralizer escapes with.
  plantedRowsCheck,
  logChainCheck,
  // The lessons-block readiness check (t_1e952e43): the managed lessons
  // blocks of the agent rules files graded against the same derivation
  // a refresh would render. Fail-soft, read-only, operator-scope only.
  lessonsBlockCheck,
  // The lessons-block readiness check (t_1e952e43): the managed lessons
  // blocks of the agent rules files graded against the same derivation
  // a refresh would render. Fail-soft, read-only, operator-scope only.
  // The attestation liveness check (delivery trust, t_3bdb82b0): a stale,
  // unkeyed or diverged newest attestation, one warning under one code.
  attestationCheck,
  symlinkEscapeCheck,
  frontmatterUncertaintyProbe,
  lineageLedgerProbe,
  vaultMarkerProbe,
  staleLockProbe,
  recallChannelCoverageCheck,
  recoveryPointLivenessCheck,
  storageCapacityCheck,
  receiptLedgerCheck,
  receiptContentDriftCheck,
  embeddingSunsetCheck,
  embeddingsHealthCheck,
  chunkHoldsCheck,
  rerankHealthCheck,
  payloadRegistryCheck,
  permissionsDocumentCheck,
  permissionsLegacyOnlyCheck,
  // The brain store section (task 1.11): silent unless the store is in use.
  storeCheck,
  // The human view writer (task 2.7): silent unless the store is in use.
  viewWriterCheck,
  // The dream owner (agent-neutral dream): silent unless the role is enforced.
  dreamOwnerCheck,
  // Topic planning made nothing: the unassigned records name no project.
  topicPlanCheck,
  // The store migration (task 2.12): another device's entries in this
  // machine's device-local state, and a migration this machine has not run.
  deviceStateCheck,
  migrationCheck,
  // Machine state a switch kept aside (task 2.10).
  adoptConflictsCheck,
  // Lane ids an earlier release filed under another path (task 3.9).
  laneIdMisfiledCheck,
  laneFolderCollisionCheck,
  denyConsultedLanesCheck,
]);

// ----- Entry point ----------------------------------------------------------

/** Issue code for a resolved root that carries no Brain layer. */
const BRAIN_ROOT_ABSENT_CODE = "brain-root-absent";

/** Issue code for a configured vault whose folder is not there. */
const VAULT_FOLDER_MISSING_CODE = "vault-folder-missing";

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
  // The one look every layout decision makes (`lookAtDirectory`): a
  // Brain/ this process cannot list and traverse (mode 000 stats fine) is
  // unreadable, never present-and-empty.
  const look = lookAtDirectory(brain);
  if (look === "present") return { kind: "present" };
  if (look === "absent") return { kind: "absent" };
  return { kind: "unreadable", reason: sweptFailureReason(look.failed) ?? look.failed.message };
}

/** The three answers, kept apart because two of them used to be one. */
type BrainRootProbe =
  | { readonly kind: "present" }
  | { readonly kind: "absent" }
  | { readonly kind: "unreadable"; readonly reason: string };

/**
 * What a vault with no `Brain/` is on this machine:
 *
 *  - `store-only`: the brain is in a readable store and the store-only
 *    predicate says this machine is store-only for a reason other than
 *    the very absence being judged: it holds its own switch record, or
 *    the vault is the one init or the migration bound to the store
 *    (`../vault-adapter/vault-binding.ts`).
 *  - `unbound-store`: there is a store, but nothing says this vault is
 *    the intended one. That is the shape a mis-resolved root takes on a
 *    legacy machine whose store phase 1 dual write created
 *    (context-integrity-gates, Unit J), so the absence stays a warning.
 *  - `none`: there is no store.
 */
function storeOnlyShape(
  vault: string,
  configPath: string | undefined,
): "store-only" | "unbound-store" | "none" {
  if (configuredStore(configPath) === null) return "none";
  const mode = storeOnlyMode({ vault, ...(configPath !== undefined ? { configPath } : {}) });
  if (mode.reason === "device-switched") return "store-only";
  const binding = vaultBindingStatus(vault, configPath !== undefined ? { configPath } : {});
  if (mode.storeOnly && binding.state === "match") return "store-only";
  return "unbound-store";
}

/**
 * The pass of a machine with no vault: the store-side checks when there is
 * a store (`doctor/store-side-pass.ts`), else the absence.
 */
function runDoctorWithoutVault(opts: RunDoctorOptions): RunDoctorResult {
  const store = configuredStore(opts.configPath);
  if (store !== null) return runStoreSideDoctor(opts);
  let root: string;
  try {
    root = resolveConfiguredStoreRoot(opts.configPath).root;
  } catch (err) {
    root = `(unresolved: ${err instanceof Error ? err.message : String(err)})`;
  }
  const message = `no vault is configured and there is no brain store at ${root}; run \`o2b init\``;
  return Object.freeze({
    warnings: Object.freeze([
      {
        severity: "warning",
        code: BRAIN_ROOT_ABSENT_CODE,
        path: root,
        message,
      } satisfies DoctorIssue,
    ]),
    errors: Object.freeze([]),
    trust_verdict: "watch" as TrustVerdict,
    instruction_file_warnings: Object.freeze([]),
    uncertain: Object.freeze([
      {
        code: BRAIN_ROOT_ABSENT_CODE,
        path: root,
        message: "every Brain check was skipped: there is no vault and no store",
      },
    ]),
  });
}

export function runDoctor(vault: string | null, opts: RunDoctorOptions = {}): RunDoctorResult {
  // The doctor writes nothing: a shard gone since this machine read it is
  // reported, and no shard is recorded as seen.
  return withoutSeenRecording(() => withMissingVaultEntry(runDoctorPass(vault, opts), vault, opts));
}

/**
 * The missing-folder entry, in front of the pass's own warnings.
 *
 * A configured vault whose folder is not there (an unmounted disk, a
 * renamed folder) is not a fresh installation, and the pass cannot tell
 * it from one: the Brain layer it looks for is absent either way, and it
 * says so with `brain-root-absent` and the advice to run `o2b brain init`
 * - advice that starts a SECOND brain beside the real one. The entry
 * names the folder that is missing first, so the advice that stays is
 * read second.
 *
 * The entry is a warning of the pass, not a replacement for one: the
 * `brain-root-absent` finding and its advice stay exactly as they were.
 */
function withMissingVaultEntry(
  result: RunDoctorResult,
  vault: string | null,
  opts: RunDoctorOptions,
): RunDoctorResult {
  if (vault === null) return result;
  const missing = configuredVaultMissing(
    vault,
    opts.configPath !== undefined ? { configPath: opts.configPath } : {},
  );
  if (missing === null) return result;
  const entry: DoctorIssue = {
    severity: "warning",
    code: VAULT_FOLDER_MISSING_CODE,
    message: missing.notice,
  };
  return Object.freeze({ ...result, warnings: Object.freeze([entry, ...result.warnings]) });
}

function runDoctorPass(vault: string | null, opts: RunDoctorOptions): RunDoctorResult {
  if (vault === null) return runDoctorWithoutVault(opts);
  // Probed before `brainDirs`, whose path check would throw on a Brain/
  // it cannot look into: the doctor reports that as its finding.
  const brainRoot = join(vault, BRAIN_ROOT_REL);
  const root = brainRootProbe(brainRoot);
  if (root.kind === "unreadable") {
    // The layer is there and was not read. Every check below would have
    // reported the same denial for its own subtree, so the pass stops
    // here and says so once - under the code the sweeps already use for
    // a subtree they could not enter.
    const uncertain: DoctorUncertainEntry[] = [];
    const message = reportSweptSkip(brainRoot, `Brain layer could not be read: ${root.reason}`, {
      site: BRAIN_ROOT_SITE,
      consequence: "every Brain check was skipped, so nothing about this root has been verified",
      uncertain,
    });
    // A failing check, not a warning: nothing about this root was verified,
    // and every reader of it fails the same way (`vault_unreadable`).
    return Object.freeze({
      warnings: Object.freeze([]),
      errors: Object.freeze([
        { ...sweptPathWarning(brainRoot, message), severity: "error" as const },
      ]),
      trust_verdict: "investigate" as TrustVerdict,
      instruction_file_warnings: Object.freeze([]),
      uncertain: Object.freeze(uncertain),
    });
  }
  const dirs = brainDirs(vault);
  // A switched machine whose vault still holds the legacy tree it imported:
  // the tree is an archive until `--remove-legacy` takes it out, so the
  // pass reads the store, not the tree.
  if (root.kind === "present" && legacyTreeIsArchive(vault, opts.configPath)) {
    return runArchivedTreePass(vault, opts);
  }
  // A vault with no `Brain/` on a machine whose brain is the store is the
  // normal store-only shape, not a mis-resolved root: the brain is in the
  // store, so only the store-side checks run (design D14).
  const storeShape = root.kind === "absent" ? storeOnlyShape(vault, opts.configPath) : "none";
  // The store is the whole brain there: its checks still run.
  if (storeShape === "store-only") return runStoreSideDoctor(opts, vault);
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
      storeShape === "unbound-store"
        ? `no Brain layer at ${dirs.brain}, and this vault is not the one bound to the brain ` +
          `store; run \`o2b init --vault ${vault}\` if this is the intended vault, otherwise ` +
          "the resolved vault root is wrong"
        : `no Brain layer at ${dirs.brain}; run \`o2b brain init\` if this is the ` +
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
  const findings: DoctorFindings = {
    issues: [],
    uncertain: uncertainStream(uncertainAdmission(vault, opts.readable)),
  };
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
    semanticReport = checkSemanticHealth(
      vault,
      ctx.preferences,
      findings.issues,
      health,
      ctx.now,
      ctx.readable,
      ctx.configPath,
    );
  } catch {
    /* doctor never throws */
  }

  // Partition by severity. Stable sort preserves discovery order which
  // is convenient for tests asserting on `path`+`code`.
  const warnings = findings.issues.filter((i) => i.severity === "warning");
  const errors = findings.issues.filter((i) => i.severity === "error");

  // v0.10.16 trust layer. Each computation is best-effort: a failure
  // in a helper must not poison the legacy warning / error stream.
  const instructionWarnings = instructionWarningsOf(vault, opts);

  const verificationCounts = verificationCountsOf(vault, opts);

  const trustVerdict: TrustVerdict = computeTrustVerdict({
    doctorWarnings: warnings,
    doctorErrors: errors,
    dreamWarnings: opts.dreamSummary?.warnings ?? [],
    verification: verificationCounts ?? NO_VERIFICATION,
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
 * Whether `vault`'s legacy `Brain/` tree is an archive on this machine:
 * the machine switched to the brain store (its own switch record, or the
 * sticky marker) and the vault is the one bound to the store, so the tree
 * was imported and nothing writes it here any more. A vault configured
 * after the switch with a tree of its own is not bound: its tree has not
 * been imported yet, and the full pass still judges it. Any failure to
 * tell answers no, and the full pass runs as before.
 */
function legacyTreeIsArchive(vault: string, configPath: string | undefined): boolean {
  try {
    if (configuredStore(configPath) === null) return false;
    const context = { vault, ...(configPath !== undefined ? { configPath } : {}) };
    if (storeOnlyMode(context).reason !== "device-switched") return false;
    return (
      vaultBindingStatus(vault, configPath !== undefined ? { configPath } : {}).state === "match"
    );
  } catch {
    return false;
  }
}

/**
 * The checks over the store's records that also run on a switched machine
 * whose vault still holds the archived tree: each reads the store's folds
 * (`memoryFromStore`), never the tree, and their findings are the ones
 * `doctor --repair` derives the store-side evidence prune from. The id
 * index they fill is what {@link duplicateIdCheck} reads, so it follows them.
 */
const STORE_RECORD_CHECKS: ReadonlyArray<DoctorCheck> = Object.freeze([
  signalCheck,
  preferenceCheck,
  retiredCheck,
  duplicateIdCheck,
]);

/**
 * The vault-side checks the archived-tree pass keeps: each names a
 * condition of the vault or this machine that still matters while the tree
 * waits for `--remove-legacy` (and none of them is about the tree as an
 * archive), and each costs a few milliseconds on a real-size vault
 * (measured: at most 8 ms and 4 MB, the symlink sweep). The checks of the
 * full pass left out are about the tree itself (its config, its log, its
 * locks, its ledgers, its snapshots, its sync conflict copies, which the
 * migration already kept aside) or cost hundreds of milliseconds and are
 * not run after the removal either.
 */
const ARCHIVE_VAULT_CHECKS: ReadonlyArray<DoctorCheck> = Object.freeze([
  // The settings in force (the store's on a switched machine, with the
  // machine config): an invalid value is active configuration, not the tree.
  configCheck,
  frozenVaultCheck,
  secretsSyncExposureCheck,
  gitTrackedStateCheck,
  symlinkEscapeCheck,
  permissionsDocumentCheck,
  permissionsLegacyOnlyCheck,
  storageCapacityCheck,
  lessonsBlockCheck,
  embeddingSunsetCheck,
  embeddingsHealthCheck,
  chunkHoldsCheck,
  rerankHealthCheck,
  denyConsultedLanesCheck,
]);

/**
 * The pass of a switched machine whose vault still holds the legacy tree
 * it imported (between the switch and `--remove-legacy`): the store record
 * checks above, the vault-side checks that still matter, the store-side
 * checks the pass runs once the tree has left (`doctor/store-side-pass.ts`),
 * and the migration check, which says what `--remove-legacy` needs said
 * about the tree (the cohort, a tree that came back, a failed or available
 * migration). Nothing else walks or judges the tree: its log, its pages
 * and its lanes are an archive the store already holds, and reading them
 * made this pass several times slower and larger than the same pass after
 * the removal.
 */
function runArchivedTreePass(vault: string, opts: RunDoctorOptions): RunDoctorResult {
  const findings: DoctorFindings = {
    issues: [],
    uncertain: uncertainStream(uncertainAdmission(vault, opts.readable)),
  };
  let config;
  try {
    config = loadBrainConfigDetailed(vault).config;
  } catch {
    config = undefined;
  }
  const ctx: DoctorCheckContext = {
    vault,
    now: opts.now ?? new Date(),
    config,
    dbPath: opts.dbPath,
    configPath: opts.configPath,
    ...(opts.readable !== undefined ? { readable: opts.readable } : {}),
    ...(opts.reach !== undefined ? { reach: opts.reach } : {}),
    ...(opts.withholdsPrivate === true ? { withholdsPrivate: true } : {}),
    // On a switched vault the link targets are the store's record pages
    // plus two directory listings (the Brain/ root and its log folder, the
    // log days a retirement's `retired_by` names); no walk of the tree.
    knownBasenames: collectAllBasenames(vault, {
      site: CONTEXT_SITE,
      consequence:
        "its files are absent from the basename universe every link check resolves against, so " +
        "a wikilink that resolves under it reads as broken here",
      uncertain: findings.uncertain,
    }),
    idIndex: new Map<string, string[]>(),
    preferences: [],
    // No check of this pass reads the log.
    logs: [],
  };
  const checks = [
    ...STORE_RECORD_CHECKS,
    ...ARCHIVE_VAULT_CHECKS,
    ...STORE_SIDE_CHECKS,
    migrationCheck,
  ];
  for (const check of checks) {
    if (!check.failSoft) {
      check.run(ctx, findings);
      continue;
    }
    try {
      check.run(ctx, findings);
    } catch {
      /* doctor never throws */
    }
  }
  const warnings = findings.issues.filter((i) => i.severity === "warning");
  const errors = findings.issues.filter((i) => i.severity === "error");
  const verificationCounts = verificationCountsOf(vault, opts);
  return Object.freeze({
    warnings: Object.freeze(warnings),
    errors: Object.freeze(errors),
    trust_verdict: computeTrustVerdict({
      doctorWarnings: warnings,
      doctorErrors: errors,
      dreamWarnings: opts.dreamSummary?.warnings ?? [],
      verification: verificationCounts ?? NO_VERIFICATION,
    }),
    ...(verificationCounts !== undefined ? { verification_delta_summary: verificationCounts } : {}),
    instruction_file_warnings: instructionWarningsOf(vault, opts),
    ...(findings.uncertain.length > 0 ? { uncertain: Object.freeze(findings.uncertain) } : {}),
  });
}

/**
 * The agent instruction files of the vault (`CLAUDE.md`, `AGENTS.md`, ...)
 * past their line ceiling, as every vault pass reports them; none when the
 * check fails.
 */
function instructionWarningsOf(
  vault: string,
  opts: RunDoctorOptions,
): ReadonlyArray<InstructionFileCeilingWarning> {
  const guardrails = opts.guardrails ?? BRAIN_GUARDRAIL_DEFAULTS;
  try {
    return checkInstructionFileCeiling(vault, {
      maxLines: guardrails.instruction_file_max_lines,
      ...(opts.readable !== undefined ? { readable: opts.readable } : {}),
    });
  } catch {
    /* doctor never throws */
    return [];
  }
}

/** The verification counts of a pass with no dream summary to compare. */
const NO_VERIFICATION: VerificationDeltaSummaryCounts = Object.freeze({
  confirmed: 0,
  drift: 0,
  regression: 0,
  missing_evidence: 0,
});

/**
 * The verification delta of the caller's dream summary, as every pass
 * computes it; absent with no summary or when the computation fails.
 */
function verificationCountsOf(
  vault: string,
  opts: RunDoctorOptions,
): VerificationDeltaSummaryCounts | undefined {
  if (opts.dreamSummary === undefined) return undefined;
  try {
    return computeVerificationDelta(vault, opts.dreamSummary).summary;
  } catch {
    /* doctor never throws */
    return undefined;
  }
}

/** The extension of the pages the reference grammar judges by path. */
const PAGE_EXT = ".md";

/**
 * Which uncertainty entries a pass handed `readable` may report.
 *
 * Judged the way the handlers' reference view judges an issue's path, so
 * the entries it keeps are the ones the view would keep after the cap: a
 * page path is admitted only when the reader may read it, and any other
 * path - a directory, a lock, a file outside the vault - names no page
 * and is admitted as before. `undefined` when nothing is withheld.
 */
function uncertainAdmission(
  vault: string,
  readable: ((rel: string) => boolean) | undefined,
): UncertainAdmission | undefined {
  if (readable === undefined) return undefined;
  return (entry) =>
    entry.path === undefined ||
    !entry.path.endsWith(PAGE_EXT) ||
    readable(toPosix(relative(vault, resolve(vault, entry.path))));
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
  // Read in the literal's own order below, so the uncertainty stream keeps
  // the order it has always had.
  let logSnapshot: LogSnapshot;
  return {
    vault,
    now: opts.now ?? new Date(),
    config,
    dbPath: opts.dbPath,
    configPath: opts.configPath,
    ...(opts.readable !== undefined ? { readable: opts.readable } : {}),
    ...(opts.reach !== undefined ? { reach: opts.reach } : {}),
    ...(opts.withholdsPrivate === true ? { withholdsPrivate: true } : {}),
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
    preferences: readAllPreferenceRecords(
      vault,
      {
        site: CONTEXT_SITE,
        consequence:
          "no preference in it was loaded, so every preference-hygiene lint below reports on a " +
          "subset of the store",
        uncertain,
      },
      opts.configPath,
    ),
    logs: (logSnapshot = readLogSnapshot(
      vault,
      {
        site: CONTEXT_SITE,
        consequence:
          "no log day in it was loaded, so the evidence and orphan lints below report on a subset " +
          "of the store",
        uncertain,
      },
      opts.configPath,
      DOCTOR_LOG_EVENTS,
    )).records,
    unreadableLogDays: logSnapshot.unreadableDays,
  };
}

/** Subsystem name the shared context reports an unreadable path under. */
const CONTEXT_SITE = "brain.doctor.context";

/**
 * The log events the checks that read `DoctorCheckContext.logs` use: the
 * evidence lints (`log-checks.ts`) and the orphan sweep's session index
 * (`orphan-session-check.ts`). A check that reads another type from the
 * context's log adds it here.
 */
const DOCTOR_LOG_EVENTS: ReadonlySet<string> = new Set([
  BRAIN_LOG_EVENT_KIND.applyEvidence,
  BRAIN_LOG_EVENT_KIND.sessionLifecycle,
]);
