/**
 * Contract-wide continuity schema version (Memory Observability Suite,
 * t_26040ee8), stamped on every new record at `buildRecord()`.
 *
 * Evolution rule: additive optional fields do NOT bump the version;
 * renames, removals, or semantic changes bump to `o2b.continuity.v2`.
 * Records written before the stamp existed carry no `schema` field and
 * are read as v1. Existing JSONL files are never migrated.
 */
export const CONTINUITY_SCHEMA_VERSION = "o2b.continuity.v1";

/** Payload key carrying a record's session correlation id. */
export const CONTINUITY_SESSION_ID_KEY = "session_id";
/** Payload key carrying the authoring agent's id (t_5be0654d). */
export const CONTINUITY_AGENT_ID_KEY = "agent_id";
/** Payload key carrying a record's turn correlation id. */
export const CONTINUITY_TURN_ID_KEY = "turn_id";

/**
 * Identity keys guaranteed to survive any output-budget clip of a
 * continuity payload (t_5be0654d). A clip may drop other keys to fit a
 * budget but MUST retain these, so a clipped record stays correlatable to
 * its session and its authoring agent. See {@link clipPayloadToBudget}.
 */
export const CLIP_PROTECTED_PAYLOAD_KEYS: ReadonlyArray<string> = Object.freeze([
  CONTINUITY_SESSION_ID_KEY,
  CONTINUITY_AGENT_ID_KEY,
]);

export type ContinuityRecordKind =
  | "context_receipt"
  | "recall_telemetry"
  | "gate_telemetry"
  | "pre_compact_extract"
  | "post_compact_audit"
  | "session_turn"
  | "recent_turn"
  | "session_summary_node"
  | "session_summary_digest"
  | "generation_report"
  | "ingest_dedup"
  | "mcp_route_latency"
  | "token_impact"
  | "token_impact_outcome"
  | "context_pack_outcome"
  | "context_pack_evidence"
  | "host_memory_write"
  | "recall_observed_use"
  | "skill_invoked"
  | "source_invalidation";

export type ContinuityPayload = Readonly<Record<string, unknown>>;

/**
 * Visibility scopes a CALLER may declare on a continuity record
 * (provenance-at-the-boundary, unit G / t_77efc212).
 *
 * Distinct in kind from the record's `private` flag, which is INFERRED:
 * `safeContinuityPayload` sets it when it finds a `<private>` region in
 * the payload. A scope is never derived from content - there is no
 * `<shared>` marker and there must not be one, because a second inference
 * is the defect this field exists to avoid. A record either carries a
 * declaration its author made, or it carries none.
 *
 * Absent is the whole of today's behaviour: an append with no scope
 * produces the pre-existing record, field for field, and every filter
 * that does not ask for a scope keeps returning it.
 *
 * The vocabulary is CLOSED on the write side - `assertDeclaredScope`
 * refuses an unknown token at the store boundary - and deliberately OPEN
 * on the read side, where an unrecognised token stays readable and stays
 * excluded from any filter that did not request it. That asymmetry is the
 * read-model's additive-evolution rule: a scope written by a newer version
 * is neither leaked to an older reader nor discarded as malformed.
 */
export const CONTINUITY_RECORD_SCOPE = {
  /** Readable by any consumer that asks for shared records by name. */
  shared: "shared",
} as const;

export type ContinuityRecordScope =
  (typeof CONTINUITY_RECORD_SCOPE)[keyof typeof CONTINUITY_RECORD_SCOPE];

const CONTINUITY_RECORD_SCOPE_VALUES: ReadonlyArray<string> =
  Object.values(CONTINUITY_RECORD_SCOPE);

export function isContinuityRecordScope(value: unknown): value is ContinuityRecordScope {
  return typeof value === "string" && CONTINUITY_RECORD_SCOPE_VALUES.includes(value);
}

export interface ContinuitySourceRef {
  readonly id: string;
  readonly path?: string;
  readonly hash?: string;
  readonly kind?: string;
}

export interface ContinuityRecord {
  /**
   * Schema version of the record's on-disk shape. `undefined` on legacy
   * records written before the stamp existed - readers treat that as v1.
   * Deliberately EXCLUDED from `recordId()` so identical records dedupe
   * identically across the stamp transition.
   */
  readonly schema?: string;
  readonly id: string;
  readonly kind: ContinuityRecordKind;
  readonly createdAt: string;
  readonly sourceRefs: ReadonlyArray<ContinuitySourceRef>;
  readonly payload: ContinuityPayload;
  readonly private: boolean;
  readonly redacted: boolean;
  /**
   * Scope the record's author declared, absent when none was declared.
   * Written LAST in the envelope so the serialized prefix of an unscoped
   * record is unchanged from before the field existed.
   */
  readonly scope?: ContinuityRecordScope;
}

export interface AppendContinuityRecordInput {
  readonly kind: Exclude<ContinuityRecordKind, "source_invalidation">;
  readonly createdAt: string;
  readonly sourceRefs?: ReadonlyArray<ContinuitySourceRef>;
  readonly payload?: ContinuityPayload;
  /**
   * Optional caller declaration - see {@link CONTINUITY_RECORD_SCOPE}.
   * Omitted (or explicitly `undefined`) is byte-identical to today.
   */
  readonly scope?: ContinuityRecordScope;
}

export interface ContinuityRecordFilter {
  readonly kind?: ContinuityRecordKind;
  readonly sourceId?: string;
  readonly since?: string;
  readonly until?: string;
}

export interface ContinuityRecordPage {
  readonly records: ReadonlyArray<ContinuityRecord>;
  readonly nextCursor: string | null;
}
