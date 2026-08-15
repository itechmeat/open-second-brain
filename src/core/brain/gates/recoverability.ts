/**
 * Recoverability verdict for a destructive brain operation (R1a).
 *
 * `snapshot-gate.ts` promises that "no destructive brain mutation runs
 * without a recovery point on disk first", and until this module existed
 * it could express exactly two outcomes: a {@link DestructiveSnapshot},
 * or a throw. There was no way to say the third thing, which is the one
 * that was actually true at the largest call site: a recovery point
 * exists, and it does not cover all of what is being destroyed.
 *
 * The archive holds the top-level entries under `Brain/` minus
 * `.snapshots` and `.artifacts`, and - only when asked - the derived
 * SQLite store. That is the whole of it (`path-constants.ts:100-138`).
 * `deleteBySource --include-originals` removes the imported original,
 * which `source-cleanup.ts:449-464` returns ONLY when it lies outside
 * `Brain/`, so those bytes are outside every archive ever taken. The
 * result nevertheless carried a `snapshotRunId` and a `snapshotPath`,
 * which reads to any caller as "this is reversible". It is not.
 *
 * ## Three vocabularies, because these are three sets
 *
 * A state, a region an archive holds, and a reason a region cannot be
 * proved are disjoint. Following the rule the verdict census states at
 * its own `:228-232`, a union of disjoint sets is a namespace rather
 * than an abstraction, so each is registered on its own with its own
 * guard.
 *
 * ## What this module is not
 *
 * It is PURE: no filesystem, no clock, no config. It classifies a
 * declaration of what an operation is about to destroy against a
 * declaration of what was archived; discovering either is the caller's
 * job, and gating on the answer is `snapshot-gate.ts`'s.
 *
 * It is also not an error channel. A snapshot that could not be WRITTEN
 * is a failure and still throws - the caller's operation never runs.
 * Collapsing a failed snapshot into `unproven` would turn an abort into
 * a warning nobody reads, which is the exact shape of defect this gate
 * exists to remove.
 */

// ----- The state ------------------------------------------------------------

/**
 * What a recovery point is worth for one operation.
 *
 * `unproven` is the member the gate never had: it is what
 * `pruneSnapshots` must say (its blast radius is the archive directory,
 * which no archive contains, and gating it on taking a snapshot would be
 * circular) and what any ungated destructive site says.
 */
export const RECOVERABILITY_STATE = Object.freeze({
  /** Every region the operation destroys is inside the recovery point. */
  covered: "covered",
  /** Some regions are inside the recovery point and some are not. */
  partial: "partial",
  /** No region is inside a recovery point; recoverability is not proved. */
  unproven: "unproven",
  /** The operation destroys nothing, so there is nothing to recover. */
  nothingAtRisk: "nothing_at_risk",
} as const);

/** Closed union over {@link RECOVERABILITY_STATE}. */
export type RecoverabilityState = (typeof RECOVERABILITY_STATE)[keyof typeof RECOVERABILITY_STATE];

/** Membership list, most-covered first. */
export const RECOVERABILITY_STATES: ReadonlyArray<RecoverabilityState> = Object.freeze(
  Object.values(RECOVERABILITY_STATE),
);

/**
 * `unknown` rather than `string`: the value is read back out of a gate
 * result that has crossed a JSON boundary, and the vocabulary census
 * probes every guard with `null`, `42` and `{}`.
 */
export function isRecoverabilityState(value: unknown): value is RecoverabilityState {
  return (
    typeof value === "string" && (RECOVERABILITY_STATES as ReadonlyArray<string>).includes(value)
  );
}

// ----- What a recovery point covers -----------------------------------------

/**
 * The regions a snapshot archive actually holds. There are two, and the
 * second is opt-in: `snapshots.include_derived_store` defaults to
 * `not_requested`, so an operation whose blast radius reaches the SQLite
 * index is uncovered on a default install.
 */
export const RECOVERY_COVERAGE = Object.freeze({
  /** Top-level entries under `Brain/`, minus the never-archived ones. */
  brainTopLevel: "brain_top_level",
  /** The derived SQLite store, when the snapshot was asked to carry it. */
  derivedStore: "derived_store",
} as const);

/** Closed union over {@link RECOVERY_COVERAGE}. */
export type RecoveryCoverage = (typeof RECOVERY_COVERAGE)[keyof typeof RECOVERY_COVERAGE];

/** Membership list, in declaration order. */
export const RECOVERY_COVERAGES: ReadonlyArray<RecoveryCoverage> = Object.freeze(
  Object.values(RECOVERY_COVERAGE),
);

/** See {@link isRecoverabilityState} for why the parameter is `unknown`. */
export function isRecoveryCoverage(value: unknown): value is RecoveryCoverage {
  return typeof value === "string" && (RECOVERY_COVERAGES as ReadonlyArray<string>).includes(value);
}

// ----- What stops a region being covered ------------------------------------

/**
 * Why a region of the blast radius is not inside the recovery point.
 * Every member names a structural fact about the archive, never a
 * failure of the operation.
 */
export const RECOVERABILITY_BLOCKER = Object.freeze({
  /** Nothing was archived before the operation ran. */
  noRecoveryPoint: "no_recovery_point",
  /** Bytes outside `Brain/`, which no archive has ever contained. */
  outsideBrainRoot: "outside_brain_root",
  /** `Brain/.snapshots` or `Brain/.artifacts` - excluded from every archive. */
  snapshotExcludedEntry: "snapshot_excluded_entry",
  /** The derived store is at risk and the recovery point did not carry it. */
  derivedStoreNotArchived: "derived_store_not_archived",
} as const);

