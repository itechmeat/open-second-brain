/**
 * The digest's public contract and its shared fold shape (task 3.19):
 * the format, options and result the entry point answers, the JSON
 * types every digest surface renders, and the `DigestData` fold the
 * collection, the analysis and the markdown renderer pass between
 * them. Split from `digest.ts`; that module re-exports the public
 * types so every import site keeps its specifier.
 */

import { type AgentSummaryEntry } from "./digest-agent-summary.ts";
import {
  type MaintenanceCollectError,
  type MaintenanceCollectSignal,
} from "./maintenance/collect.ts";
import type { ActionItem } from "./maintenance/action-scorer.ts";
import { type LinkOutputFormat } from "./wikilink.ts";
import type { BrainConfidence, TrustVerdict } from "./types.ts";

// ----- Public types ---------------------------------------------------------

export type DigestFormat = "markdown" | "json";

export interface RenderDigestOptions {
  /** Inclusive lower bound. Defaults to `until - 24h`. */
  readonly since?: Date;
  /** Exclusive upper bound. Defaults to `new Date()`. */
  readonly until?: Date;
  /** Output format. Defaults to `markdown`. */
  readonly format?: DigestFormat;
  /** Presentation link format for Markdown output. Defaults to Obsidian wikilinks. */
  readonly linkOutputFormat?: LinkOutputFormat;
  /**
   * Injection seam for deterministic tests: defaults the generated_at
   * timestamp. Production callers do not pass this — the renderer
   * picks `new Date()` itself.
   */
  readonly now?: Date;
  /**
   * Optional doctor result (v0.10.16). When supplied, `trust_verdict`
   * lands in the JSON payload and a `## Trust` section renders in
   * markdown.
   */
  readonly doctorResult?: import("./doctor.ts").RunDoctorResult;
  /**
   * Optional dream summary (v0.10.16). When supplied,
   * `uncertain_count` and `quarantined_count` reflect the
   * counterparts on the summary instead of defaulting to zero.
   */
  readonly dreamSummary?: import("./dream.ts").DreamRunSummary;
  /**
   * Owner scope for delivery isolation (context-integrity-gates, Unit
   * A). Enforced only when `integrity.owner_scope_delivery` is `fail`;
   * omitted, or under the default `off`, nothing is filtered and the
   * output is byte-identical to a vault without the gate.
   */
  readonly agentScope?: string;
  /**
   * May this reader see the record at a vault-relative path? A preference
   * or retired record it answers `false` for is treated as absent: its
   * rows, its counts, the log events naming it and the backlinks it is
   * the source of all go. Omitted, nothing is filtered and the output is
   * byte-identical to a digest without the option.
   */
  readonly readable?: (rel: string) => boolean;
  /**
   * The reader is below local reach: log events of the store's `private`
   * partition are withheld from every section, counts included.
   */
  readonly withholdsPrivate?: boolean;
}

export interface RenderDigestResult {
  /** Rendered Markdown (default) or JSON body. */
  readonly content: string;
  /** True when every section is empty (single-line output / `summary.empty`). */
  readonly empty: boolean;
}

// ----- JSON shape (mirrors §8.2) -------------------------------------------

export interface DigestJsonNewUnconfirmed {
  readonly id: string;
  readonly topic: string;
  readonly principle: string;
  readonly scope: string | null;
  readonly signal_count: number;
  readonly unconfirmed_until: string;
  readonly path: string;
}

export interface DigestJsonConfirmed {
  readonly id: string;
  readonly topic: string;
  readonly principle: string;
  readonly scope: string | null;
  readonly confirmed_at: string;
  readonly first_applied_artifact: string | null;
}

export interface DigestJsonRetired {
  readonly id: string;
  readonly topic: string;
  readonly principle: string;
  readonly scope: string | null;
  readonly retired_at: string;
  readonly reason: string;
  readonly days_stale: number | null;
}

export interface DigestJsonConfidenceShift {
  readonly id: string;
  /**
   * Human-readable title sourced from the referenced pref or retired's
   * `principle` field. Empty string when the id does not resolve to a
   * known artifact (the markdown renderer falls back to bare `[[id]]`).
   */
  readonly principle: string;
  readonly from: BrainConfidence | string;
  readonly to: BrainConfidence | string;
  readonly applied_count: number | null;
  readonly violated_count: number | null;
}

export interface DigestJsonContradiction {
  readonly id: string;
  /** See {@link DigestJsonConfidenceShift.principle}. */
  readonly principle: string;
  readonly topic: string | null;
  readonly description: string;
}

/**
 * "Hot" preference by lifetime evidence-application count. Reflects
 * the rules carrying real weight right now, regardless of whether
 * anything about them changed in the window. Source: current state
 * of `Brain/preferences/` (confirmed + quarantine).
 */
export interface DigestJsonTopApplied {
  readonly id: string;
  readonly topic: string;
  readonly principle: string;
  readonly scope: string | null;
  readonly applied_count: number;
  readonly violated_count: number;
  readonly confidence: BrainConfidence | string;
  readonly status: string;
}

/**
 * Preference with the most inbound wikilink references in the vault.
 * Source: the lifetime backlink index over preferences/retired/log.
 * Higher count → the rule is mentioned in more contexts.
 */
export interface DigestJsonTopReferenced {
  readonly id: string;
  readonly topic: string;
  readonly principle: string;
  readonly scope: string | null;
  readonly backlink_count: number;
}

/**
 * Most-applied entry: one preference + its applied-in-window count.
 * Drives the `Most-applied (Nd)` section in `brain_digest` Markdown
 * and the mirrored block in the JSON output. The window length and
 * limit come from `_brain.yaml:active.most_applied_*`.
 */
