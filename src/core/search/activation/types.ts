/**
 * Activation store types (Time-Aware Recall & Activation Suite,
 * t_2bc79017 + t_c5ef25a3).
 */

/** One recorded retrieval: which documents one search surfaced. */
export interface ActivationAccessEvent {
  /** Unix-ms timestamp the access was recorded. */
  readonly ts: number;
  /** FNV-1a hash of the normalised query - never the raw query text. */
  readonly queryHash: string;
  /** Vault-relative paths of the surfaced documents (bounded). */
  readonly paths: ReadonlyArray<string>;
}

/** Folded per-document activation. */
export interface ActivationPathState {
  /** Accumulated strength in [0, 1] (step per access, capped). */
  readonly strength: number;
  /** Unix-ms timestamp of the most recent access. */
  readonly lastAccessAt: number;
  /** Total recorded accesses. */
  readonly accessCount: number;
}

/** One unordered co-access pair (a < b lexicographically). */
export interface CoAccessPair {
  readonly a: string;
  readonly b: string;
  /** Number of events that surfaced both paths together. */
  readonly count: number;
}

/**
 * Derived activation state - a pure fold over the retained access
 * events. The file is a cache: deleting it loses nothing.
 */
export interface ActivationState {
  readonly version: 1;
  /** Number of events the fold consumed. */
  readonly events: number;
  /** ISO timestamp of the most recent event, or null when empty. */
  readonly updatedAt: string | null;
  /** Per-path activation, keys sorted for determinism. */
  readonly paths: Readonly<Record<string, ActivationPathState>>;
  /** Bounded co-access pairs, sorted by count desc then keys asc. */
  readonly coAccess: ReadonlyArray<CoAccessPair>;
}

/** Outcome of an activation-event sweep. */
export interface ActivationSweepOutcome {
  readonly removed: number;
  readonly kept: number;
}
