/**
 * Hygiene findings pipeline - shared types
 * (continuity-hygiene-freshness suite; kanban t_698db8f7).
 *
 * One detector contract for every hygiene concern: a pure function
 * over the vault returning typed findings. `scan` composes detectors
 * into a read-only digest; `apply` executes an explicit remediation
 * plan built from finding ids. Detectors never mutate anything and
 * never throw past the scan boundary.
 */

export const HYGIENE_DETECTOR_IDS = [
  "conflicts",
  "dedup",
  "freshness",
  "usefulness",
  "slug-collisions",
  "tags",
] as const;

export type HygieneDetectorId = (typeof HYGIENE_DETECTOR_IDS)[number];

/**
 * Detectors included when a scan requests NO explicit subset - the
 * default sweep. Distinct from {@link HYGIENE_DETECTOR_IDS}: a detector
 * can be registered (valid subset member, wired into the scan) yet kept
 * OUT of the default sweep when it is too noisy to run uninvited. One
 * mechanism, two explicit policies: `slug-collisions` is default-on
 * (fires only on actual same-stem groups), `tags` is opt-in (noisy on
 * vaults that tag loosely), and further noisy detectors register as
 * opt-in by staying out of this list.
 *
 * Members are compile-checked against the registered tuple; a registered
 * id missing here is simply default-off, never an error.
 */
export const DEFAULT_SCAN_IDS: ReadonlyArray<HygieneDetectorId> = Object.freeze([
  "conflicts",
  "dedup",
  "freshness",
  "usefulness",
  "slug-collisions",
]);

export type HygieneSeverity = "info" | "warning" | "action";

/**
 * Closed action vocabulary. `review` is the universal safe default -
 * anything an automated remediation should not touch lands there.
 *
 * Declared as a runtime tuple, like {@link HYGIENE_DETECTOR_IDS} above,
 * so the applier capability table can be checked against the whole
 * vocabulary rather than against whichever members a test remembered.
 */
export const HYGIENE_PROPOSED_ACTIONS = [
  "merge",
  "supersede",
  "archive",
  "recompile",
  "forget",
  "review",
] as const;

export type HygieneProposedAction = (typeof HYGIENE_PROPOSED_ACTIONS)[number];

export interface HygieneFinding {
  /** Deterministic id: `<detector>:<sha256-prefix of targets>`. */
  readonly id: string;
  readonly detector: HygieneDetectorId;
  readonly severity: HygieneSeverity;
  /** One-line human-readable summary (English). */
  readonly title: string;
  /** What the finding is about: page paths, preference ids, `entity#aspect` slots. */
  readonly targets: ReadonlyArray<string>;
  readonly proposed_action: HygieneProposedAction;
  /** Detector-specific supporting data, JSON-serializable. */
  readonly evidence: Readonly<Record<string, unknown>>;
}

export interface HygieneDetectorContext {
  /** Injected clock - detectors never read the wall clock themselves. */
  readonly now: Date;
}

export type HygieneDetector = (
  vault: string,
  ctx: HygieneDetectorContext,
) => ReadonlyArray<HygieneFinding>;

export interface HygieneScanError {
  readonly detector: HygieneDetectorId;
  readonly message: string;
}

export interface HygieneScanReport {
  readonly generated_at: string;
  readonly detectors_run: ReadonlyArray<HygieneDetectorId>;
  readonly findings: ReadonlyArray<HygieneFinding>;
  readonly counts: Readonly<Partial<Record<HygieneDetectorId, number>>>;
  readonly errors: ReadonlyArray<HygieneScanError>;
}

export function isHygieneDetectorId(value: unknown): value is HygieneDetectorId {
  return (
    typeof value === "string" && (HYGIENE_DETECTOR_IDS as ReadonlyArray<string>).includes(value)
  );
}
