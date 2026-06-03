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
