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

import {
  existsSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join } from "node:path";

import { parseFrontmatter } from "../vault.ts";
import { brainDirs } from "./paths.ts";
import { PAGE_TIER, readTier, type PageTier } from "./page-meta/tier.ts";
import { estimateTokens } from "./text/tokenizer.ts";
import { normalizeForDedup } from "./text/normalize.ts";

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
}

export interface ContextPackSkipped {
  readonly id: string;
  readonly tokens: number;
  readonly reason: "over-budget" | "filter-miss";
}

export interface ContextPackReport {
  readonly maxTokens: number;
  readonly tokensUsed: number;
  readonly items: ReadonlyArray<ContextPackItem>;
  readonly skipped: ReadonlyArray<ContextPackSkipped>;
}

export interface ContextPackOptions {
  readonly maxTokens: number;
  /** Optional case-insensitive substring filter on topic + principle. */
  readonly query?: string;
}

interface Candidate {
  readonly id: string;
  readonly path: string;
  readonly tier: PageTier;
  readonly createdAtMs: number;
  readonly topic: string;
  readonly principle: string;
  readonly body: string;
  readonly tokens: number;
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
      // Token budget is computed against the body the pack actually
      // emits, not the full file - frontmatter tokens are never
      // returned to the caller, so charging them would under-fill
      // the context window.
      out.push({
        id,
        path: full,
        tier,
        createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : 0,
        topic,
        principle,
        body,
        tokens: estimateTokens(body),
      });
    }
  }
  return out;
}

export function packContext(
  vault: string,
  opts: ContextPackOptions,
): ContextPackReport {
  if (!Number.isFinite(opts.maxTokens) || opts.maxTokens <= 0) {
    return Object.freeze({
      maxTokens: 0,
      tokensUsed: 0,
      items: Object.freeze([]),
      skipped: Object.freeze([]),
    });
  }
  const query = opts.query
    ? normalizeForDedup(opts.query)
    : null;
  const candidates = collectCandidates(vault);

  candidates.sort((a, b) => {
    const tierA = TIER_ORDER.indexOf(a.tier);
    const tierB = TIER_ORDER.indexOf(b.tier);
    if (tierA !== tierB) return tierA - tierB;
    if (a.createdAtMs !== b.createdAtMs) return b.createdAtMs - a.createdAtMs;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const items: ContextPackItem[] = [];
  const skipped: ContextPackSkipped[] = [];
  let used = 0;
  for (const c of candidates) {
    if (query !== null) {
      const haystack = normalizeForDedup(`${c.topic} ${c.principle}`);
      if (!haystack.includes(query)) {
        skipped.push({ id: c.id, tokens: c.tokens, reason: "filter-miss" });
        continue;
      }
    }
    if (used + c.tokens > opts.maxTokens) {
      skipped.push({ id: c.id, tokens: c.tokens, reason: "over-budget" });
      continue;
    }
    items.push({
      id: c.id,
      path: c.path,
      tier: c.tier,
      tokens: c.tokens,
      body: c.body,
    });
    used += c.tokens;
  }

  return Object.freeze({
    maxTokens: opts.maxTokens,
    tokensUsed: used,
    items: Object.freeze(items),
    skipped: Object.freeze(skipped),
  });
}