export interface DigestJsonMostAppliedEntry {
  readonly id: string;
  readonly principle: string;
  readonly scope: string | null;
  readonly applied_in_window: number;
}

export interface DigestJsonMostApplied {
  readonly window_days: number;
  readonly limit: number;
  readonly entries: ReadonlyArray<DigestJsonMostAppliedEntry>;
}

export interface DigestJsonAgentSummary {
  readonly agent: string;
  readonly total_events: number;
  readonly feedback_count: number;
  readonly apply_evidence_count: number;
  readonly note_count: number;
  readonly confirmed_attributed: number;
  readonly retired_attributed: number;
}

/**
 * Near-duplicate pair surfaced for operator review. Detected by
 * `findMergeCandidates`. Reflects current vault state, not windowed
 * change — does not gate the `isEmpty` predicate.
 */
export interface DigestJsonMergeSuggestion {
  readonly a: string;
  readonly b: string;
  readonly principle_a: string;
  readonly principle_b: string;
  readonly topic: string;
  readonly scope: string | null;
  readonly jaccard: number;
}

/**
 * Vault-level connection-density health metric (v0.10.14).
 * Surfaces the ratio of linked notes to total notes, orphan count,
 * and backlink distribution — answering whether the vault grows as a
 * network of ideas or as an "organized graveyard".
 */
export interface DigestJsonConnectionHealth {
  readonly total_nodes: number;
  readonly linked_nodes: number;
  readonly orphan_nodes: number;
  readonly mean_backlinks: number;
  readonly median_backlinks: number;
  readonly link_density: number;
}

export interface DigestJson {
  readonly schema_version: 1;
  readonly generated_at: string;
  readonly window: { readonly since: string; readonly until: string };
  readonly summary: {
    readonly new_unconfirmed_count: number;
    readonly confirmed_count: number;
    readonly retired_count: number;
    readonly confidence_shift_count: number;
    readonly contradiction_count: number;
    readonly empty: boolean;
  };
  readonly new_unconfirmed: ReadonlyArray<DigestJsonNewUnconfirmed>;
  readonly confirmed: ReadonlyArray<DigestJsonConfirmed>;
  readonly retired: ReadonlyArray<DigestJsonRetired>;
  readonly confidence_shifts: ReadonlyArray<DigestJsonConfidenceShift>;
  readonly contradictions: ReadonlyArray<DigestJsonContradiction>;
  readonly top_applied: ReadonlyArray<DigestJsonTopApplied>;
  readonly top_referenced: ReadonlyArray<DigestJsonTopReferenced>;
  readonly merge_suggestions: ReadonlyArray<DigestJsonMergeSuggestion>;
  readonly agent_summary: ReadonlyArray<DigestJsonAgentSummary>;
  /**
   * Window-scoped most-applied list (v0.10.11). Mirrors the
   * `Most-applied (Nd)` section of `Brain/active.md` and uses the
   * same `_brain.yaml:active.most_applied_*` settings.
   */
  readonly most_applied: DigestJsonMostApplied;
  /**
   * Vault-level connection-density health metric (v0.10.14).
   * Independent of the window — reflects current vault state.
   */
  readonly connection_health: DigestJsonConnectionHealth;
  /**
   * Ranked maintenance actions (v0.10.15). Aggregates page-dedup
   * candidates, lint demotions / merged-link rewrites, and token
   * footprint excess; deterministic ordering. Empty when nothing
   * needs doing. Independent of the window.
   */
  readonly actions: ReadonlyArray<ActionItem>;
  /**
   * The maintenance scans that refused while the digest was collected
   * (review M10), rendered as `{scan, message}` rows - the same shape the
   * operator-summary and doctor rows carry. A thin `actions` list must be
   * readable as healthy rather than indistinguishable from a scan that
   * failed. Present only when at least one scan refused, so a clean
   * payload stays byte-identical.
   */
  readonly collect_errors?: ReadonlyArray<{
    readonly scan: MaintenanceCollectSignal;
    readonly message: string;
  }>;
  /**
   * Aggregate vault trust verdict (v0.10.16). Absent when no
   * doctor input was threaded into the digest call; consumers that
   * only need the legacy preference-and-signal sections can ignore
   * the field.
   */
  readonly trust_verdict?: TrustVerdict;
  /**
   * Count of dream-pass uncertain entries in the most recent run
   * (v0.10.16). Zero when no dream input was provided.
   */
  readonly uncertain_count: number;
  /**
   * Count of dream-pass signal clusters held back by the
   * self-approval guardrail in the most recent run (v0.10.16).
   * Zero when no dream input was provided.
   */
  readonly quarantined_count: number;
}

export interface DigestData {
  readonly new_unconfirmed: ReadonlyArray<DigestJsonNewUnconfirmed>;
  readonly confirmed: ReadonlyArray<DigestJsonConfirmed>;
  readonly retired: ReadonlyArray<DigestJsonRetired>;
  readonly confidence_shifts: ReadonlyArray<DigestJsonConfidenceShift>;
  readonly contradictions: ReadonlyArray<DigestJsonContradiction>;
  readonly top_applied: ReadonlyArray<DigestJsonTopApplied>;
  readonly top_referenced: ReadonlyArray<DigestJsonTopReferenced>;
  readonly merge_suggestions: ReadonlyArray<DigestJsonMergeSuggestion>;
  readonly agent_summary: ReadonlyArray<AgentSummaryEntry>;
  readonly most_applied: DigestJsonMostApplied;
  readonly connection_health: DigestJsonConnectionHealth;
  readonly actions: ReadonlyArray<ActionItem>;
  /** Raw collected failures; rendered on the wire as `{scan, message}` rows. */
  readonly collect_errors: ReadonlyArray<MaintenanceCollectError>;
}
