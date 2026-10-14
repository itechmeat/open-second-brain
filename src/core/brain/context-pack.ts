/**
 * Bounded-token vault slice. Returns the highest-tier, most recent
 * pages that fit inside a caller-specified token budget so an agent
 * can prime its context window without overflowing it.
 *
 * Ordering:
 *   1. tier ascending importance: core → supporting → peripheral.
 *   2. created_at descending (newest first).
 *   3. id ascending (stable tie-break).
 *
 * The walker stops adding pages the moment the next candidate would
 * push tokensUsed over `maxTokens`. Pages that would never fit alone
 * are reported in `pagesSkipped` with their estimated cost.
 */

import { statSync } from "node:fs";
import { join, relative } from "node:path";

import { canonicalNotePath } from "../path-safety.ts";
import { loadGuardrailsConfigSafe } from "./policy.ts";
import {
  contextSafetyReport,
  guardBrainContextSnippet,
  type ContextSafetyReport,
} from "./safety/context-guard.ts";
import { brainDirs } from "./paths.ts";
import { BELIEF_VECTORS_BACKFILL_COMMAND } from "./belief-semantic.ts";
import { SearchError } from "../search/search-error.ts";
import {
  collectPreferencePages,
  formatOwnerScopeWarning,
  resolveOwnerScopeDelivery,
  type OwnerScopeDelivery,
} from "./preferences-collect.ts";
import { buildChainLookup, isTombstoned, resolveChainTip } from "./lifecycle/tombstone.ts";
import { chainVerdict } from "../search/correction-coupling.ts";
import { preferChainTips } from "./inject-governor.ts";
import { tensionWarningsForContextItems } from "./tensions.ts";
import { PAGE_TIER, readTier, type PageTier } from "./page-meta/tier.ts";
import { readCommitmentTier } from "./commitment.ts";
import type { BrainCommitmentTier } from "./types.ts";
import {
  deriveEpistemicStatus,
  EPISTEMIC_STATUS,
  type EpistemicStatus,
} from "./provenance/epistemic.ts";
import { estimateTokens } from "./text/tokenizer.ts";
import { densityScore } from "./context-density.ts";
import { normalizeForDedup } from "./text/normalize.ts";
import { jaccard, tokenise } from "./similarity.ts";
import {
  allocateRecallBudget,
  applyCharBudget,
  type CharBudgetDegradationMode,
  type PackingPolicy,
  type RecallBudgetAllocation,
  type RecallBudgetLaneName,
} from "./recall-budget.ts";
import { emitContextReceipt, type ContextReceiptOptions } from "./context-receipts.ts";
import type { RecallAdequacyVerdict } from "./recall-adequacy.ts";
import { emitGatedTelemetry } from "./continuity/emit.ts";
import {
  canonicalSegment,
  deterministicPrefix,
  emitPromptPrefixMetric,
  summarizePrefixPass,
} from "./prompt-prefix.ts";
import { isoSecond } from "./time.ts";
import {
  emitRecallTelemetry,
  recallTelemetryEnvelope,
  type RecallTelemetryOptions,
} from "./recall-telemetry.ts";
import {
  applyContextTransforms,
  type ContextTransformOptions,
  type ContextTransformAnnotations,
} from "./context-transforms.ts";
import {
  buildContextLanes,
  normalizeContextLane,
  type ContextLaneName,
  type ContextLanesReport,
} from "./context-lanes.ts";
import { buildAttentionContextBlock } from "./attention-flows.ts";
import { buildPackStamp, type ContextPackStamp } from "./pack-stamp.ts";
import { scoreSessionFocusTarget, sessionFocusIsActive } from "../search/session-focus.ts";
import type { SearchSessionFocus } from "../search/types.ts";

const TIER_ORDER: ReadonlyArray<PageTier> = [
  PAGE_TIER.core,
  PAGE_TIER.supporting,
  PAGE_TIER.peripheral,
];

/**
 * How {@link ContextPackOptions.query} is applied (v1.53.0).
 *
 * `substring` is the original meaning and the default: a
 * case/Unicode-insensitive substring match of the whole query against
 * `topic + principle`, and anything that misses is dropped with a
 * `filter-miss` skip. That answers "give me the pages about X" and
 * nothing else - a natural-language turn matches no page at all, so a
 * caller that hands this argument a user prompt gets an empty pack.
 *
 * `ranked` answers the other question: "of the pages this lane would
 * inject anyway, which ones does this turn make relevant?" It ORDERS the
 * collected candidates by structural token overlap and excludes none, so
 * the budget - not a lexical accident - decides what is dropped, and the
 * curated pool, guard, tip preference, owner scope, and receipt the lane
 * exists for all still apply.
 *
 * `semantic` (Honest Embedding Spend) orders the same way, by meaning
 * instead of token overlap: the caller passes
 * {@link ContextPackOptions.semanticRelevance}, computed at the async
 * boundary from the stored vectors of the belief notes, and the pack reads
 * it in the slot `ranked` uses. The pack itself never embeds, so it stays
 * synchronous for every other caller.
 */
export const CONTEXT_PACK_QUERY_MODES = ["substring", "ranked", "semantic"] as const;

export type ContextPackQueryMode = (typeof CONTEXT_PACK_QUERY_MODES)[number];

export function isContextPackQueryMode(value: unknown): value is ContextPackQueryMode {
  return (
    typeof value === "string" && (CONTEXT_PACK_QUERY_MODES as ReadonlyArray<string>).includes(value)
  );
}

export { BELIEF_VECTORS_BACKFILL_COMMAND };

/**
 * The relevance an unembedded candidate reads in `semantic` mode: below
 * any cosine, so it sorts after every scored candidate of its tier,
 * negative cosines included.
 */
const UNEMBEDDED_RELEVANCE = -2;

/**
 * A `semantic` pack was asked for without the relevance map that mode
 * reads. Packing by recency instead would answer a meaning query with an
 * order that ignores the query, so the call fails by name.
 */
export class ContextPackSemanticRelevanceMissingError extends Error {
  constructor() {
    super("context pack: query_mode semantic requires a semanticRelevance map");
    this.name = "ContextPackSemanticRelevanceMissingError";
  }
}

/**
 * A named packing policy was asked for against a pack where it cannot
 * run: one of its two lanes has no candidate in reach, the budget is
 * zero and neither lane can ever draw, or the reserved attention charge
 * consumes the whole budget and neither lane can draw. Packing by the
 * named order would silently do nothing, so the call fails by name - the
 * policy member and every empty lane are in the message - and fails
 * before the receipt and telemetry are written, so a refused pack leaves
 * no record of a delivery.
 */
export class ContextPackPackingLaneEmptyError extends Error {
  private constructor(message: string) {
    super(message);
    this.name = "ContextPackPackingLaneEmptyError";
  }

  /** The partition's refusal: the named policy cannot see both lanes. */
  static emptyLanes(policy: PackingPolicy, emptyLanes: ReadonlyArray<RecallBudgetLaneName>) {
    const named =
      emptyLanes.length === 1
        ? `the ${emptyLanes[0]} lane is empty`
        : `the ${emptyLanes[0]} and ${emptyLanes[1]} lanes are empty`;
    return new ContextPackPackingLaneEmptyError(
      `context pack: packing_policy ${policy} needs both lanes; ${named}`,
    );
  }

  /** The short-circuit's refusal: a zero budget offers neither lane anything. */
  static zeroBudget(policy: PackingPolicy) {
    return new ContextPackPackingLaneEmptyError(
      `context pack: packing_policy ${policy} needs a positive token budget; ` +
        `neither lane can draw on zero tokens`,
    );
  }

