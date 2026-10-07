/**
 * Brain Integrity Suite (v0.12.0) - `brain_review_candidates`.
 *
 * Read-only projection over what the next `dream` invocation would
 * do. Calls `dream(vault, { dryRun: true })` and reshapes the
 * summary into a focused agent-facing report. No persistent state
 * is mutated; the underlying dry-run dream pass also skips the
 * workrun emission.
 *
 * The shape is intentionally narrow - just the fields an operator or
 * agent needs to decide "should I do anything before the dream pass
 * runs?". Callers that want the full DreamRunSummary should call
 * `brain_dream` with `dry_run: true` directly.
 */

import { existsSync, readdirSync } from "node:fs";
import { posix } from "node:path";

import { resolveNearDuplicateRetireSiblingsEnabled } from "../config.ts";
import { vaultRelative } from "../path-safety.ts";
import { SearchError } from "../search/search-error.ts";
import type { ResolvedSearchConfig } from "../search/types.ts";
import { dream, shouldGateRetireFromConfirmed } from "./dream.ts";
import type { PreferenceRecord } from "./dream-plan.ts";
import type { DreamOptions, DreamRunSummary } from "./dream-types.ts";
import type { BrainIntentReviewEntry } from "./intent-review.ts";
import { NEAR_DUPLICATE_THRESHOLDS, READ_ALL_REFS, roundScore } from "./near-duplicate.ts";
import {
  storedVectorSimilarities,
  type StoredVectorSimilarity,
  type StoredVectorStatus,
} from "./near-duplicate-vectors.ts";
import { failureCode } from "./page-lint.ts";
import { brainDirs } from "./paths.ts";
import { loadBrainConfig } from "./policy.ts";
import {
  compareRetireSiblings,
  RETIRE_SIBLING_TRIGGER_REASONS,
  retireSiblingPool,
  type RetireSibling,
} from "./retire-siblings.ts";
import { scoreSignalNovelty, sortByNovelty, type SignalNoveltyEntry } from "./surprisal.ts";
import { BRAIN_RETIRED_REASON, type BrainRetiredReason } from "./types.ts";

/**
 * Outcome of the retire-sibling stored-vector tier: a probe status, or
 * `index_unavailable` when the store failed to open or read (busy,
 * locked, schema). The preview degrades to the lexical pairs then.
 */
export type RetireSiblingSemanticStatus = StoredVectorStatus | "index_unavailable";

export interface ReviewCandidatesReport {
  /** `pref-<slug>` ids that the dream pass would create new. */
  readonly would_create: ReadonlyArray<string>;
  /** `pref-<slug>` ids transitioning unconfirmed -> confirmed. */
  readonly would_promote: ReadonlyArray<string>;
  /** Retire entries (id + reason). */
  readonly would_retire: ReadonlyArray<{
    readonly id: string;
    readonly reason: BrainRetiredReason;
  }>;
  /** Subset of `would_retire` whose reason is `superseded-by-context`. */
  readonly would_supersede: ReadonlyArray<{
    readonly id: string;
    readonly reason: BrainRetiredReason;
  }>;
  /**
   * Signal clusters held back by the self-approval guardrail. Mirror
   * of `DreamRunSummary.quarantined` plus a one-shot
   * `failed_gates` list.
   */
  readonly clusters_below_threshold: ReadonlyArray<{
    readonly topic: string;
    readonly signal_count: number;
    readonly distinct_agents: number;
    readonly age_days: number;
    readonly failed_gates: ReadonlyArray<string>;
  }>;
  /**
   * Retires the destructive-from-confirmed gate would skip. Mirror
   * of `DreamRunSummary.gated_retires`.
   */
  readonly gated_retires: ReadonlyArray<{
    readonly pref_id: string;
    readonly topic: string;
    readonly applied_count: number;
    readonly violated_count: number;
    readonly threshold: number;
    readonly attempted_reason: BrainRetiredReason;
  }>;
  /** Intent-review decisions for active signal clusters before main dream planning. */
  readonly intent_reviews: ReadonlyArray<BrainIntentReviewEntry>;
  /**
   * Surprisal annotation (t_fddfe64a): inbox signals ranked by
   * embedding-space novelty, highest first. Present ONLY when a
   * search config was provided AND at least one signal actually
   * scored - vec-less vaults keep the report byte-identical.
   */
  readonly signal_novelty?: ReadonlyArray<SignalNoveltyEntry>;
  /**
   * Near-duplicate defense (t_acab97de): active preferences resembling a
   * context-driven retire this pass would make. Lexical pairs come from
   * the dream summary; with a search config, stored-vector pairs at or
   * above `retireSiblingEmbedding` merge in as `method: "embedding"`.
   * Present only when `near_duplicate_retire_siblings_enabled` is on and
   * the list is non-empty.
   */
  readonly retire_siblings?: ReadonlyArray<RetireSibling>;
  /**
   * Outcome of the stored-vector tier. Present only when retire siblings
   * are computed with a search config and a context-driven retire passes
   * `retiringVisible`.
   */
  readonly retire_siblings_semantic?: RetireSiblingSemanticStatus;
  /**
   * Why the tier reported `index_unavailable`: the search error code
   * ({@link failureCode}), never a message or a path. Present only with
   * that status.
   */
  readonly retire_siblings_semantic_detail?: string;
}

