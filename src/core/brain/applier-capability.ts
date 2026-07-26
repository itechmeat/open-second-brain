/**
 * The applier capability table (no-dead-ends, task 8).
 *
 * Three Finding-to-apply pipelines ship in this codebase - `applyRepair`
 * (`diagnostics.ts`), `applyHygienePlan` (`hygiene/apply.ts`) and
 * `applyRemediation` (`health/remediation.ts`) - plus the self-healing
 * consolidation pass in `lint-consolidate.ts`. Each one used to decide
 * privately what it could repair, so the question "is this finding
 * mechanically fixable, and if not why not?" had four partial answers and
 * no single one. This module is that answer: per finding code, either
 * MECHANICAL (naming the fixer that performs the repair) or REFUSED
 * (naming the reason it is not attempted).
 *
 * A refusal is a deliverable here. Every entry below that declines a
 * repair states why in a non-empty reason, because a finding whose exit
 * is "nothing happens" is exactly the dead end this release removes.
 *
 * ## Why this is its own module, and why it imports nothing
 *
 * The design left the placement open, to be decided by import surface.
 * The table's consumers are the three appliers plus `hygiene/plan.ts`,
 * and its natural alternative home - `diagnostics.ts`, beside the fixer
 * registry - transitively pulls in `doctor.ts`, the whole detection pass.
 * Hosting the table there would make `health/remediation.ts` and
 * `hygiene/plan.ts` import the detector in order to ask a question about
 * repair, and would make the dependency circular the moment
 * `diagnostics.ts` consulted the table itself.
 *
 * So this module is a plain-data leaf with NO imports, and every code in
 * it is written as a literal rather than referenced from the constant
 * that also spells it. The literals are bound to their sources by
 * `tests/core/brain/applier-capability.test.ts`, which re-derives the
 * same population from the fixer registry, the remediation planner, the
 * hygiene plan builder and the lint fix kinds, and fails on any
 * disagreement in either direction. The binding is a test rather than an
 * import on purpose: it is the only form that also catches a fixer added
 * without a table entry.
 *
 * ## Write-guard placement: the one rule
 *
 * The three appliers used to place `assertVaultIdentityForWrite` three
 * different ways - hygiene after its dry-run return, repair before it and
 * conditional on it, remediation unconditionally including on dry runs.
 * The unified rule, which all four write paths now follow:
 *
 *   ASSERT AT THE APPLIER'S ENTRY POINT, BEFORE ANY OTHER WORK, AND ONLY
 *   WHEN THE CALL WILL WRITE.
 *
 * Both halves carry a reason and both come from a placement that already
 * existed.
 *
 *   - "Before any other work" is hygiene's rationale, generalised. Its
 *     per-finding loop is fail-soft, so an assertion reached from inside
 *     an executor would be recorded as one finding's error instead of
 *     refusing the run; and more generally a refusal that arrives after
 *     the first byte is on disk has already materialized the wrong store.
 *   - "Only when the call will write" is the repair path's rationale, and
 *     it is what the guard's own contract says: it is a WRITE guard. A
 *     dry run writes nothing, so gating it turns a preview - the very
 *     thing an operator reaches for to find out what is wrong - into a
 *     refusal. Remediation's unconditional placement was the outlier and
 *     is the behaviour that changed.
 *
 * `lint-consolidate.ts` follows the same rule (task 10): it used to
 * assert unconditionally, which let the read-only `o2b brain actions`
 * verb fail with a write-path error.
 */

/** Whether a finding code has a mechanical repair, or a stated refusal. */
export const REPAIR_VERDICT = Object.freeze({
  mechanical: "mechanical",
  refused: "refused",
} as const);

export type RepairVerdict = (typeof REPAIR_VERDICT)[keyof typeof REPAIR_VERDICT];

/**
 * The module that owns the repair (or the refusal). `detectorOnly` is for
 * codes a detector reports and no applier claims - those can only ever be
 * refusals, asserted by the capability test.
 */
export const REPAIR_SURFACE = Object.freeze({
  diagnostics: "diagnostics",
  healthRemediation: "health/remediation",
  hygieneApply: "hygiene/apply",
  lintConsolidate: "lint-consolidate",
  detectorOnly: "detector-only",
} as const);

export type RepairSurface = (typeof REPAIR_SURFACE)[keyof typeof REPAIR_SURFACE];

interface RepairCapabilityBase {
  /** The finding code, exactly as the detecting surface emits it. */
  readonly code: string;
  readonly surface: RepairSurface;
}