  /**
   * The allocation's refusal: the reserved attention charge consumes the
   * whole budget, so both populated lanes draw on nothing.
   */
  static reservedCharge(policy: PackingPolicy, reservedTokens: number, maxTokens: number) {
    return new ContextPackPackingLaneEmptyError(
      `context pack: packing_policy ${policy} needs a lane budget beyond the reserved ` +
        `attention charge; the reserved charge of ${reservedTokens} tokens consumes the ` +
        `whole ${maxTokens}-token budget and neither lane can draw`,
    );
  }
}

export interface ContextPackItem extends ContextTransformAnnotations {
  readonly id: string;
  readonly path: string;
  readonly tier: PageTier;
  readonly tokens: number;
  readonly body: string;
  readonly principle: string;
  readonly contextLane: ContextLaneName | null;
  /** True when `body` was truncated by `maxCharsPerMemory` (v0.20.0). */
  readonly trimmed: boolean;
  /**
   * Epistemic grounding of this item (ACM), derived from the page's
   * provenance / status / lifecycle metadata: `observed | derived |
   * hypothesis | plan | unknown`. Lets downstream reasoning distinguish a
   * grounded fact from a conjecture.
   */
  readonly epistemic: EpistemicStatus;
  /** `evidenced_by` wikilinks grounding this item; empty when it cites none. */
  readonly evidenceRefs: ReadonlyArray<string>;
  /**
   * Commitment tier (Belief lifecycle suite, B3) when the source note
   * declares one: `exploring | leaning | decided | locked`. Additive and
   * present only when set, so a pack over commitment-free notes stays
   * byte-identical.
   */
  readonly commitment?: BrainCommitmentTier;
  /**
   * Value-per-token density score (impact-per-token allocation,
   * t_affa3bd9): structural signal per estimated token that broke this
   * item's within-tier tie. Present only when `densityRanking` is on;
   * absent otherwise so the default report stays byte-identical.
   */
  readonly density?: number;
  /** Present when the surfaced body was filtered or explicitly trusted. */
  readonly safety?: ContextSafetyReport;
}

/**
 * What the `semantic` mode could score, counted over the candidates that
 * survived the reach filter, so a withheld page is in neither member.
 */
export interface ContextPackSemanticReport {
  /** Kept candidates that had a relevance score. */
  readonly scored: number;
  /** Ids of kept candidates without one, sorted; they sort after the scored ones of their tier. */
  readonly unembedded: ReadonlyArray<string>;
}

export interface ContextPackSkipped {
  readonly id: string;
  readonly tokens: number;
  readonly reason: "over-budget" | "filter-miss" | "guard-blocked" | "over-char-budget";
}

/**
 * What one packing lane held under the correlated budget. `spent` sums
 * the tokens of the items DELIVERED from the lane, so the two spends
 * and the reserved charge always add up to `tokensUsed` plus what the
 * char budget dropped.
 */
export interface ContextPackPackingLaneReport {
  /** The share of the shared total the lane held (first claim or remainder). */
  readonly allocation: number;
  /** Tokens actually delivered from this lane. */
  readonly spent: number;
  /** Candidates the lane brought into the budget, after the query filter. */
  readonly candidates: number;
  /** Items delivered from this lane. */
  readonly items: number;
}

/**
 * Accounting for the opt-in packing policy: which member was named, the
 * reserved charge the lane allocations were reduced by, and what each lane
 * held under the one shared budget. Present ONLY when the caller named
 * {@link ContextPackOptions.packingPolicy} - the same conditional shape as
 * `stamp`, `lanes` and `semantic`.
 */
export interface ContextPackPackingReport {
  readonly policy: PackingPolicy;
  /**
   * The reserved attention charge (the synthesized attention block) that
   * was paid before either lane claimed, so both lane allocations were
   * reduced by it. Present even when zero, so the accounting the caller
   * reads is whole: the two allocations plus this charge always sum to
   * the pack's `maxTokens`. A refused pack has no report at all - the
   * reserved-charge refusal throws before anything is returned.
   */
  readonly reservedTokens: number;
  readonly pages: ContextPackPackingLaneReport;
  readonly facts: ContextPackPackingLaneReport;
}

export interface ContextPackReport {
  readonly maxTokens: number;
  readonly tokensUsed: number;
  readonly items: ReadonlyArray<ContextPackItem>;
  readonly skipped: ReadonlyArray<ContextPackSkipped>;
  readonly receiptId?: string;
  readonly telemetryId?: string;
  readonly lanes?: ContextLanesReport;
  /**
   * Injection-time tension warnings (Belief lifecycle suite, S2,
   * t_0e3f2bee): one line per UNRESOLVED (open or confirmed) tension whose
   * subject note is present in `items`. Present only when at least one such
   * warning fires, so a vault with no unresolved tensions touching the pack
   * keeps the report byte-identical.
   */
  readonly warnings?: ReadonlyArray<string>;
  /**
   * Provenance stamp and validity window (context-integrity-gates, Unit
   * B). Present ONLY when the caller passed
   * {@link ContextPackOptions.stamp}, so a pack that never asked to be
   * persisted stays byte-identical - the same conditional shape `lanes`
   * and `density` use.
   */
  readonly stamp?: ContextPackStamp;
  /** Present only in `semantic` mode; see {@link ContextPackSemanticReport}. */
  readonly semantic?: ContextPackSemanticReport;
  /**
   * Present only when the caller named a packing policy; see
   * {@link ContextPackPackingReport}.
   */
  readonly packing?: ContextPackPackingReport;
}

/**
 * Opt into a provenance stamp on the report. The clock is INJECTED
 * rather than read here: the persisting caller (the anticipatory cache)
 * already owns an event time, and the stamp's window must agree with the
 * timestamps that caller records rather than with a second wall-clock
 * reading taken microseconds later.
 */
export interface PackStampOptions {
  readonly now: Date;
  /**
   * Config file the stamp resolves the search-index location through.
   * Threaded rather than defaulted at the leaf so a caller that already
   * knows its config path stamps against the database `search()` would
   * actually read for it, not the one the process default names.
   */
  readonly configPath?: string;
}

