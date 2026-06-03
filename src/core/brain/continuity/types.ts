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

export type ContinuityRecordKind =
  | "context_receipt"
  | "recall_telemetry"
  | "gate_telemetry"
  | "pre_compact_extract"
  | "session_turn"
  | "session_summary_node"
  | "source_invalidation";

export type ContinuityPayload = Readonly<Record<string, unknown>>;

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
}

export interface AppendContinuityRecordInput {
  readonly kind: Exclude<ContinuityRecordKind, "source_invalidation">;
  readonly createdAt: string;
  readonly sourceRefs?: ReadonlyArray<ContinuitySourceRef>;
  readonly payload?: ContinuityPayload;
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