export interface BuildReviewCandidatesOptions {
  /** Wall clock for the underlying dream pass. */
  readonly now?: Date;
  /**
   * Vault-relative path test for a caller below local reach: the dry run
   * plans over the records it admits only (`DreamOptions.previewReadable`),
   * so the clusters, counts and intent reviews fold no withheld record.
   */
  readonly readable?: (rel: string) => boolean;
  /**
   * May the caller see this retiring `pref-*` id? A caller whose answer
   * drops a retire row passes the same test here, so the stored-vector
   * tier probes only the retires that answer keeps and
   * `retire_siblings_semantic` folds no hidden probe. Omitted, every
   * retire is probed.
   */
  readonly retiringVisible?: (prefId: string) => boolean;
  /**
   * Whether to project `retire_siblings`. Omitted, it resolves
   * `near_duplicate_retire_siblings_enabled` from the default config; a
   * caller with its own config path (the MCP server) resolves it there.
   */
  readonly retireSiblingsEnabled?: boolean;
  /**
   * When provided, annotate the report with surprisal novelty over
   * the existing vec index (t_fddfe64a). Read-only; absent or
   * unembedded indexes leave the report unchanged.
   */
  readonly searchConfig?: ResolvedSearchConfig;
  /**
   * Cooperative deadline for the dry-run pass below. The projection is
   * read-only, but the pass it projects walks the whole Brain tree
   * synchronously, so a caller that must not be held indefinitely - the
   * MCP server, whose event loop this blocks - passes the same budget it
   * would pass to `dream` directly.
   */
  readonly safeguard?: DreamOptions["safeguard"];
  /**
   * Emitted at the same boundaries `safeguard` is checked at. A run worth
   * bounding is a run worth reporting on, and the pass behind this
   * projection is the same five stages `dream` emits - a caller who asked
   * to watch the pass that decides these candidates watches that one.
   */
  readonly onProgress?: DreamOptions["onProgress"];
}

/**
 * Active inbox signal files as (id, relPath) refs. The relPath is the
 * forward-slash vault-relative form the search index keys documents by, on
 * every host: a Windows `relative`/`join` pair yields `Brain\inbox\...`,
 * which matches no indexed document and silently scores every signal null.
 */
function listInboxSignalRefs(vault: string): Array<{ id: string; relPath: string }> {
  const inbox = brainDirs(vault).inbox;
  if (!existsSync(inbox)) return [];
  const inboxRel = vaultRelative(inbox, vault);
  return readdirSync(inbox)
    .filter((n) => n.startsWith("sig-") && n.endsWith(".md"))
    .toSorted()
    .map((n) => ({ id: n.replace(/\.md$/, ""), relPath: posix.join(inboxRel, n) }));
}

