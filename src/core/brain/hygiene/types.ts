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

export const HYGIENE_DETECTOR_IDS = ["conflicts", "dedup", "freshness", "usefulness"] as const;

export type HygieneDetectorId = (typeof HYGIENE_DETECTOR_IDS)[number];

export type HygieneSeverity = "info" | "warning" | "action";

/**
 * Closed action vocabulary. `review` is the universal safe default -
 * anything an automated remediation should not touch lands there.
 */
export type HygieneProposedAction =
  | "merge"
  | "supersede"
  | "archive"
  | "recompile"
  | "forget"
  | "review";

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
