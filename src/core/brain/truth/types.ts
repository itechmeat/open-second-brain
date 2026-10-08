/**
 * Entity-Truth Ledger types (Entity Truth & Self-Improving Dream
 * Suite, t_e9692750 + t_d6849b56).
 *
 * The ledger answers "what is true about this entity right now"
 * without ever mutating history: claims are append-only events,
 * slots and conflicts are derived projections (see `fold.ts`).
 */

/** Schema version stamped on every persisted claim line and state file. */
export const TRUTH_SCHEMA_VERSION = 1;

export type ClaimValueKind = "text" | "quantity";

/**
 * How a claim entered the ledger. The only writer-side value this
 * release emits is `agent_stated` (a grounded agent-stated claim,
 * truth-correctable-time-aware task 4); reads tolerate any non-empty
 * string under schema v1 so a future extractor survives an upgrade
 * cycle untouched.
 */
export type ClaimExtractor = "agent_stated";

/** Structured payload for the quantitative fact family (t_220c313e). */
export interface ClaimQuantity {
  readonly value: number;
  /** Canonical unit token (`usd`, `hours`, ...) or null when unitless. */
  readonly unit: string | null;
  /** Measured action (`spent`, `ran`, ...) or null when unstated. */
  readonly action: string | null;
}

/**
 * One appended claim line: agent X asserted that `entity`'s `aspect`
 * is `value`, citing `source`. Entity and aspect are stored canonical
 * (NFC, lowercase, collapsed whitespace) so slot addressing compares
 * like with like; `value` keeps its display casing and is normalized
 * only for identity comparison inside the fold.
 *
 * The optional validity fields carry the claim's real-world validity
 * window, half-open `[validFrom, validUntil)` (see `validity.ts`).
 * They are presence-gated under `TRUTH_SCHEMA_VERSION = 1`: absent
 * keys mean windowless, and every windowless line serializes
 * byte-identically to the pre-window ledger. Stored values are bare
 * ISO dates or canonical UTC timestamps; comparisons run on the
 * validity axis only when BOTH claims of a pair carry present windows
 * (contract item 1) - a windowless or expired claim never suppresses
 * assertion-time contestation on its own.
 */
export interface ClaimEvent {
  readonly v: typeof TRUTH_SCHEMA_VERSION;
  /** Canonical ISO-8601 UTC timestamp. */
  readonly ts: string;
  readonly agent: string;
  readonly entity: string;
  readonly aspect: string;
  readonly value: string;
  readonly valueKind: ClaimValueKind;
  readonly quantity?: ClaimQuantity;
  /** Validity window start (bare ISO date or canonical UTC timestamp). */
  readonly validFrom?: string;
  /** Validity window end, exclusive (bare ISO date or canonical UTC timestamp). */
  readonly validUntil?: string;
  /**
   * Presence-gated provenance tag (schema v1): how this claim entered
   * the ledger. Annotation only - the tag never changes which pairs
   * contest, never re-ranks conflict priority, and never resolves one.
   */
  readonly extractor?: ClaimExtractor;
  /** Provenance wikilink or vault-relative path. */
  readonly source: string;
}

/** One value a slot held, with full provenance lineage. */
export interface ClaimVersion {
  readonly value: string;
  readonly valueKind: ClaimValueKind;
  readonly quantity?: ClaimQuantity;
  /** Latest assertion timestamp for this value. */
  readonly ts: string;
  readonly agent: string;
  readonly source: string;
  /** How many events asserted this value. */
  readonly assertCount: number;
  /**
   * Validity fields tolerated on state-file versions for schema
   * forward-compatibility. The fold does not populate them (succession
   * reads windows from the events themselves), so they stay absent in
   * every state this binary writes.
   */
  readonly validFrom?: string;
  readonly validUntil?: string;
}

/**
 * The addressable per-(entity, aspect) projection: current value plus
 * superseded prior values, newest first.
 */
export interface ClaimSlot {
  readonly entity: string;
  readonly aspect: string;
  readonly current: ClaimVersion;
  readonly history: ReadonlyArray<ClaimVersion>;
  /** True when an unresolved conflict involves this slot (t_e9692750). */
  readonly contested: boolean;
}

export type TruthConflictKind = "value_conflict";

/**
 * A materialized contradiction: two distinct values for one slot
 * within the conflict window from independent sources. Never
 * auto-resolved - the strategy is always `ask_user` in this release.
 */
export interface TruthConflict {
  readonly entity: string;
  readonly aspect: string;
  readonly kind: TruthConflictKind;
  readonly values: ReadonlyArray<ClaimVersion>;
  /** Higher = more urgent (more recent, more independent sources). */
  readonly priority: number;
  readonly resolution: "ask_user";
  /** Timestamp of the claim that surfaced the conflict. */
  readonly detectedAt: string;
}

/**
 * A superseded-by-windows transition (contract item 1): two distinct
 * values for one slot whose claims all carry present, non-intersecting
 * validity windows. Succession lives OUTSIDE the conflict vocabulary -
 * it is never a {@link TruthConflict}, never `ask_user`, and never
 * reaches hygiene findings or conflict priority. The predecessor is
 * the claim whose window closes first; `detectedAt` is the successor's
 * assertion timestamp.
 */
export interface ClaimSuccession {
  readonly entity: string;
  readonly aspect: string;
  readonly predecessor: ClaimEvent;
  readonly successor: ClaimEvent;
  readonly detectedAt: string;
}

/**
 * The derived fold over all retained claim events.
 *
 * `successions` is presence-gated: undefined (never an empty array)
 * whenever no succession classifies, and serialized by conditional
 * spread so windowless states stay byte-identical to the pre-window
 * ledger.
 */
export interface TruthState {
  readonly version: typeof TRUTH_SCHEMA_VERSION;
  readonly events: number;
  readonly updatedAt: string | null;
  readonly slots: ReadonlyArray<ClaimSlot>;
  readonly conflicts: ReadonlyArray<TruthConflict>;
  readonly successions?: ReadonlyArray<ClaimSuccession>;
}

export interface ClaimParseWarning {
  readonly path: string;
  readonly lineNumber: number;
  readonly message: string;
}

export interface ReadClaimEventsResult {
  readonly events: ReadonlyArray<ClaimEvent>;
  readonly warnings: ReadonlyArray<ClaimParseWarning>;
}

export interface ClaimSweepOutcome {
  readonly removed: number;
  readonly kept: number;
}