export async function buildReviewCandidates(
  vault: string,
  opts: BuildReviewCandidatesOptions = {},
): Promise<ReviewCandidatesReport> {
  const siblingsEnabled = opts.retireSiblingsEnabled ?? resolveNearDuplicateRetireSiblingsEnabled();
  let scannedPreferences: ReadonlyArray<PreferenceRecord> = [];
  const summary = dream(vault, {
    dryRun: true,
    retireSiblingsEnabled: siblingsEnabled,
    onScanPreferences: (preferences) => {
      scannedPreferences = preferences;
    },
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.safeguard !== undefined ? { safeguard: opts.safeguard } : {}),
    ...(opts.onProgress !== undefined ? { onProgress: opts.onProgress } : {}),
    ...(opts.readable !== undefined ? { previewReadable: opts.readable } : {}),
  });

  let signalNovelty: ReadonlyArray<SignalNoveltyEntry> | undefined;
  if (opts.searchConfig !== undefined) {
    const refs = listInboxSignalRefs(vault);
    if (refs.length > 0) {
      const scored = await scoreSignalNovelty(opts.searchConfig, refs);
      if (scored.some((s) => s.novelty !== null)) {
        signalNovelty = sortByNovelty(scored);
      }
    }
  }

  const siblings = siblingsEnabled
    ? await projectRetireSiblings(vault, summary, scannedPreferences, opts)
    : { siblings: [] };

  return Object.freeze({
    ...(signalNovelty !== undefined ? { signal_novelty: signalNovelty } : {}),
    ...(siblings.siblings.length > 0
      ? { retire_siblings: Object.freeze(siblings.siblings.map((x) => Object.freeze({ ...x }))) }
      : {}),
    ...(siblings.semantic !== undefined ? { retire_siblings_semantic: siblings.semantic } : {}),
    ...(siblings.detail !== undefined ? { retire_siblings_semantic_detail: siblings.detail } : {}),
    would_create: Object.freeze([...summary.new_unconfirmed]),
    would_promote: Object.freeze([...summary.confirmed]),
    would_retire: Object.freeze(
      summary.retired.map((r) => Object.freeze({ id: r.id, reason: r.reason })),
    ),
    would_supersede: Object.freeze(
      summary.retired
        .filter((r) => r.reason === BRAIN_RETIRED_REASON.supersededByContext)
        .map((r) => Object.freeze({ id: r.id, reason: r.reason })),
    ),
    clusters_below_threshold: Object.freeze(
      summary.quarantined.map((q) =>
        Object.freeze({
          topic: q.topic,
          signal_count: q.signal_count,
          distinct_agents: q.distinct_agents,
          age_days: q.age_days,
          failed_gates: Object.freeze([...q.failed_gates]),
        }),
      ),
    ),
    gated_retires: Object.freeze(
      summary.gated_retires.map((g) =>
        Object.freeze({
          pref_id: g.pref_id,
          topic: g.topic,
          applied_count: g.applied_count,
          violated_count: g.violated_count,
          threshold: g.threshold,
          attempted_reason: g.attempted_reason,
        }),
      ),
    ),
    intent_reviews: Object.freeze(
      summary.intent_reviews.map((review) => Object.freeze({ ...review })),
    ),
  } satisfies ReviewCandidatesReport);
}

interface RetireSiblingProjection {
  readonly siblings: ReadonlyArray<RetireSibling>;
  readonly semantic?: RetireSiblingSemanticStatus;
  readonly detail?: string;
}

