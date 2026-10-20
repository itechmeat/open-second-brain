import type { OriginChannelStamp } from "../../origin-channel.ts";

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
 * Payload key carrying the transport a recall record arrived over (C1).
 *
 * Spelled here rather than in `recall-telemetry.ts` for the same reason
 * the two identity keys are: the clip list below has to name it, and a
 * protected key whose spelling lives in the module being protected is a
 * rename away from silently losing its protection.
 */
export const CONTINUITY_CHANNEL_KEY = "channel";

/**
 * Identity keys guaranteed to survive any output-budget clip of a
 * continuity payload (t_5be0654d). A clip may drop other keys to fit a
 * budget but MUST retain these, so a clipped record stays correlatable to
 * its session and its authoring agent. See {@link clipPayloadToBudget}.
 *
 * `channel` joins them (C1) on the same argument one step out: a clipped
 * recall record that lost its channel is attributed to nothing, and a
 * record attributed to nothing is exactly the silence the channel
 * dimension was added to break.
 */
export const CLIP_PROTECTED_PAYLOAD_KEYS: ReadonlyArray<string> = Object.freeze([
  CONTINUITY_SESSION_ID_KEY,
  CONTINUITY_AGENT_ID_KEY,
  CONTINUITY_CHANNEL_KEY,
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
  | "source_invalidation"
  /**
   * One typed negative-recall verdict and the coverage receipt behind it
   * (silence-is-not-an-answer, U2). Written by the recall gate under the
   * `recall_gate_telemetry` opt-in so the corpus statement a "no" rested
   * on stays auditable after the answer has been given.
   */
  | "negative_recall"
  /**
   * One optional decision-model request and how it ended (issue #213,
   * Part 1). Identifiers and numbers only - never the state, a passage, a
   * prompt or a question text. Written only while the feature is active.
   */
  | "decision_model_call"
  /**
   * Which committed extract-signals items cited a plan turn
   * (`source_turn`) while the decision-model turn pre-filter was on
   * (issue #213, Part 4). Session id and turn ids only; feeds the
   * pre-filter's regret metric.
   */
  | "decision_model_extract_commit"
  /**
   * One cached verdict set of the preregistered decision-model eval
   * (cycle 20261020, t_4e1681b3). Spec hash, fixture hash, profile, use,
   * take item ids, boolean verdicts and the counted metric -
   * identifiers, numbers and booleans, never item text. Review evidence
   * only: the machine-consumed tuning mark lives outside the vault, and
   * this kind is kept (never folded) so `o2b decision-model eval list`
   * can audit what any mark claimed.
   */
  | "decision_model_eval_grade"
  /**
   * One mined entity mention from a session turn (recall-quality wave,
   * Lane B): one record per (family, key, sessionRef), where family is a
   * precision detector family (`symbol` | `url` | `path` |
   * `qualified-ident`) and the key is family-scoped and case-preserving.
   * Provenance-grade ONLY - promotion into the entity registry is a
   * separate, explicit step, so this record never mints a page. Written
   * inside the import loop where the raw turn text predates payload
   * externalization; turns carrying a private region are withheld whole.
   * Additive kind, no schema bump.
   */
  | "session_entity_mention"
  /**
   * One operator-applied receipt compaction run (storage-lifecycle
   * wave): the per-run audit of a confirmed fold of the receipt ledgers,
   * carrying the folded and kept counts, the shard outcomes and the
   * recovery point that preceded the rewrite. Written once per confirmed
   * run by the fold engine, never on a dry run.
   *
   * NAMING HAZARD, decided here: this is the STORAGE compaction audit.
   * It is deliberately disjoint from the Hermes context-compaction kinds
   * above (`pre_compact_extract`, `post_compact_audit`), which audit
   * context-window compaction; the two vocabularies share no surface
   * name, and a receipt_compaction record never describes a context
   * operation.
   */
  | "receipt_compaction";

/**
 * Every {@link ContinuityRecordKind} member as a runtime list, in union
 * declaration order. The union is compile-time only, but a reader that
 * must distinguish "a kind this build knows" from "a kind a newer build
 * minted" needs the members as values - the receipts scan classifies an
 * unknown kind fail-closed as never-foldable, and a runtime guard is how
 * it asks. Add a new union member and this list in the same edit; the
 * membership guard below is derived from the list, so the two cannot
 * disagree.
 */
export const CONTINUITY_RECORD_KINDS: ReadonlyArray<ContinuityRecordKind> = Object.freeze([
  "context_receipt",
  "recall_telemetry",
  "gate_telemetry",
  "pre_compact_extract",
  "post_compact_audit",
  "session_turn",
  "recent_turn",
  "session_summary_node",
  "session_summary_digest",
  "generation_report",
  "ingest_dedup",
  "mcp_route_latency",
  "token_impact",
  "token_impact_outcome",
  "context_pack_outcome",
  "context_pack_evidence",
  "host_memory_write",
  "recall_observed_use",
  "skill_invoked",
  "source_invalidation",
  "negative_recall",
  "decision_model_call",
  "decision_model_extract_commit",
  "decision_model_eval_grade",
  "session_entity_mention",
  "receipt_compaction",
]);

/** Narrow an unvalidated record's `kind` to a {@link ContinuityRecordKind}. */
export function isContinuityRecordKind(value: unknown): value is ContinuityRecordKind {
  return (
    typeof value === "string" && (CONTINUITY_RECORD_KINDS as ReadonlyArray<string>).includes(value)
  );
}

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
  /**
   * Server-derived channel of the process that appended this record
   * (Unit C of the nothing-writes-silently wave): `mcp-tool`, `cli`,
   * `import`, or the explicit `unset` when no entry point claimed the
   * process. Never caller-supplied — {@link AppendContinuityRecordInput}
   * has no field for it and `src/core/origin-channel.ts` says why.
   *
   * `undefined` on records written before the stamp existed, which are
   * never rewritten to add one. Deliberately EXCLUDED from `recordId()`,
   * for the same reason `schema` is: adding provenance must not
   * re-identify a record, or the same append from two channels would
   * stop deduping against itself.
   */
  readonly originChannel?: OriginChannelStamp;
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
  /**
   * Mark the record private even though its payload no longer shows why.
   *
   * The store flags a record private when it strips a `<private>` region
   * from the payload. A caller that already stripped the region itself -
   * the payload registry sanitises a turn before externalizing it - hands
   * the store text with nothing left to detect, and says so here instead.
   * It can only turn the flag ON; absent keeps the store's own verdict.
   */
  readonly private?: boolean;
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