export interface ContextPackOptions {
  readonly maxTokens: number;
  /**
   * Optional query. Read as a case-insensitive substring filter on topic +
   * principle by default; see {@link ContextPackOptions.queryMode} for the
   * ranking reading.
   */
  readonly query?: string;
  /**
   * How {@link ContextPackOptions.query} is applied (v1.53.0). Omitted is
   * `substring`, byte-identical to every release before this one. `ranked`
   * orders instead of filtering - see {@link CONTEXT_PACK_QUERY_MODES}.
   * Without a `query` the mode has nothing to act on and is inert.
   */
  readonly queryMode?: ContextPackQueryMode;
  /**
   * Relevance per belief note for the `semantic` mode, keyed by the
   * note's vault-relative POSIX path. A candidate absent from the map has
   * no usable vector: it sorts after every scored candidate of its tier and is named in
   * {@link ContextPackReport.semantic}. Required in `semantic` mode and
   * read in no other.
   */
  readonly semanticRelevance?: ReadonlyMap<string, number>;
  /**
   * Opt-in packing policy (recall-lane-latency wave): which lane claims
   * the pack's one existing token budget first when both candidate
   * populations are in reach - the preference-derived candidates (the
   * facts lane, the distilled layer) and the page candidates from the
   * retired directory (the pages lane). `facts_first` claims facts-side
   * first, `retired_first` hands the first claim to the retired pages
   * lane; the losing lane fills the exact remainder and the total never
   * grows. Omitted runs the unified comparator pack byte-identical to every
   * release before this one - no partition, no `packing` accounting.
   * With the option set, a lane with no candidate in reach, a zero
   * budget, or a reserved attention charge that consumes the whole
   * total - each of which offers neither lane anything to draw - is
   * refused by name ({@link ContextPackPackingLaneEmptyError}), never a
   * silent no-op, and the synthesized attention block stays a reserved
   * charge neither lane draws. See {@link PACKING_POLICIES}.
   */
  readonly packingPolicy?: PackingPolicy;
  /**
   * Per-memory character cap (v0.20.0): trim any single page's body to
   * this many code points before it consumes the token budget, so one
   * oversized page cannot crowd out the rest. <= 0 / undefined disables.
   */
  readonly maxCharsPerMemory?: number;
  /**
   * Total recall character cap (v0.20.0): a second ceiling alongside
   * `maxTokens`, bounding the cumulative code points across the emitted
   * pages. Lowest-priority overflow is dropped with an
   * `over-char-budget` skip reason. <= 0 / undefined disables.
   */
  readonly maxTotalChars?: number;
  /**
   * Per-memory trim strategy (continuity-hygiene-freshness suite):
   * `staged` degrades an over-budget body at structural boundaries
   * instead of cutting mid-sentence. Default keeps the hard cut.
   */
  readonly degradation?: CharBudgetDegradationMode;
  /** Opt-in polarity-aware lanes. Omitted preserves the legacy flat output shape. */
  readonly includeLanes?: boolean;
  /** Opt-in audit receipt for the final emitted context. */
  readonly receipt?: ContextReceiptOptions;
  /**
   * Recall adequacy verdict (t_b8f66fec) for the recall that produced
   * this pack. When present alongside `receipt`, it is persisted in the
   * receipt so the audit trail records the sufficient/weak/insufficient
   * verdict and the action the caller was told to take.
   */
  readonly recallAdequacy?: RecallAdequacyVerdict;
  /**
   * Advisory decision-model annotation of `recallAdequacy` (issue #213,
   * Part 8), persisted in the receipt next to the verdict. It never
   * changes the verdict or the pack.
   */
  readonly decisionAnswerable?: { readonly probability: number; readonly disagrees: boolean };
  /** Opt-in telemetry for recall coverage and gap diagnostics. */
  readonly telemetry?: RecallTelemetryOptions;
  /**
   * Opt-in: emit one run-level `prompt_prefix` metric for this pack's
   * stable request preamble (Hindsight brain-loop ops, t_d8c1f7d9).
   * Omitted/false keeps the report and any receipt byte-identical and
   * writes no metric.
   */
  readonly promptPrefix?: boolean;
  /** Opt-in post-selection context transforms. Defaults preserve legacy order and bodies. */
  readonly transforms?: ContextTransformOptions;
  /** Optional declarative attention-flow ids to include as a synthetic context item. */
  readonly attentionFlowIds?: ReadonlyArray<string>;
  /**
   * Active search focus (Agent Surface Suite, t_5b478e47). When set
   * and unexpired, focus-matching memories are promoted WITHIN their
   * tier; a peripheral page can never outrank a core one. Omitted or
   * null keeps the legacy ordering byte-identical. Callers gate this
   * on the `search_focus_context_pack` config key.
   */
  readonly sessionFocus?: SearchSessionFocus | null;
  /**
   * Value-per-token density ranking (impact-per-token allocation,
   * t_affa3bd9). When true, a deterministic density score (structural
   * signal per estimated token) breaks ties WITHIN a tier - inserted
   * into the sort AFTER `sessionFocus` and BEFORE recency, so the full
   * chain is tier → focus → density → recency → id. Tier stays the
   * coarse gate: a peripheral page can never outrank a core one, and an
   * active session focus always dominates a static content heuristic.
   * Omitted/false keeps the density map empty and the ordering
   * byte-identical to the legacy tier → recency pack. Callers gate this
   * on the `density_ranking_context_pack` config key.
   */
  readonly densityRanking?: boolean;
  /**
   * Owner scope for delivery isolation (context-integrity-gates, Unit
   * A). Enforced only when `integrity.owner_scope_delivery` is `fail`;
   * omitted, or under the default `off`, no candidate is filtered and
   * the pack is byte-identical to a vault without the gate.
   */
  readonly agentScope?: string;
  /**
   * Belief lifecycle suite (A4, t_d9365884): keep superseded ancestors in
   * the pack instead of collapsing each supersedes-chain to its live tip.
   * The explicit historical flag - history is opt-in, never inferred from
   * the query. Omitted/false injects only chain tips.
   */
  readonly includeHistorical?: boolean;
  /**
   * Opt-in provenance stamp (context-integrity-gates, Unit B). Required
   * by any caller that PERSISTS a pack, so the persisted copy can be
   * verified against the vault on read instead of being trusted forever.
   * Omitted keeps the report byte-identical.
   */
  readonly stamp?: PackStampOptions;
  /**
   * Which candidate pages the caller may see, asked with each page's
   * ABSOLUTE path. Applied to the collected candidates before ranking,
   * budgeting, lanes, dedup, tension warnings and the receipt, so a
   * withheld page contributes nothing to any member of the report - not
   * its body, not its id in `skipped`, not its path in `lanes`. Omitted
   * keeps every candidate (the operator's own local surfaces).
   */
  readonly visible?: (absPath: string) => boolean;
}

interface Candidate {
  readonly id: string;
  readonly path: string;
  readonly tier: PageTier;
  readonly createdAtMs: number;
  readonly topic: string;
  readonly principle: string;
  readonly contextLane: ContextLaneName | null;
  readonly body: string;
  readonly tokens: number;
  readonly epistemic: EpistemicStatus;
  readonly evidenceRefs: ReadonlyArray<string>;
  readonly commitment: BrainCommitmentTier | null;
  readonly safety?: ContextSafetyReport;
  /**
   * Normalized `superseded_by` pointer when this memory has been
   * replaced (Belief lifecycle suite, A4). Drives inject tip-preference:
   * a superseded ancestor is dropped in favour of its live tip unless
   * the caller opts into `includeHistorical`.
   */
  readonly supersededBy: string | null;
  /**
   * Which delivery directory the candidate came from. The opt-in
   * packing policy splits its two lanes on exactly this: preference
   * pages are the facts lane, retired pages are the pages lane.
   */
  readonly source: "preferences" | "retired";
}

function withOptionalLanes(
  opts: ContextPackOptions,
  items: ReadonlyArray<ContextPackItem>,
): { readonly lanes?: ContextLanesReport } {
  if (opts.includeLanes !== true) return {};
  return {
    lanes: buildContextLanes(
      items.map((item) => ({
        id: item.id,
        path: item.path,
        tier: item.tier,
        tokens: item.tokens,
        body: item.body,
        trimmed: item.trimmed,
        principle: item.principle,
        manualLane: item.contextLane,
      })),
    ),
  };
}

/**
 * Build one emitted pack item from a budgeted candidate. Shared by the
 * unified budget loop and the opt-in packing-policy loop so both
 * construct byte-identical items; the density recompute reads the
 * emitted (post-trim) body exactly as the unified loop always has.
 */