/**
 * The dream summary's lexical pairs, plus - when a search config is
 * present - the stored-vector tier over the same pool: every readable
 * active preference outside the retiring set that no merge resolved. A
 * pair the lexical tier already found keeps its lexical entry. The pool
 * comes from the dry run's own full scan (`preferences`), not a second walk.
 * A store that fails to open or read is an advisory tier failing, not the
 * preview: the lexical pairs stand and the status names the failure.
 */
async function projectRetireSiblings(
  vault: string,
  summary: DreamRunSummary,
  preferences: ReadonlyArray<PreferenceRecord>,
  opts: BuildReviewCandidatesOptions,
): Promise<RetireSiblingProjection> {
  const lexical = summary.retire_siblings ?? [];
  const triggered = summary.retired.filter((r) => RETIRE_SIBLING_TRIGGER_REASONS.has(r.reason));
  if (opts.searchConfig === undefined || triggered.length === 0) return { siblings: lexical };
  const readable = opts.readable ?? READ_ALL_REFS;
  const scanned = preferences
    .filter((p) => readable(vaultRelative(p.path, vault)))
    .map((p) => p.pref);
  // The dry run gates nothing, so the retires the confirmed-evidence gate
  // will hold back are dropped here, as the dream summary drops their
  // lexical siblings.
  const gateThreshold = loadBrainConfig(vault).retire.confirmed_evidence_min_threshold;
  const byId = new Map(scanned.map((p) => [p.id, p] as const));
  const retiringIds = triggered
    .map((r) => ({ id: `pref-${r.id.replace(/^ret-/, "")}`, reason: r.reason }))
    .filter(({ id, reason }) => {
      const existing = byId.get(id);
      return (
        existing === undefined || !shouldGateRetireFromConfirmed(existing, reason, gateThreshold)
      );
    })
    .map(({ id }) => id)
    .filter((id) => opts.retiringVisible?.(id) ?? true);
  if (retiringIds.length === 0) return { siblings: lexical };

  const prefsRel = vaultRelative(brainDirs(vault).preferences, vault);
  const pathOf = (id: string): string => posix.join(prefsRel, `${id}.md`);
  const allRetiring = new Set(summary.retired.map((r) => `pref-${r.id.replace(/^ret-/, "")}`));
  const pool = retireSiblingPool(scanned).filter((p) => !allRetiring.has(p.id));
  const idByPath = new Map(pool.map((p) => [pathOf(p.id), p.id] as const));
  const candidatePaths = [...idByPath.keys()].toSorted();

  const seen = new Set(lexical.map((x) => `${x.retiring_id}\u0000${x.sibling_id}`));
  const merged: RetireSibling[] = [...lexical];
  let results: ReadonlyArray<StoredVectorSimilarity>;
  try {
    results = await storedVectorSimilarities(
      opts.searchConfig,
      retiringIds.map(pathOf),
      candidatePaths,
    );
  } catch (e) {
    if (!(e instanceof SearchError)) throw e;
    return { siblings: lexical, semantic: "index_unavailable", detail: failureCode(e) };
  }
  results.forEach((result, i) => {
    const retiringId = retiringIds[i]!;
    for (const [path, score] of result.scores) {
      const siblingId = idByPath.get(path);
      if (siblingId === undefined) continue;
      if (score < NEAR_DUPLICATE_THRESHOLDS.retireSiblingEmbedding) continue;
      if (seen.has(`${retiringId}\u0000${siblingId}`)) continue;
      merged.push({
        retiring_id: retiringId,
        sibling_id: siblingId,
        score: roundScore(score),
        method: "embedding",
      });
    }
  });
  const statuses = results.map((r) => r.status);
  return { siblings: merged.toSorted(compareRetireSiblings), semantic: foldStatuses(statuses) };
}

/**
 * One status for the whole tier: `used` when any probe was compared, else
 * the first named reason it could not run (`not_embedded` when the probes
 * have no stored content vector yet).
 */
function foldStatuses(statuses: ReadonlyArray<StoredVectorStatus>): StoredVectorStatus {
  return statuses.includes("used") ? "used" : statuses[0]!;
}