/** A code a named fixer repairs safely, deterministically and idempotently. */
export interface MechanicalRepair extends RepairCapabilityBase {
  readonly verdict: typeof REPAIR_VERDICT.mechanical;
  /** The function that performs the repair, named so the claim is checkable. */
  readonly fixer: string;
}

/** A code no applier will repair, with the reason it will not. */
export interface RefusedRepair extends RepairCapabilityBase {
  readonly verdict: typeof REPAIR_VERDICT.refused;
  /** Why the repair is not attempted. Never empty. */
  readonly reason: string;
}

export type RepairCapability = MechanicalRepair | RefusedRepair;

/** A code that appears in no table entry. Never resolved to a guess. */
export class UnclassifiedRepairCodeError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(
      `no applier capability is published for finding code ${JSON.stringify(code)}; ` +
        "add an entry to APPLIER_CAPABILITY declaring it mechanical or refused",
    );
    this.name = "UnclassifiedRepairCodeError";
    this.code = code;
  }
}

/** A mechanical repair was demanded for a code the table refuses. */
export class RefusedRepairError extends Error {
  readonly code: string;
  readonly reason: string;
  constructor(entry: RefusedRepair) {
    super(`finding code ${JSON.stringify(entry.code)} has no mechanical repair: ${entry.reason}`);
    this.name = "RefusedRepairError";
    this.code = entry.code;
    this.reason = entry.reason;
  }
}

/** Two entries claimed the same code - the table would silently lose one. */
export class DuplicateRepairCodeError extends Error {
  constructor(code: string) {
    super(`APPLIER_CAPABILITY declares finding code ${JSON.stringify(code)} more than once`);
    this.name = "DuplicateRepairCodeError";
  }
}