function toContextPackItem(
  c: Candidate,
  body: string,
  trimmed: boolean,
  tokens: number,
  densityRanking: boolean,
  densityScoreById: ReadonlyMap<string, number>,
): ContextPackItem {
  return {
    id: c.id,
    path: c.path,
    tier: c.tier,
    tokens,
    body,
    principle: c.principle,
    contextLane: c.contextLane,
    trimmed,
    epistemic: c.epistemic,
    evidenceRefs: c.evidenceRefs,
    ...(c.commitment !== null ? { commitment: c.commitment } : {}),
    // When the per-memory char budget trimmed this item, recompute density
    // from the emitted (post-trim) body/tokens so the surfaced value reflects
    // the actual content/token-cost the agent receives, not the pre-budget
    // candidate. Untrimmed items reuse the pre-computed score.
    ...(densityRanking
      ? {
          density: trimmed
            ? densityScore({ body, evidenceRefs: c.evidenceRefs, epistemic: c.epistemic }, tokens)
            : (densityScoreById.get(c.id) ?? 0),
        }
      : {}),
    ...(c.safety ? { safety: c.safety } : {}),
  };
}

/** A priced lane entry: the candidate as the lane would emit it, in tokens. */
interface PackedLaneEntry {
  readonly candidate: Candidate;
  readonly body: string;
  readonly trimmed: boolean;
  readonly tokens: number;
}

/**
 * Serve-with-correction coupling over the collected candidates
 * (truth-correctable-time-aware, contract item 3). A candidate whose
 * frontmatter declares a successor - the serveable-retired regime the
 * correct verb's validity-close writes - is kept only beside its
 * resolved, readable chain-tip correction and is dropped fail-closed
 * when a hop dangles; a candidate with no pointer is not in the
 * predicate's regime and passes through unchanged. `visible` is the
 * caller's per-page verdict over ABSOLUTE paths; it becomes the chain
 * lookup's readability, so a tip the caller may not read resolves as
 * little as nothing at all.
 */
function applyCouplingToCandidates(
  vault: string,
  candidates: ReadonlyArray<Candidate>,
  visible: ((absPath: string) => boolean) | undefined,
): ReadonlyArray<Candidate> {
  if (candidates.every((c) => c.supersededBy === null)) return candidates;
  const readable = visible === undefined ? undefined : (rel: string) => visible(join(vault, rel));
  const chainLookup = buildChainLookup(vault, readable);
  return candidates.filter((c) => {
    if (c.supersededBy === null) return true;
    const verdict = chainVerdict(
      relative(vault, c.path),
      resolveChainTip(c.supersededBy, chainLookup),
    );
    return verdict.action === "serve_coupled";
  });
}

function collectCandidates(
  vault: string,
  delimitUntrusted: boolean,
  ownerScope: OwnerScopeDelivery,
): { readonly candidates: Candidate[]; readonly hiddenByOwnerScope: number } {
  const dirs = brainDirs(vault);
  const out: Candidate[] = [];
  let hiddenByOwnerScope = 0;
  for (const dir of [dirs.preferences, dirs.retired]) {
    // Shared delivery-path walk (context-integrity-gates, Unit A). This
    // surface reads raw frontmatter rather than the preference schema:
    // it injects the BODY, and it walks the retired directory alongside
    // the preferences one, where the preference schema does not apply.
    //
    // Unit F: `parseFrontmatter` cannot throw (it reads inside its own
    // try; everything after is string work), so the `catch { continue }`
    // that stood here was unreachable and reported nothing. Dropped
    // lines and unreadable reads are reported centrally instead - see
    // the "Why most readers keep the two-tuple form" section in
    // src/core/vault.ts. A pack returns injected content and carries no
    // per-candidate report, so it opens no channel of its own.
    const source: "preferences" | "retired" = dir === dirs.preferences ? "preferences" : "retired";
    const collected = collectPreferencePages(dir, { ownerScope });
    hiddenByOwnerScope += collected.hiddenByOwnerScope;
    for (const { name, path: full, meta, body } of collected.entries) {
      // Belief lifecycle suite (t_7d5a3589): a tombstoned (incl.
      // superseded-non-tip) memory stays on disk for audit but is never
      // injected into a context pack.
      if (isTombstoned(meta)) continue;
      const id = typeof meta["id"] === "string" ? meta["id"] : name.replace(/\.md$/, "");
      const tier = readTier(meta);
      const created = typeof meta["created_at"] === "string" ? meta["created_at"] : "";
      let fallbackMtimeMs = 0;
      if (!created) {
        try {
          fallbackMtimeMs = statSync(full).mtimeMs;
        } catch {
          fallbackMtimeMs = 0;
        }
      }
      const createdAtMs = created ? Date.parse(created) : fallbackMtimeMs;
      const topic = typeof meta["topic"] === "string" ? meta["topic"] : "";
      const principle = typeof meta["principle"] === "string" ? meta["principle"] : "";
      const supersededBy =
        typeof meta["superseded_by"] === "string" && meta["superseded_by"] !== ""
          ? (meta["superseded_by"] as string)
          : null;
      const contextLane = normalizeContextLane(meta["context_lane"]);
      const epistemic = deriveEpistemicStatus(meta);
      const guarded = guardBrainContextSnippet(body, {
        source: { id, path: full, metadata: meta },
        ...(meta["context_safety"] === "trusted-instruction"
          ? { trust: "trusted-instruction" as const }
          : {}),
        ...(delimitUntrusted
          ? { delimitUntrusted: true, provenancePath: canonicalNotePath(relative(vault, full)) }
          : {}),
      });
      // Token budget is computed against the body the pack actually
      // emits, not the full file - frontmatter tokens are never
      // returned to the caller, so charging them would under-fill
      // the context window. Safety filtering therefore happens before
      // token accounting.
      out.push({
        id,
        path: full,
        tier,
        createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : 0,
        topic,
        principle,
        contextLane,
        body: guarded.safeText,
        tokens: estimateTokens(guarded.safeText),
        epistemic: epistemic.status,
        evidenceRefs: epistemic.evidenceRefs,
        commitment: readCommitmentTier(meta),
        supersededBy,
        source,
        ...(contextSafetyReport(guarded) ? { safety: contextSafetyReport(guarded) } : {}),
      });
    }
  }
  return { candidates: out, hiddenByOwnerScope };
}

/**
 * A stamped call is statically known to return a stamped report, so a
 * persisting caller never has to handle an "impossible" absent stamp -
 * the case that would otherwise invite exactly the silent fallback this
 * wave removes.
 */
