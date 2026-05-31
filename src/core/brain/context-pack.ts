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
import { join } from "node:path";

import { parseFrontmatter } from "../vault.ts";
import {
  contextSafetyReport,
  guardBrainContextSnippet,
  type ContextSafetyReport,
} from "./safety/context-guard.ts";
import { brainDirs } from "./paths.ts";
import { PAGE_TIER, readTier, type PageTier } from "./page-meta/tier.ts";
import { estimateTokens } from "./text/tokenizer.ts";
import { normalizeForDedup } from "./text/normalize.ts";
import { applyCharBudget } from "./recall-budget.ts";
import {
  buildContextLanes,
  normalizeContextLane,
  type ContextLaneName,
  type ContextLanesReport,
} from "./context-lanes.ts";

const TIER_ORDER: ReadonlyArray<PageTier> = [
  PAGE_TIER.core,
  PAGE_TIER.supporting,
  PAGE_TIER.peripheral,
];

export interface ContextPackItem {
  readonly id: string;
  readonly path: string;
  readonly tier: PageTier;
  readonly tokens: number;
  readonly body: string;
  readonly principle: string;
  readonly contextLane: ContextLaneName | null;
  /** True when `body` was truncated by `maxCharsPerMemory` (v0.20.0). */
  readonly trimmed: boolean;
  /** Present when the surfaced body was filtered or explicitly trusted. */
  readonly safety?: ContextSafetyReport;
}

export interface ContextPackSkipped {
  readonly id: string;
  readonly tokens: number;
  readonly reason: "over-budget" | "filter-miss" | "over-char-budget";
}

export interface ContextPackReport {
  readonly maxTokens: number;
  readonly tokensUsed: number;
  readonly items: ReadonlyArray<ContextPackItem>;
  readonly skipped: ReadonlyArray<ContextPackSkipped>;
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
  /** Opt-in polarity-aware lanes. Omitted preserves the legacy flat output shape. */
  readonly includeLanes?: boolean;
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
  readonly safety?: ContextSafetyReport;
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

function collectCandidates(vault: string): Candidate[] {
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
      const contextLane = normalizeContextLane(meta["context_lane"]);
      const guarded = guardBrainContextSnippet(body, {
        source: { id, path: full, metadata: meta },
        ...(meta["context_safety"] === "trusted-instruction"
          ? { trust: "trusted-instruction" as const }
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
        ...(contextSafetyReport(guarded) ? { safety: contextSafetyReport(guarded) } : {}),
      });
    }
  }
  return out;
}

export function packContext(vault: string, opts: ContextPackOptions): ContextPackReport {
  if (!Number.isFinite(opts.maxTokens) || opts.maxTokens <= 0) {
    return Object.freeze({
      maxTokens: 0,
      tokensUsed: 0,
      items: Object.freeze([]),
      skipped: Object.freeze([]),
      ...withOptionalLanes(opts, []),
    });
  }
  const query = opts.query ? normalizeForDedup(opts.query) : null;
  const candidates = collectCandidates(vault);

  candidates.sort((a, b) => {
    const tierA = TIER_ORDER.indexOf(a.tier);
    const tierB = TIER_ORDER.indexOf(b.tier);
    if (tierA !== tierB) return tierA - tierB;
    if (a.createdAtMs !== b.createdAtMs) return b.createdAtMs - a.createdAtMs;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  // Per-memory character cap (v0.20.0): trim oversized bodies in priority
  // order via the shared budget primitive before the token budget runs,
  // so one huge page cannot starve the rest. A trimmed body is re-tokenised
  // so the token budget charges the emitted text, not the original.
  const budgeted = applyCharBudget(
    candidates.map((c) => ({ item: c, text: c.body })),
    { maxCharsPerEntry: opts.maxCharsPerMemory },
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
      ...(c.safety ? { safety: c.safety } : {}),
    });
    used += tokens;
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
      const keptItems = capped.kept.map((k) => k.item);
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
      return Object.freeze({
        maxTokens: opts.maxTokens,
        tokensUsed: recomputed,
        items: Object.freeze(keptItems),
        skipped: Object.freeze(skipped),
        ...withOptionalLanes(opts, keptItems),
      });
    }
  }

  return Object.freeze({
    maxTokens: opts.maxTokens,
    tokensUsed: used,
    items: Object.freeze(items),
    skipped: Object.freeze(skipped),
    ...withOptionalLanes(opts, items),
  });
}
