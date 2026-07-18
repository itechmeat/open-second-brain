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

import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { parseFrontmatter } from "../vault.ts";
import { canonicalNotePath } from "../path-safety.ts";
import { loadGuardrailsConfigSafe } from "./policy.ts";
import {
  contextSafetyReport,
  guardBrainContextSnippet,
  type ContextSafetyReport,
} from "./safety/context-guard.ts";
import { brainDirs } from "./paths.ts";
import { isTombstoned } from "./lifecycle/tombstone.ts";
import { preferChainTips } from "./inject-governor.ts";
import { PAGE_TIER, readTier, type PageTier } from "./page-meta/tier.ts";
import {
  deriveEpistemicStatus,
  EPISTEMIC_STATUS,
  type EpistemicStatus,
} from "./provenance/epistemic.ts";
import { estimateTokens } from "./text/tokenizer.ts";
import { densityScore } from "./context-density.ts";
import { normalizeForDedup } from "./text/normalize.ts";
import { applyCharBudget, type CharBudgetDegradationMode } from "./recall-budget.ts";
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
import { emitRecallTelemetry, type RecallTelemetryOptions } from "./recall-telemetry.ts";
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
import { scoreSessionFocusTarget, sessionFocusIsActive } from "../search/session-focus.ts";
import type { SearchSessionFocus } from "../search/types.ts";

const TIER_ORDER: ReadonlyArray<PageTier> = [
  PAGE_TIER.core,
  PAGE_TIER.supporting,
  PAGE_TIER.peripheral,
];

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
   * Value-per-token density score (impact-per-token allocation,
   * t_affa3bd9): structural signal per estimated token that broke this
   * item's within-tier tie. Present only when `densityRanking` is on;
   * absent otherwise so the default report stays byte-identical.
   */
  readonly density?: number;
  /** Present when the surfaced body was filtered or explicitly trusted. */
  readonly safety?: ContextSafetyReport;
}

export interface ContextPackSkipped {
  readonly id: string;
  readonly tokens: number;
  readonly reason: "over-budget" | "filter-miss" | "guard-blocked" | "over-char-budget";
}

export interface ContextPackReport {
  readonly maxTokens: number;
  readonly tokensUsed: number;
  readonly items: ReadonlyArray<ContextPackItem>;
  readonly skipped: ReadonlyArray<ContextPackSkipped>;
  readonly receiptId?: string;
  readonly telemetryId?: string;
  readonly lanes?: ContextLanesReport;
}

export interface ContextPackOptions {
  readonly maxTokens: number;
  /** Optional case-insensitive substring filter on topic + principle. */
  readonly query?: string;
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
   * Belief lifecycle suite (A4, t_d9365884): keep superseded ancestors in
   * the pack instead of collapsing each supersedes-chain to its live tip.
   * The explicit historical flag - history is opt-in, never inferred from
   * the query. Omitted/false injects only chain tips.
   */
  readonly includeHistorical?: boolean;
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
  readonly safety?: ContextSafetyReport;
  /**
   * Normalized `superseded_by` pointer when this memory has been
   * replaced (Belief lifecycle suite, A4). Drives inject tip-preference:
   * a superseded ancestor is dropped in favour of its live tip unless
   * the caller opts into `includeHistorical`.
   */
  readonly supersededBy: string | null;
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

function collectCandidates(vault: string, delimitUntrusted: boolean): Candidate[] {
  const dirs = brainDirs(vault);
  const out: Candidate[] = [];
  for (const dir of [dirs.preferences, dirs.retired]) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".md")) continue;
      const full = join(dir, name);
      let meta: Record<string, unknown>;
      let body: string;
      try {
        [meta, body] = parseFrontmatter(full);
      } catch {
        continue;
      }
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
        supersededBy,
        ...(contextSafetyReport(guarded) ? { safety: contextSafetyReport(guarded) } : {}),
      });
    }
  }
  return out;
}

export function packContext(vault: string, opts: ContextPackOptions): ContextPackReport {
  const startedAtMs = Date.now();
  if (!Number.isFinite(opts.maxTokens) || opts.maxTokens <= 0) {
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
  const query = opts.query ? normalizeForDedup(opts.query) : null;
  // Opt-in language-agnostic prompt-injection containment (Unit 1).
  // Default off, so the surfaced bodies are byte-identical to the legacy
  // blocklist guard unless the vault enables the flag.
  const delimitUntrusted = loadGuardrailsConfigSafe(vault).untrusted_source_delimiting;
  // Belief lifecycle suite (A4, t_d9365884): prefer supersedes-chain tips.
  // A superseded ancestor is dropped in favour of its live tip so a chain
  // of replacements injects only the current belief; `includeHistorical`
  // keeps the whole chain (explicit flag, never inferred). A vault with no
  // supersession chains passes through byte-identically.
  const candidates = preferChainTips(collectCandidates(vault, delimitUntrusted), {
    historical: opts.includeHistorical === true,
  }).kept;

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
    // Density breaks within-tier ties after focus, before recency. The
    // map is empty when the flag is off, so both sides read 0 and the
    // comparator falls straight through to recency → id.
    const densA = densityScoreById.get(a.id) ?? 0;
    const densB = densityScoreById.get(b.id) ?? 0;
    if (densA !== densB) return densB - densA;
    if (a.createdAtMs !== b.createdAtMs) return b.createdAtMs - a.createdAtMs;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

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
    items.push({
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
    });
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
        },
        startedAtMs,
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
    },
    startedAtMs,
  );
}

function finalizeContextPackReport(
  vault: string,
  opts: ContextPackOptions,
  report: ContextPackReport,
  startedAtMs: number,
): ContextPackReport {
  let enriched = report;
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
      extra: {
        skipped_count: report.skipped.length,
        lanes: opts.includeLanes === true,
      },
    }),
  );
  if (receipt) enriched = { ...enriched, receiptId: receipt.id };
  const telemetry = emitGatedTelemetry(opts.telemetry, (telemetryOptions) =>
    emitRecallTelemetry(vault, {
      createdAt: telemetryOptions.createdAt,
      host: telemetryOptions.host,
      sessionId: telemetryOptions.sessionId,
      turnId: telemetryOptions.turnId,
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
  };
}

function contextPackGaps(report: ContextPackReport): ReadonlyArray<string> {
  const gaps = new Set<string>();
  if (report.items.length === 0 && report.skipped.length === 0) gaps.add("no_matching_context");
  for (const skipped of report.skipped) gaps.add(skipped.reason.replace(/-/g, "_"));
  return [...gaps];
}