export function packContext(
  vault: string,
  opts: ContextPackOptions & { readonly stamp: PackStampOptions },
): ContextPackReport & { readonly stamp: ContextPackStamp };
export function packContext(vault: string, opts: ContextPackOptions): ContextPackReport;
export function packContext(vault: string, opts: ContextPackOptions): ContextPackReport {
  const startedAtMs = Date.now();
  const semanticRelevance = semanticRelevanceFor(opts);
  if (!Number.isFinite(opts.maxTokens) || opts.maxTokens <= 0) {
    // The zero-budget short-circuit reads no vault: neither lane was ever
    // offered a budget to hold. A NAMED policy gets the same by-name
    // refusal the partition gives an empty lane - a zeroed accounting
    // object would answer a policy the caller asked for with a delivery
    // that never happened.
    if (opts.packingPolicy !== undefined) {
      throw ContextPackPackingLaneEmptyError.zeroBudget(opts.packingPolicy);
    }
    return finalizeContextPackReport(
      vault,
      opts,
      {
        maxTokens: 0,
        tokensUsed: 0,
        items: Object.freeze([]),
        skipped: Object.freeze([]),
        ...withOptionalLanes(opts, []),
      },
      startedAtMs,
    );
  }
  // One query argument, two readings (v1.53.0). `ranked` takes the query
  // out of the filter and into the sort, so `query` below - the substring
  // predicate - is null in that mode and no candidate is ever excluded for
  // failing to contain the turn verbatim.
  const rankedQuery = opts.queryMode === "ranked" && opts.query ? opts.query : null;
  const query =
    rankedQuery === null && semanticRelevance === null && opts.query
      ? normalizeForDedup(opts.query)
      : null;
  // Opt-in language-agnostic prompt-injection containment (Unit 1).
  // Default off, so the surfaced bodies are byte-identical to the legacy
  // blocklist guard unless the vault enables the flag.
  const delimitUntrusted = loadGuardrailsConfigSafe(vault).untrusted_source_delimiting;
  // Belief lifecycle suite (A4, t_d9365884): prefer supersedes-chain tips.
  // A superseded ancestor is dropped in favour of its live tip so a chain
  // of replacements injects only the current belief; `includeHistorical`
  // keeps the whole chain (explicit flag, never inferred). A vault with no
  // supersession chains passes through byte-identically.
  const ownerScope = resolveOwnerScopeDelivery(vault, opts.agentScope);
  const collected = collectCandidates(vault, delimitUntrusted, ownerScope);
  // Serve-with-correction coupling (truth-correctable-time-aware,
  // contract item 3): a candidate the chain-tip preference would keep -
  // under `includeHistorical`, a superseded ancestor - is injected only
  // beside its resolved, readable chain-tip correction and is dropped
  // fail-closed when a hop dangles, so a historical injection cannot
  // resurrect a predecessor whose correction is not there. The caller's
  // visibility is the chain lookup's readability, so a withheld tip
  // resolves exactly as little as the caller may read. Non-historical
  // injection keeps only tips and is unchanged.
  const coupled =
    opts.includeHistorical === true
      ? applyCouplingToCandidates(vault, collected.candidates, opts.visible)
      : collected.candidates;
  // Reach filtering happens after the chain-tip preference: a withheld
  // tip must not resurrect the superseded ancestor it replaced.
  const tips = preferChainTips(coupled, {
    historical: opts.includeHistorical === true,
  }).kept;
  const withheldIds = new Set<string>();
  const candidates = tips.filter((c) => {
    if (opts.visible === undefined || opts.visible(c.path)) return true;
    withheldIds.add(c.id);
    return false;
  });
  // Reported only under `warn`, where nothing was withheld - see
  // `formatOwnerScopeWarning` for why `fail` stays silent.
  const ownerScopeWarning = formatOwnerScopeWarning(ownerScope, collected.hiddenByOwnerScope);
  const ownerScopeWarnings = ownerScopeWarning === null ? [] : [ownerScopeWarning];

  // Focus boost (within-tier only): computed once per candidate, 0 for
  // every candidate when no active focus is supplied, so the default
  // sort stays byte-identical.
  const focus = sessionFocusIsActive(opts.sessionFocus) ? opts.sessionFocus! : null;
  const focusScore = new Map<string, number>();
  if (focus !== null) {
    for (const c of candidates) {
      focusScore.set(
        c.id,
        scoreSessionFocusTarget({ path: c.path, title: c.topic, content: c.body }, focus),
      );
    }
  }

  // Query relevance (v1.53.0), computed once per candidate ONLY in ranked
  // mode. Structural token overlap - the same deterministic, stopword-free,
  // language-agnostic kernel `matchRatedDecisions` ranks with; no model, no
  // embedding, so it works on a default install that has never indexed a
  // vector. Matched against topic + principle + body because the turn's
  // vocabulary lands in the body as often as in the one-line principle.
  // The map is empty when the mode is off, so both sides read 0 and the
  // comparator falls straight through.
  const relevanceById = new Map<string, number>();
  // Semantic relevance reads the caller's map over the KEPT candidates
  // only, so the report below is post-reach by construction.
  const unembedded: string[] = [];
  let scored = 0;
  if (semanticRelevance !== null) {
    for (const c of candidates) {
      const score = semanticRelevance.get(canonicalNotePath(relative(vault, c.path)));
      if (score === undefined) unembedded.push(c.id);
      else scored += 1;
      relevanceById.set(c.id, score ?? UNEMBEDDED_RELEVANCE);
    }
  }
  // No kept candidate has a usable vector: a "semantic" order would be
  // pure recency. Refused here, before the receipt and telemetry are
  // emitted, so a refused pack leaves no record of a delivery. An empty
  // candidate set is an empty pack, not a refusal.
  if (semanticRelevance !== null && candidates.length > 0 && scored === 0) {
    throw new SearchError(
      "BELIEF_VECTORS_MISSING",
      `semantic belief order unavailable: none of the ${candidates.length} belief note(s) ` +
        `in reach has a stored vector for the configured model; run: ${BELIEF_VECTORS_BACKFILL_COMMAND}`,
    );
  }
  const semanticReport: { readonly semantic?: ContextPackSemanticReport } =
    semanticRelevance === null
      ? {}
      : {
          semantic: Object.freeze({
            scored,
            unembedded: Object.freeze(unembedded.toSorted()),
          }),
        };
  if (rankedQuery !== null) {
    const queryTokens = tokenise(rankedQuery);
    for (const c of candidates) {
      relevanceById.set(
        c.id,
        jaccard(queryTokens, tokenise(`${c.topic} ${c.principle} ${c.body}`)),
      );
    }
  }

  // Value-per-token density (impact-per-token allocation, t_affa3bd9):
  // computed once per candidate ONLY when opted in, so with the flag off
  // the map is empty, the density comparator is a no-op, and the sort
  // stays byte-identical to the legacy tier → recency ordering.
  const densityRanking = opts.densityRanking === true;
  const densityScoreById = new Map<string, number>();
  if (densityRanking) {
    for (const c of candidates) {
      densityScoreById.set(
        c.id,
        densityScore(
          { body: c.body, evidenceRefs: c.evidenceRefs, epistemic: c.epistemic },
          c.tokens,
        ),
      );
    }
  }

  candidates.sort((a, b) => {
    const tierA = TIER_ORDER.indexOf(a.tier);
    const tierB = TIER_ORDER.indexOf(b.tier);
    if (tierA !== tierB) return tierA - tierB;
    const focusA = focusScore.get(a.id) ?? 0;
    const focusB = focusScore.get(b.id) ?? 0;
    if (focusA !== focusB) return focusB - focusA;
    // Ranked-query relevance sits between focus and density: a bound
    // session focus is a standing, operator-established target and still
    // dominates, while density is a static content heuristic that an
    // explicit per-call query outranks. Tier remains the coarse gate above
    // all three - a peripheral page never outranks a core one on relevance.
    const relA = relevanceById.get(a.id) ?? 0;
    const relB = relevanceById.get(b.id) ?? 0;
    if (relA !== relB) return relB - relA;
    // Density breaks within-tier ties after focus, before recency. The
    // map is empty when the flag is off, so both sides read 0 and the
    // comparator falls straight through to recency → id.
    const densA = densityScoreById.get(a.id) ?? 0;
    const densB = densityScoreById.get(b.id) ?? 0;
    if (densA !== densB) return densB - densA;
    if (a.createdAtMs !== b.createdAtMs) return b.createdAtMs - a.createdAtMs;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  // Opt-in packing policy (recall-lane-latency wave): correlate the two
  // candidate populations that share this one budget - preference pages
  // (the facts lane, the distilled layer) and retired pages (the pages
  // lane) - and let the caller name the claim order. The whole branch
  // runs ONLY when the policy is named; an omitted option never reaches
  // it, which is what keeps the unified pack byte-identical.
  if (opts.packingPolicy !== undefined) {
    const policy = opts.packingPolicy;
    const factsCandidates = candidates.filter((c) => c.source === "preferences");
    const pagesCandidates = candidates.filter((c) => c.source === "retired");
    const laneSkipped: ContextPackSkipped[] = [];
    // The substring reading still applies per lane, BEFORE the
    // allocation: a query-missed page never occupies its lane's budget.
    const applyLaneQuery = (list: ReadonlyArray<Candidate>): Candidate[] =>
      list.filter((c) => {
        if (query === null) return true;
        const haystack = normalizeForDedup(`${c.topic} ${c.principle}`);
        if (haystack.includes(query)) return true;
        laneSkipped.push({ id: c.id, tokens: c.tokens, reason: "filter-miss" });
        return false;
      });
    const factsFiltered = applyLaneQuery(factsCandidates);
    const pagesFiltered = applyLaneQuery(pagesCandidates);
    // A policy against an empty lane would silently do nothing; refuse
    // by name, before any receipt or telemetry exists to record a
    // delivery that never happened. Both empty lanes are named when both
    // are empty - the refusal states what it observed, not the first miss.
    const emptyLanes = [
      ...(factsFiltered.length === 0 ? (["facts"] as const) : []),
      ...(pagesFiltered.length === 0 ? (["pages"] as const) : []),
    ];
    if (emptyLanes.length > 0) {
      throw ContextPackPackingLaneEmptyError.emptyLanes(policy, emptyLanes);
    }
    // The synthesized attention block is a reserved charge against the
    // same total, prepared before the allocation so neither lane can
    // draw over it; the charge itself stays exactly where the unified
    // path draws it, after the lanes.
    let attention: {
      readonly body: string;
      readonly tokens: number;
      readonly safetyReport: ContextSafetyReport | undefined;
    } | null = null;
    if (opts.attentionFlowIds && opts.attentionFlowIds.length > 0) {
      const attentionBody = buildAttentionContextBlock(vault, opts.attentionFlowIds);
      if (attentionBody && attentionBody.trim()) {
        const guarded = guardBrainContextSnippet(attentionBody, {
          source: { id: "attention-flows", path: join(vault, "Brain", "attention", "flows") },
          ...(delimitUntrusted
            ? { delimitUntrusted: true, provenancePath: "Brain/attention/flows" }
            : {}),
        });
        const safeAttentionBody = guarded.safeText;
        if (!safeAttentionBody.trim()) {
          // The guard reduced the whole block to nothing - surface nothing
          // rather than an empty attention-flows item.
          laneSkipped.push({ id: "attention-flows", tokens: 0, reason: "filter-miss" });
        } else {
          const safetyReport = contextSafetyReport(guarded);
          attention = {
            body: safeAttentionBody,
            tokens: estimateTokens(safeAttentionBody),
            safetyReport,
          };
        }
      }
    }
    // A reserved charge that consumes the whole total leaves neither lane
    // anything to draw - the same silent delivery the zero-budget
    // short-circuit refuses, reached through the reserved charge instead
    // of a zero maxTokens. Both lanes hold candidates here (the
    // empty-lane refusal passed above), so packing by the named order
    // would answer with zeroed lane accounting; refuse by name instead,
    // before any receipt or telemetry exists to record a delivery that
    // never happened.
    if (attention !== null && attention.tokens >= opts.maxTokens) {
      throw ContextPackPackingLaneEmptyError.reservedCharge(
        policy,
        attention.tokens,
        opts.maxTokens,
      );
    }
    // Per-memory char cap stays lane-internal: trim inside the lane
    // first, then price the emitted text so the allocation charges what
    // the lane would actually deliver.
    const priceLane = (list: ReadonlyArray<Candidate>): PackedLaneEntry[] =>
      applyCharBudget(
        list.map((c) => ({ item: c, text: c.body })),
        {
          maxCharsPerEntry: opts.maxCharsPerMemory,
          ...(opts.degradation !== undefined ? { degradation: opts.degradation } : {}),
        },
      ).kept.map((k) => ({
        candidate: k.item,
        body: k.text,
        trimmed: k.trimmed,
        tokens: k.trimmed ? estimateTokens(k.text) : k.item.tokens,
      }));
    const factsEntries = priceLane(factsFiltered);
    const pagesEntries = priceLane(pagesFiltered);
    const allocation = allocateRecallBudget(
      opts.maxTokens,
      pagesEntries.map((entry) => ({ item: entry, tokens: entry.tokens })),
      factsEntries.map((entry) => ({ item: entry, tokens: entry.tokens })),
      policy,
      attention?.tokens ?? 0,
    );
    const claimOrder: ReadonlyArray<RecallBudgetLaneName> =
      policy === "retired_first" ? ["pages", "facts"] : ["facts", "pages"];
    // Lane overflow is an `over-budget` skip exactly like the unified
    // loop's; the policy adds no skip reason of its own.
    const tokensById = new Map<string, number>();
    for (const entry of [...factsEntries, ...pagesEntries]) {
      tokensById.set(entry.candidate.id, entry.tokens);
    }
    for (const lane of claimOrder) {
      for (const dropped of allocation[lane].dropped) {
        laneSkipped.push({
          id: dropped.candidate.id,
          tokens: tokensById.get(dropped.candidate.id) ?? 0,
          reason: "over-budget",
        });
      }
    }
    const items: ContextPackItem[] = [];
    for (const lane of claimOrder) {
      for (const kept of allocation[lane].kept) {
        items.push(
          toContextPackItem(
            kept.candidate,
            kept.body,
            kept.trimmed,
            kept.tokens,
            densityRanking,
            densityScoreById,
          ),
        );
      }
    }
    if (attention !== null) {
      const used = items.reduce((sum, item) => sum + item.tokens, 0);
      if (used + attention.tokens <= opts.maxTokens) {
        items.unshift({
          id: "attention-flows",
          path: join(vault, "Brain", "attention", "flows"),
          tier: PAGE_TIER.core,
          tokens: attention.tokens,
          body: attention.body,
          principle: "Declarative attention flow output",
          contextLane: "directives",
          trimmed: false,
          // Synthesized from the vault's attention-flow graph, not a
          // source-backed page, so it is `derived` with no evidence refs.
          epistemic: EPISTEMIC_STATUS.derived,
          evidenceRefs: [],
          ...(attention.safetyReport ? { safety: attention.safetyReport } : {}),
        });
      } else {
        laneSkipped.push({
          id: "attention-flows",
          tokens: attention.tokens,
          reason: "over-budget",
        });
      }
    }
    // Lane membership by id, so the delivered spends stay honest after
    // the char budget and the transforms have had their say.
    const laneById = new Map<string, RecallBudgetLaneName>();
    for (const c of factsCandidates) laneById.set(c.id, "facts");
    for (const c of pagesCandidates) laneById.set(c.id, "pages");
    const packingFor = (
      finalItems: ReadonlyArray<ContextPackItem>,
    ): { readonly packing: ContextPackPackingReport } => ({
      packing: Object.freeze({
        policy,
        reservedTokens: allocation.reservedTokens,
        pages: packingLaneReport("pages", allocation, laneById, finalItems, pagesFiltered.length),
        facts: packingLaneReport("facts", allocation, laneById, finalItems, factsFiltered.length),
      }),
    });
    // Total recall character cap: the same second ceiling the unified
    // path applies over the emitted items, dropping the lowest-priority
    // overflow - here, the tail of the lane order.
    if (opts.maxTotalChars && opts.maxTotalChars > 0) {
      const capped = applyCharBudget(
        items.map((i) => ({ item: i, text: i.body })),
        { maxTotalChars: opts.maxTotalChars },
      );
      if (capped.dropped.length > 0) {
        const keptItems = applyContextTransforms(
          capped.kept.map((k) => k.item),
          opts.transforms,
        );
        const droppedSet = new Set(capped.dropped);
        let recomputed = 0;
        for (const i of keptItems) recomputed += i.tokens;
        for (const d of items) {
          if (droppedSet.has(d)) {
            laneSkipped.push({
              id: d.id,
              tokens: d.tokens,
              reason: "over-char-budget",
            });
          }
        }
        return finalizeContextPackReport(
          vault,
          opts,
          {
            maxTokens: opts.maxTokens,
            tokensUsed: recomputed,
            items: Object.freeze(keptItems),
            skipped: Object.freeze(laneSkipped),
            ...withOptionalLanes(opts, keptItems),
            ...semanticReport,
            ...packingFor(keptItems),
          },
          startedAtMs,
          ownerScopeWarnings,
          withheldIds,
        );
      }
    }
    const finalItems = applyContextTransforms(items, opts.transforms);
    const finalTokensUsed = finalItems.reduce((sum, item) => sum + item.tokens, 0);
    return finalizeContextPackReport(
      vault,
      opts,
      {
        maxTokens: opts.maxTokens,
        tokensUsed: finalTokensUsed,
        items: Object.freeze(finalItems),
        skipped: Object.freeze(laneSkipped),
        ...withOptionalLanes(opts, finalItems),
        ...semanticReport,
        ...packingFor(finalItems),
      },
      startedAtMs,
      ownerScopeWarnings,
      withheldIds,
    );
  }

  // Per-memory character cap (v0.20.0): trim oversized bodies in priority
  // order via the shared budget primitive before the token budget runs,
  // so one huge page cannot starve the rest. A trimmed body is re-tokenised
  // so the token budget charges the emitted text, not the original.
  const budgeted = applyCharBudget(
    candidates.map((c) => ({ item: c, text: c.body })),
    {
      maxCharsPerEntry: opts.maxCharsPerMemory,
      ...(opts.degradation !== undefined ? { degradation: opts.degradation } : {}),
    },
  );

  const items: ContextPackItem[] = [];
  const skipped: ContextPackSkipped[] = [];
  let used = 0;
  for (const { item: c, text: body, trimmed } of budgeted.kept) {
    if (query !== null) {
      const haystack = normalizeForDedup(`${c.topic} ${c.principle}`);
      if (!haystack.includes(query)) {
        skipped.push({ id: c.id, tokens: c.tokens, reason: "filter-miss" });
        continue;
      }
    }
    const tokens = trimmed ? estimateTokens(body) : c.tokens;
    if (used + tokens > opts.maxTokens) {
      skipped.push({ id: c.id, tokens, reason: "over-budget" });
      continue;
    }
    items.push(toContextPackItem(c, body, trimmed, tokens, densityRanking, densityScoreById));
    used += tokens;
  }

  if (opts.attentionFlowIds && opts.attentionFlowIds.length > 0) {
    const attentionBody = buildAttentionContextBlock(vault, opts.attentionFlowIds);
    if (attentionBody && attentionBody.trim()) {
      const guarded = guardBrainContextSnippet(attentionBody, {
        source: { id: "attention-flows", path: join(vault, "Brain", "attention", "flows") },
        ...(delimitUntrusted
          ? { delimitUntrusted: true, provenancePath: "Brain/attention/flows" }
          : {}),
      });
      const safeAttentionBody = guarded.safeText;
      const tokens = estimateTokens(safeAttentionBody);
      const safetyReport = contextSafetyReport(guarded);
      if (!safeAttentionBody.trim()) {
        // The guard reduced the whole block to nothing - surface nothing
        // rather than an empty attention-flows item.
        skipped.push({ id: "attention-flows", tokens: 0, reason: "filter-miss" });
      } else if (used + tokens <= opts.maxTokens) {
        items.unshift({
          id: "attention-flows",
          path: join(vault, "Brain", "attention", "flows"),
          tier: PAGE_TIER.core,
          tokens,
          body: safeAttentionBody,
          principle: "Declarative attention flow output",
          contextLane: "directives",
          trimmed: false,
          // Synthesized from the vault's attention-flow graph, not a
          // source-backed page, so it is `derived` with no evidence refs.
          epistemic: EPISTEMIC_STATUS.derived,
          evidenceRefs: [],
          ...(safetyReport ? { safety: safetyReport } : {}),
        });
        used += tokens;
      } else {
        skipped.push({
          id: "attention-flows",
          tokens,
          reason: "over-budget",
        });
      }
    }
  }

  // Total recall character cap (v0.20.0): a second ceiling over the
  // token-budgeted set. Applied via the shared primitive on the emitted
  // items only (so query-missed pages never count), dropping the
  // lowest-priority overflow.
  if (opts.maxTotalChars && opts.maxTotalChars > 0) {
    const capped = applyCharBudget(
      items.map((i) => ({ item: i, text: i.body })),
      { maxTotalChars: opts.maxTotalChars },
    );
    if (capped.dropped.length > 0) {
      const keptItems = applyContextTransforms(
        capped.kept.map((k) => k.item),
        opts.transforms,
      );
      const droppedSet = new Set(capped.dropped);
      let recomputed = 0;
      for (const i of keptItems) recomputed += i.tokens;
      for (const d of items) {
        if (droppedSet.has(d)) {
          skipped.push({
            id: d.id,
            tokens: d.tokens,
            reason: "over-char-budget",
          });
        }
      }
      return finalizeContextPackReport(
        vault,
        opts,
        {
          maxTokens: opts.maxTokens,
          tokensUsed: recomputed,
          items: Object.freeze(keptItems),
          skipped: Object.freeze(skipped),
          ...withOptionalLanes(opts, keptItems),
          ...semanticReport,
        },
        startedAtMs,
        ownerScopeWarnings,
        withheldIds,
      );
    }
  }

  const finalItems = applyContextTransforms(items, opts.transforms);
  const finalTokensUsed = finalItems.reduce((sum, item) => sum + item.tokens, 0);
  return finalizeContextPackReport(
    vault,
    opts,
    {
      maxTokens: opts.maxTokens,
      tokensUsed: finalTokensUsed,
      items: Object.freeze(finalItems),
      skipped: Object.freeze(skipped),
      ...withOptionalLanes(opts, finalItems),
      ...semanticReport,
    },
    startedAtMs,
    ownerScopeWarnings,
    withheldIds,
  );
}

/**
 * What one lane delivered: the allocation the correlated budget handed
 * it and the tokens actually present in the FINAL items, so the two
 * spends plus the reserved charge account for the whole budget no
 * matter what the char cap or the transforms dropped.
 */
function packingLaneReport(
  lane: RecallBudgetLaneName,
  allocation: RecallBudgetAllocation<PackedLaneEntry, PackedLaneEntry>,
  laneById: ReadonlyMap<string, RecallBudgetLaneName>,
  finalItems: ReadonlyArray<ContextPackItem>,
  candidates: number,
): ContextPackPackingLaneReport {
  let spent = 0;
  let items = 0;
  for (const item of finalItems) {
    if (laneById.get(item.id) !== lane) continue;
    spent += item.tokens;
    items += 1;
  }
  return Object.freeze({ allocation: allocation[lane].allocation, spent, candidates, items });
}

/**
 * The relevance map the `semantic` mode reads, or null in every other
 * mode. Throws {@link ContextPackSemanticRelevanceMissingError} when the
 * mode is `semantic` and the map is absent.
 */
function semanticRelevanceFor(opts: ContextPackOptions): ReadonlyMap<string, number> | null {
  if (opts.queryMode !== "semantic") return null;
  if (opts.semanticRelevance === undefined) throw new ContextPackSemanticRelevanceMissingError();
  return opts.semanticRelevance;
}

function finalizeContextPackReport(
  vault: string,
  opts: ContextPackOptions,
  report: ContextPackReport,
  startedAtMs: number,
  /**
   * Gate reports that are not per-item tension warnings, currently the
   * owner-scope observation. Empty on every path that has no candidates
   * to observe, so the `warnings` key stays absent and the pack stays
   * byte-identical.
   */
  extraWarnings: ReadonlyArray<string> = [],
  /**
   * Ids of candidates {@link ContextPackOptions.visible} withheld. A
   * tension between an injected memory and one of these is still
   * reported, but without the tension id, which embeds both subject ids.
   */
  withheldIds: ReadonlySet<string> = new Set(),
): ContextPackReport {
  let enriched = report;
  // Belief lifecycle suite (S2, t_0e3f2bee): flag any injected memory that
  // is a subject of an unresolved (open/confirmed) tension. Additive: with
  // no such tension the helper returns [] and the `warnings` key is never
  // added, so a tension-free pack stays byte-identical.
  const tensionWarnings = tensionWarningsForContextItems(
    vault,
    report.items.map((item) => item.id),
    withheldIds,
  );
  const warnings = [...extraWarnings, ...tensionWarnings];
  if (warnings.length > 0) {
    enriched = { ...enriched, warnings };
  }
  // Provenance stamp (context-integrity-gates, Unit B). Attached in the
  // one funnel every return path already passes through, so the
  // zero-budget early return is stamped exactly like the full pack and
  // no future exit can forget it. Absent option → absent key.
  if (opts.stamp !== undefined) {
    const stampSource =
      opts.stamp.configPath !== undefined ? { configPath: opts.stamp.configPath } : {};
    enriched = { ...enriched, stamp: buildPackStamp(vault, opts.stamp.now, stampSource) };
  }
  // Gated emissions route through the lazy emit kernel (t_5d7aa7c5):
  // with the option absent the thunk never runs, and a broken
  // continuity store can no longer fail the pack (fail-open).
  const receipt = emitGatedTelemetry(opts.receipt, (receiptOptions) =>
    emitContextReceipt(vault, {
      options: receiptOptions,
      items: report.items.map((item) => ({
        id: item.id,
        path: item.path,
        text: item.body,
        tokens: item.tokens,
        tier: item.tier,
        trimmed: item.trimmed,
        safetyFiltered: item.safety?.filtered,
        epistemic: item.epistemic,
        evidenceRefs: item.evidenceRefs,
      })),
      finalText: report.items.map((item) => item.body).join("\n\n"),
      budget: contextPackBudgetMetadata(opts, report),
      ...(opts.recallAdequacy ? { adequacy: opts.recallAdequacy } : {}),
      ...(opts.recallAdequacy && opts.decisionAnswerable
        ? { decisionAnswerable: opts.decisionAnswerable }
        : {}),
      extra: {
        skipped_count: report.skipped.length,
        lanes: opts.includeLanes === true,
      },
    }),
  );
  if (receipt) enriched = { ...enriched, receiptId: receipt.id };
  const telemetry = emitGatedTelemetry(opts.telemetry, (telemetryOptions) =>
    emitRecallTelemetry(vault, {
      ...recallTelemetryEnvelope(telemetryOptions),
      mode: "context_pack",
      status: report.items.length > 0 ? "ok" : "empty",
      durationMs: Date.now() - startedAtMs,
      resultCount: report.items.length,
      topArtifacts: report.items.slice(0, 10).map((item) => ({ id: item.id, path: item.path })),
      gaps: contextPackGaps(report),
      metadata: {
        ...(telemetryOptions.metadata ?? {}),
        ...contextPackBudgetMetadata(opts, report),
        skipped_count: report.skipped.length,
        lanes: opts.includeLanes === true,
        ...(enriched.receiptId ? { receipt_id: enriched.receiptId } : {}),
      },
    }),
  );
  if (telemetry) enriched = { ...enriched, telemetryId: telemetry.id };
  // Structural prefix-stability metric (opt-in, fail-soft). The pack's
  // cacheable preamble is its stable request framing - byte-identical
  // for an identical request, which is what a provider prefix cache
  // rewards. Built only when the gate is on, so neither the summary nor
  // its hash is computed on the default (no-consumer) path.
  if (opts.promptPrefix) {
    emitPromptPrefixMetric(
      vault,
      {
        runAt: isoSecond(new Date()),
        summary: summarizePrefixPass({
          kind: "context_pack",
          prefixes: [
            deterministicPrefix({
              kind: "context_pack",
              segments: [
                canonicalSegment({
                  lanes: String(opts.includeLanes === true),
                  max_tokens: String(report.maxTokens),
                  query: opts.query ?? "",
                  // Added only when the caller named a mode: the same
                  // query read two ways is two different requests, but a
                  // caller that named none must keep the prefix it had.
                  ...(opts.queryMode !== undefined ? { query_mode: opts.queryMode } : {}),
                  // Added only when the caller named a policy, on the
                  // same rule: the policy decides what the budget buys,
                  // so the same query under two policies is two
                  // different requests - and a caller that named none
                  // keeps its cacheable prefix byte for byte.
                  ...(opts.packingPolicy !== undefined
                    ? { packing_policy: opts.packingPolicy }
                    : {}),
                }),
              ],
            }),
          ],
        }),
      },
      opts.promptPrefix,
    );
  }
  return Object.freeze(enriched);
}

function contextPackBudgetMetadata(
  opts: ContextPackOptions,
  report: ContextPackReport,
): Record<string, unknown> {
  return {
    max_tokens: report.maxTokens,
    tokens_used: report.tokensUsed,
    ...(opts.maxCharsPerMemory !== undefined
      ? { max_chars_per_memory: opts.maxCharsPerMemory }
      : {}),
    ...(opts.maxTotalChars !== undefined ? { max_total_chars: opts.maxTotalChars } : {}),
    // Named only when the caller named a policy: the receipt and the
    // synced telemetry record then carry a member of the frozen
    // PACKING_POLICIES vocabulary - which names nothing sensitive - and
    // an unnamed caller's records never grow the key.
    ...(opts.packingPolicy !== undefined ? { packing_policy: opts.packingPolicy } : {}),
  };
}

function contextPackGaps(report: ContextPackReport): ReadonlyArray<string> {
  const gaps = new Set<string>();
  if (report.items.length === 0 && report.skipped.length === 0) gaps.add("no_matching_context");
  for (const skipped of report.skipped) gaps.add(skipped.reason.replace(/-/g, "_"));
  return [...gaps];
}