const ENTRIES: ReadonlyArray<RepairCapability> = [
  // --- diagnostics: the two guarded doctor fixers -------------------------
  {
    code: "wal-gap",
    surface: REPAIR_SURFACE.diagnostics,
    verdict: REPAIR_VERDICT.mechanical,
    fixer: "diagnostics.walGapFixer",
  },
  {
    code: "orphaned-reference",
    surface: REPAIR_SURFACE.diagnostics,
    verdict: REPAIR_VERDICT.mechanical,
    fixer: "diagnostics.orphanedReferenceFixer",
  },

  // --- health/remediation: bookkeeping repairs, semantic review -----------
  {
    code: "content-hash-drift",
    surface: REPAIR_SURFACE.healthRemediation,
    verdict: REPAIR_VERDICT.mechanical,
    fixer: "health/remediation.restampContentHash",
  },
  {
    code: "wide-permissions",
    surface: REPAIR_SURFACE.healthRemediation,
    verdict: REPAIR_VERDICT.mechanical,
    fixer: "health/remediation.hardenPermissions",
  },
  {
    code: "contradictory-preferences",
    surface: REPAIR_SURFACE.healthRemediation,
    verdict: REPAIR_VERDICT.refused,
    reason:
      "which of the two rules survives is a judgment about what the operator " +
      "currently believes; an applier picking one would retire a rule nobody " +
      "decided to retire",
  },
  {
    code: "stale-claim",
    surface: REPAIR_SURFACE.healthRemediation,
    verdict: REPAIR_VERDICT.refused,
    reason:
      "age is evidence that a claim needs re-confirming, not evidence that it " +
      "is wrong; only the operator can tell an obsolete rule from a durable one " +
      "that simply has not come up",
  },
  {
    code: "concept-gap",
    surface: REPAIR_SURFACE.healthRemediation,
    verdict: REPAIR_VERDICT.refused,
    reason:
      "the repair is to write a preference that does not exist yet, which is " +
      "authoring content rather than repairing a record",
  },

  // --- hygiene/apply: one executor per proposed action --------------------
  {
    code: "merge",
    surface: REPAIR_SURFACE.hygieneApply,
    verdict: REPAIR_VERDICT.mechanical,
    fixer: "hygiene/apply.executeFinding -> mergePreferences",
  },
  {
    code: "supersede",
    surface: REPAIR_SURFACE.hygieneApply,
    verdict: REPAIR_VERDICT.mechanical,
    fixer: "hygiene/apply.executeFinding -> appendClaimEvent",
  },
  {
    code: "recompile",
    surface: REPAIR_SURFACE.hygieneApply,
    verdict: REPAIR_VERDICT.mechanical,
    fixer: "hygiene/apply.executeFinding -> executeRecompile",
  },
  {
    code: "archive",
    surface: REPAIR_SURFACE.hygieneApply,
    verdict: REPAIR_VERDICT.mechanical,
    fixer: "hygiene/apply.executeFinding -> archivePage",
  },
  {
    code: "forget",
    surface: REPAIR_SURFACE.hygieneApply,
    verdict: REPAIR_VERDICT.mechanical,
    fixer: "hygiene/apply.executeFinding -> archivePage",
  },
  {
    code: "review",
    surface: REPAIR_SURFACE.hygieneApply,
    verdict: REPAIR_VERDICT.refused,
    reason:
      "the closed action vocabulary's safe default: a detector routes a finding " +
      "here precisely when it cannot name an executor for it, so there is nothing " +
      "to run",
  },

  // --- lint-consolidate: the self-healing structural pass -----------------
  {
    code: "fix-merged-link",
    surface: REPAIR_SURFACE.lintConsolidate,
    verdict: REPAIR_VERDICT.mechanical,
    fixer: "lint-consolidate.scanFileForMergedLinks",
  },
  {
    code: "demote-stale-stable",
    surface: REPAIR_SURFACE.lintConsolidate,
    verdict: REPAIR_VERDICT.mechanical,
    fixer: "lint-consolidate.applyDemotion",
  },

  // --- detector-only: reported, deliberately never repaired ---------------
  {
    code: "stale-lock",
    surface: REPAIR_SURFACE.detectorOnly,
    verdict: REPAIR_VERDICT.refused,
    reason:
      "the lock primitive is a single-attempt exclusive create with no breaker, " +
      "so no timeout distinguishes a crashed writer from a slow live one; " +
      "removing a live writer's lock corrupts what it protects",
  },
  {
    code: "vault-marker-absent",
    surface: REPAIR_SURFACE.detectorOnly,
    verdict: REPAIR_VERDICT.refused,
    reason:
      "an absent marker is ambiguous by construction - a fresh directory, a vault " +
      "predating markers and a mis-resolved root are indistinguishable - so " +
      "stamping one would name whichever root the typo produced",
  },
  {
    code: "frontmatter-line-dropped",
    surface: REPAIR_SURFACE.detectorOnly,
    verdict: REPAIR_VERDICT.refused,
    reason:
      "the frontmatter scanner is line-based, so a dropped line is by definition " +
      "grammar it has no branch for; repairing it means choosing a target shape " +
      "per case, which is a policy decision rather than a mechanical fix",
  },
  {
    code: "link_integrity",
    surface: REPAIR_SURFACE.detectorOnly,
    verdict: REPAIR_VERDICT.refused,
    reason:
      "the ratchet measurement yields scalar counts over the search index and no " +
      "per-link rows, so there is no individual finding for an applier to act on",
  },
];

/**
 * The published table, keyed by finding code. Built eagerly so a
 * duplicate code fails at import rather than silently losing an entry.
 */
export const APPLIER_CAPABILITY: ReadonlyMap<string, RepairCapability> = (() => {
  const table = new Map<string, RepairCapability>();
  for (const entry of ENTRIES) {
    if (table.has(entry.code)) throw new DuplicateRepairCodeError(entry.code);
    table.set(entry.code, Object.freeze(entry));
  }
  return table;
})();

/** The published capability for `code`, or `null` when none is published. */
export function repairCapability(code: string): RepairCapability | null {
  return APPLIER_CAPABILITY.get(code) ?? null;
}

/**
 * The published capability for `code`, or {@link UnclassifiedRepairCodeError}.
 * Callers that must route a finding use this rather than defaulting: an
 * unpublished code means the table and the applier have drifted, and
 * guessing a route is how a finding gets silently dropped.
 */
export function requireRepairCapability(code: string): RepairCapability {
  const entry = APPLIER_CAPABILITY.get(code);
  if (entry === undefined) throw new UnclassifiedRepairCodeError(code);
  return entry;
}

/**
 * The mechanical repair for `code`. Raises {@link RefusedRepairError}
 * (carrying the published reason) when the table refuses the code, and
 * {@link UnclassifiedRepairCodeError} when it does not know it.
 */
export function requireMechanicalRepair(code: string): MechanicalRepair {
  const entry = requireRepairCapability(code);
  if (entry.verdict === REPAIR_VERDICT.refused) throw new RefusedRepairError(entry);
  return entry;
}