/** Closed union over {@link RECOVERABILITY_BLOCKER}. */
export type RecoverabilityBlocker =
  (typeof RECOVERABILITY_BLOCKER)[keyof typeof RECOVERABILITY_BLOCKER];

/** Membership list, in declaration order. */
export const RECOVERABILITY_BLOCKERS: ReadonlyArray<RecoverabilityBlocker> = Object.freeze(
  Object.values(RECOVERABILITY_BLOCKER),
);

/** See {@link isRecoverabilityState} for why the parameter is `unknown`. */
export function isRecoverabilityBlocker(value: unknown): value is RecoverabilityBlocker {
  return (
    typeof value === "string" && (RECOVERABILITY_BLOCKERS as ReadonlyArray<string>).includes(value)
  );
}

// ----- The classifier -------------------------------------------------------

/**
 * What an operation is about to destroy, stated in the regions the
 * archive is defined over rather than in paths. Four independent flags,
 * because an operation can reach several regions at once and each is
 * decided by a different fact about the operation.
 *
 * Every flag is optional and absent means "does not reach this region",
 * so a caller declares only what it touches. An entirely empty
 * declaration is an operation that destroys nothing.
 */
export interface DestructiveBlastRadius {
  /** Removes or replaces top-level entries under `Brain/`. */
  readonly brainTopLevel?: boolean;
  /** Removes entries under `Brain/.snapshots` or `Brain/.artifacts`. */
  readonly snapshotExcludedEntries?: boolean;
  /** Removes bytes outside the `Brain/` root. */
  readonly outsideBrainRoot?: boolean;
  /** Removes or replaces the derived SQLite store. */
  readonly derivedStore?: boolean;
}

/** The declaration {@link classifyRecoverability} reads. */
export interface RecoverabilityFacts {
  /** True when an archive was written BEFORE the operation ran. */
  readonly recoveryPoint: boolean;
  /** What the operation destroys. */
  readonly blastRadius: DestructiveBlastRadius;
  /** True when that archive carried the derived store. Defaults to false. */
  readonly derivedStoreArchived?: boolean;
}

/** The frozen verdict, carrying sorted token arrays and never prose. */
export interface RecoverabilityVerdict {
  readonly state: RecoverabilityState;
  /** Regions the recovery point holds, sorted. */
  readonly coverage: ReadonlyArray<RecoveryCoverage>;
  /** Regions it does not, and why, sorted. */
  readonly blockers: ReadonlyArray<RecoverabilityBlocker>;
}

/** The one verdict with no tokens on either side, shared and frozen. */
const NOTHING_AT_RISK: RecoverabilityVerdict = Object.freeze({
  state: RECOVERABILITY_STATE.nothingAtRisk,
  coverage: Object.freeze([]),
  blockers: Object.freeze([]),
});

/** True when the declaration reaches no region at all. */
function reachesNothing(radius: DestructiveBlastRadius): boolean {
  return (
    radius.brainTopLevel !== true &&
    radius.snapshotExcludedEntries !== true &&
    radius.outsideBrainRoot !== true &&
    radius.derivedStore !== true
  );
}

/**
 * Classify one operation's recoverability. Pure, and every gate is
 * evaluated independently so an operation that fails three of them
 * surfaces all three rather than the first: an operator who fixes the
 * only reason they were shown and re-runs is exactly the failure mode a
 * first-reason-wins verdict produces.
 */
export function classifyRecoverability(facts: RecoverabilityFacts): RecoverabilityVerdict {
  const radius = facts.blastRadius;
  if (reachesNothing(radius)) return NOTHING_AT_RISK;

  const archivedStore = facts.recoveryPoint && facts.derivedStoreArchived === true;

  const coverage: RecoveryCoverage[] = [];
  if (facts.recoveryPoint && radius.brainTopLevel === true) {
    coverage.push(RECOVERY_COVERAGE.brainTopLevel);
  }
  if (archivedStore && radius.derivedStore === true) {
    coverage.push(RECOVERY_COVERAGE.derivedStore);
  }

  const blockers: RecoverabilityBlocker[] = [];
  if (!facts.recoveryPoint) blockers.push(RECOVERABILITY_BLOCKER.noRecoveryPoint);
  if (radius.outsideBrainRoot === true) blockers.push(RECOVERABILITY_BLOCKER.outsideBrainRoot);
  if (radius.snapshotExcludedEntries === true) {
    blockers.push(RECOVERABILITY_BLOCKER.snapshotExcludedEntry);
  }
  if (radius.derivedStore === true && !archivedStore) {
    blockers.push(RECOVERABILITY_BLOCKER.derivedStoreNotArchived);
  }

  return Object.freeze({
    state: decideState(coverage.length, blockers.length),
    coverage: Object.freeze(coverage.toSorted()),
    blockers: Object.freeze(blockers.toSorted()),
  });
}

/**
 * The state follows from the two counts and nothing else, which is what
 * keeps "how many blockers" and "what the verdict says" from drifting
 * apart as members are added to either vocabulary.
 */
function decideState(covered: number, blocked: number): RecoverabilityState {
  if (blocked === 0) return RECOVERABILITY_STATE.covered;
  if (covered === 0) return RECOVERABILITY_STATE.unproven;
  return RECOVERABILITY_STATE.partial;
}

/**
 * The blast radius the destructive gate assumes when a caller declares
 * none. The wrapper's entire premise is that the operation behind it
 * removes Brain content, so silence means the Brain tree - never "no
 * blast radius", which would let an undeclared operation report
 * `nothing_at_risk` while it deleted the vault.
 */
export const DEFAULT_DESTRUCTIVE_BLAST_RADIUS: DestructiveBlastRadius = Object.freeze({
  brainTopLevel: true,
});
